import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { applyEvent, type ChatState, emptyChatState } from "../shared/chat-state.ts";
import type { AgentMessage, SessionEntry } from "../shared/pi-rpc.ts";
import type { ClientMessage, FolderListing, ModelRef, ServerMessage, SessionInfo } from "../shared/protocol.ts";
import { PiProcess } from "./pi-process.ts";
import {
  addProject,
  isKept,
  keepSession,
  listProjects,
  markRead,
  markUnread,
  removeProject,
  removeSession,
} from "./projects.ts";
import { forkSession } from "./session-files.ts";

const HOST = "127.0.0.1";
const PORT = 3001;
// The tailnet URL of this Mac, from `.env`. Empty or absent, remote access is off.
const REMOTE_URL = process.env.PI_UI_REMOTE_URL || null;
// Only the Vite dev page, locally or at REMOTE_URL, may connect. Other websites open in the browser must not control Pi.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(REMOTE_URL ? [new URL(REMOTE_URL).origin] : []),
]);

// An idle session that no page shows stays warm this long, so it opens again at once. Then its Pi process stops.
const WARM_MS = 10 * 60 * 1000;
// A phone can lose its connection without a close. A page that does not answer a ping before the next one is gone: its
// socket closes, so its session no longer counts as shown.
const HEARTBEAT_MS = 30 * 1000;

type Session = { cwd: string; file: string; pi: PiProcess; state: ChatState; info: SessionInfo; timer?: NodeJS.Timeout };

// Sessions belong to the server, not to a page. Each live session has its own Pi process, so all of them can run at
// the same time. A session stops after it was idle for WARM_MS with no page that shows it. Its file keeps it for a
// later open.
const sessions = new Map<string, Session>();
// Opens in progress, by session file. A second open of the same file waits for the first one.
const opening = new Map<string, Promise<Session>>();
// Processes that stop now, by session file. A new open of the file waits until the old process has exited.
const stopping = new Map<string, Promise<void>>();
// The session file that each page shows.
const views = new Map<WebSocket, string>();
// A Pi process that waits for the next new session in `cwd`, so a new chat opens at once. The server keeps one spare,
// for the project of the chat that a page opened last.
let spare: { cwd: string; session: Promise<Session> } | undefined;
const clients = new Set<WebSocket>();

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  for (const client of clients) send(client, message);
}

/** Send `message` to the pages that show the session in `file`. */
function sendToViewers(file: string, message: ServerMessage): void {
  for (const [socket, viewed] of views) if (viewed === file) send(socket, message);
}

function statusMessage(): ServerMessage {
  return {
    type: "status",
    sessions: Object.fromEntries(
      [...sessions.values()].map((session) => [session.file, session.state.running ? "running" : "warm"] as const),
    ),
  };
}

async function broadcastProjects(): Promise<void> {
  broadcast({ type: "projects", projects: await listProjects() });
}

function modelRef({ provider, id }: ModelRef): ModelRef {
  return { provider, id };
}

async function readInfo(pi: PiProcess): Promise<SessionInfo> {
  const [state, models, levels, stats] = await Promise.all([
    pi.send({ type: "get_state" }),
    pi.send({ type: "get_available_models" }),
    pi.send({ type: "get_available_thinking_levels" }),
    pi.send({ type: "get_session_stats" }),
  ]);
  return {
    model: state.data.model && modelRef(state.data.model),
    models: models.data.models.map(modelRef),
    thinkingLevel: state.data.thinkingLevel,
    thinkingLevels: levels.data.levels,
    stats: stats.data,
  };
}

/** Read the info of `session` again, and send it to the pages that show the session. */
async function refresh(session: Session): Promise<void> {
  session.info = await readInfo(session.pi);
  sendToViewers(session.file, { type: "info", file: session.file, info: session.info });
}

/** Start a Pi process for the session in `file`, or for a new session in `cwd`. The session is not live yet. */
async function launch(cwd: string, file?: string): Promise<Session> {
  // Two Pi processes must not write to the same file.
  if (file) await stopping.get(file);
  let session: Session | undefined;
  const pi = new PiProcess(
    cwd,
    file ? ["--session", file] : [],
    (event) => {
      if (!session) return;
      session.state = applyEvent(session.state, event);
      sendToViewers(session.file, { type: "event", file: session.file, event });
      // Pi saves the session file when the first user message ends. From then on, the sidebar can list it.
      if (event.type === "message_end" && event.message.role === "user") {
        keepSession(session.cwd, session.file);
        void broadcastProjects();
      }
      // A refresh fails only when the Pi process stops. The exit handler reports that.
      if (event.type === "message_end" || event.type === "compaction_end") refresh(session).catch(() => {});
      if (event.type === "agent_start" || event.type === "agent_settled") broadcast(statusMessage());
      if (event.type === "agent_settled") {
        // A run that ends while no page shows its session stays unread in the sidebar until a page opens it.
        if (![...views.values()].includes(session.file)) {
          markUnread(session.cwd, session.file);
          void broadcastProjects();
        }
        release(session.file);
      }
    },
    (code) => {
      // A spare, or a session that the server stopped, is not in the map.
      if (!session || sessions.get(session.file) !== session) return;
      clearTimeout(session.timer);
      sessions.delete(session.file);
      broadcast(statusMessage());
      for (const [socket, viewed] of views) {
        if (viewed !== session.file) continue;
        views.delete(socket);
        send(socket, { type: "snapshot", session: null });
        send(socket, { type: "error", message: `Pi exited with code ${code}` });
      }
    },
  );
  const state = await pi.send({ type: "get_state" });
  // Unlike `get_messages`, the entries keep the messages before a compaction. The active branch goes from the leaf back
  // to the first entry.
  const { data } = await pi.send({ type: "get_entries" });
  const byId = new Map<string | null, SessionEntry>(data.entries.map((entry) => [entry.id, entry]));
  const messages: AgentMessage[] = [];
  for (let entry = byId.get(data.leafId); entry; entry = byId.get(entry.parentId)) {
    if (entry.type === "message") messages.push(entry.message!);
  }
  session = {
    cwd,
    file: state.data.sessionFile!,
    pi,
    state: { ...emptyChatState, messages: messages.reverse() },
    info: await readInfo(pi),
  };
  return session;
}

/** Make `session` live. */
function register(session: Session): Session {
  sessions.set(session.file, session);
  broadcast(statusMessage());
  return session;
}

/** Start a spare Pi process for `cwd`, unless one exists. A spare for another project stops. */
function prepareSpare(cwd: string): void {
  if (spare?.cwd === cwd) return;
  // A spare has no session file yet, so its stop needs no entry in `stopping`.
  void spare?.session.then((session) => session.pi.stop(), () => {});
  const session = launch(cwd);
  // A spare that fails to start reports the error to the chat that takes it.
  session.catch(() => {});
  spare = { cwd, session };
}

/** The live session in `file`, or a new Pi process for it. Without `file`, a new session in `cwd`. */
async function open(cwd: string, file?: string): Promise<Session> {
  if (!file) {
    const ready = spare?.cwd === cwd ? spare.session : undefined;
    if (ready) spare = undefined;
    const session = await ready;
    // A spare that has exited cannot run the session. Then a new process starts.
    return register(session && !session.pi.exited ? session : await launch(cwd));
  }
  const live = sessions.get(file) ?? opening.get(file);
  if (live) return live;
  const opened = launch(cwd, file).then(register).finally(() => opening.delete(file));
  opening.set(file, opened);
  return opened;
}

/** True while a run is in progress or a page shows the session. */
function inUse(session: Session): boolean {
  return session.state.running || [...views.values()].includes(session.file);
}

/** Start the WARM_MS count of `file` again. When it ends, the Pi process stops if the session is still idle. */
function release(file: string): void {
  const session = sessions.get(file);
  if (!session) return;
  clearTimeout(session.timer);
  if (inUse(session)) return;
  session.timer = setTimeout(() => {
    // A prompt that waits for its response has not started its run yet. Then the session stays warm longer.
    if (inUse(session) || session.pi.busy) return release(file);
    sessions.delete(file);
    stopping.set(file, session.pi.stop().finally(() => stopping.delete(file)));
    broadcast(statusMessage());
  }, WARM_MS);
}

/** Show a new session in `folder`, or the session in `file`, on the page of `socket`. */
async function start(socket: WebSocket, folder: string, file?: string): Promise<void> {
  // A saved session can be gone: removed, or a new session that stopped before Pi saved it. The page shows the start
  // screen. The check runs first, so a removed project is not added again.
  if (file && !sessions.has(file) && !opening.has(file) && !isKept(file)) {
    return send(socket, { type: "snapshot", session: null });
  }
  const cwd = resolve(folder);
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Folder not found: ${folder}`);
  // The sidebar changes only for a new project. Then it shows the project before the session opens.
  if (addProject(cwd)) await broadcastProjects();

  // A session that the sidebar lists can be removed while it opens.
  const listed = file !== undefined && isKept(file);
  if (!file || !sessions.has(file)) send(socket, { type: "starting" });
  const session = await open(cwd, file);
  // The page closed while the session opened.
  if (!clients.has(socket)) return release(session.file);
  const previous = views.get(socket);
  if (listed && !isKept(session.file)) {
    // The session was removed while it opened. The page goes back to the start screen.
    views.delete(socket);
    send(socket, { type: "snapshot", session: null });
    release(session.file);
  } else {
    // Set the view and send the snapshot in the same tick, so no event falls between them.
    views.set(socket, session.file);
    send(socket, {
      type: "snapshot",
      session: { cwd: session.cwd, file: session.file, state: session.state, info: session.info },
    });
    if (markRead(session.file)) void broadcastProjects();
  }
  if (previous) release(previous);
  prepareSpare(cwd);
}

/** Subfolders of `path`, or of the home folder when `path` is empty. Hidden folders are left out. */
async function listFolders(path: string): Promise<FolderListing> {
  const dir = path.trim() ? resolve(path.trim()) : homedir();
  // A path that the user is still typing usually does not exist. Show an empty list for it.
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return {
    path: dir,
    parent: dirname(dir),
    folders: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// The starts of a page run one at a time, in order. Quick clicks then end on the session that the user chose last.
const starting = new Map<WebSocket, Promise<void>>();

async function handle(socket: WebSocket, message: ClientMessage): Promise<void> {
  switch (message.type) {
    case "ping":
      return send(socket, { type: "pong" });
    case "list_folders":
      return send(socket, { type: "folders", listing: await listFolders(message.path) });
    case "start": {
      const run = (starting.get(socket) ?? Promise.resolve()).then(() => start(socket, message.cwd, message.file));
      starting.set(socket, run.catch(() => {}));
      return run;
    }
    case "remove_project":
      removeProject(message.path);
      return broadcastProjects();
    case "remove_session":
      removeSession(message.file);
      // The pages that show the session go back to the start screen.
      for (const [viewer, viewed] of views) {
        if (viewed !== message.file) continue;
        views.delete(viewer);
        send(viewer, { type: "snapshot", session: null });
      }
      release(message.file);
      return broadcastProjects();
  }
  const session = sessions.get(message.file);
  if (!session) throw new Error("Start a session first.");
  switch (message.type) {
    case "prompt":
      await session.pi.send({
        type: "prompt",
        message: message.text,
        images: message.images,
        streamingBehavior: message.streamingBehavior,
      });
      return;
    case "abort": {
      // As with Esc in the TUI, queued messages go back to the composer. Otherwise they run after the abort.
      const { data } = await session.pi.send({ type: "clear_queue" });
      const text = [...data.steering, ...data.followUp].join("\n\n");
      if (text) send(socket, { type: "restore", text });
      await session.pi.send({ type: "abort" });
      return;
    }
    case "set_model":
      await session.pi.send({ type: "set_model", provider: message.provider, modelId: message.modelId });
      return refresh(session);
    case "set_thinking_level":
      await session.pi.send({ type: "set_thinking_level", level: message.level });
      return refresh(session);
    case "fork": {
      const file = await forkSession(session.file, message.timestamp);
      if (file) keepSession(session.cwd, file);
      // The fork opens in its own Pi process, after the other starts of the page. The original session does not change.
      return handle(socket, { type: "start", cwd: session.cwd, file });
    }
  }
}

const server = new WebSocketServer({
  host: HOST,
  port: PORT,
  path: "/ws",
  verifyClient: ({ origin }: { origin: string }) => ALLOWED_ORIGINS.has(origin),
});

server.on("listening", () => console.log(`Pi UI server on ws://${HOST}:${PORT}/ws`));

// The pages that answered the last ping.
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const client of clients) {
    if (alive.delete(client)) client.ping();
    else client.terminate();
  }
}, HEARTBEAT_MS);

server.on("connection", (socket) => {
  clients.add(socket);
  alive.add(socket);
  socket.on("pong", () => alive.add(socket));
  send(socket, { type: "remote", url: REMOTE_URL });
  send(socket, statusMessage());
  void listProjects().then((projects) => send(socket, { type: "projects", projects }));

  socket.on("message", (data) => {
    handle(socket, JSON.parse(String(data)) as ClientMessage).catch((error: unknown) =>
      send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  });

  socket.on("close", () => {
    clients.delete(socket);
    starting.delete(socket);
    const file = views.get(socket);
    views.delete(socket);
    if (file) release(file);
  });
});
