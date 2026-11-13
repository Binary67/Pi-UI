import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { applyEvent, type ChatState, emptyChatState } from "../shared/chat-state.ts";
import type { ClientMessage, FolderListing, ServerMessage } from "../shared/protocol.ts";
import { PiProcess } from "./pi-process.ts";
import { addProject, keepSession, listProjects, removeProject, removeSession } from "./projects.ts";

const HOST = "127.0.0.1";
const PORT = 3001;
// Only the Vite dev page may connect. Other websites open in the browser must not control Pi.
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

type Session = { cwd: string; file: string; pi: PiProcess; state: ChatState };

// The session belongs to the server, not to a page. It continues when pages reload or disconnect.
let session: Session | undefined;
const clients = new Set<WebSocket>();

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  for (const client of clients) send(client, message);
}

function snapshot(): ServerMessage {
  return {
    type: "snapshot",
    session: session ? { cwd: session.cwd, file: session.file, state: session.state } : null,
  };
}

async function broadcastProjects(): Promise<void> {
  broadcast({ type: "projects", projects: await listProjects() });
}

/** Start a new session in `folder`, or open the session in `file`. */
async function start(folder: string, file?: string): Promise<void> {
  const cwd = resolve(folder);
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Folder not found: ${folder}`);
  addProject(cwd);
  await broadcastProjects();

  const pi = new PiProcess(
    cwd,
    file ? ["--session", file] : [],
    (event) => {
      if (session?.pi !== pi) return;
      session.state = applyEvent(session.state, event);
      broadcast({ type: "event", event });
      // Pi saves the session file when the first user message ends. From then on, the sidebar can list it.
      if (event.type === "message_end" && event.message.role === "user") {
        keepSession(session.cwd, session.file);
        void broadcastProjects();
      }
    },
    (code) => {
      if (session?.pi !== pi) return;
      session = undefined;
      broadcast(snapshot());
      broadcast({ type: "error", message: `Pi exited with code ${code}` });
    },
  );
  const state = await pi.send({ type: "get_state" });
  const history = await pi.send({ type: "get_messages" });
  // Stop the previous session only now, so it keeps working until the new one is ready.
  session?.pi.stop();
  session = {
    cwd,
    file: state.data.sessionFile!,
    pi,
    state: { ...emptyChatState, messages: history.data.messages },
  };
  broadcast(snapshot());
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

async function handle(socket: WebSocket, message: ClientMessage): Promise<void> {
  switch (message.type) {
    case "list_folders":
      return send(socket, { type: "folders", listing: await listFolders(message.path) });
    case "start":
      return start(message.cwd, message.file);
    case "remove_project":
      removeProject(message.path);
      return broadcastProjects();
    case "remove_session":
      removeSession(message.file);
      return broadcastProjects();
  }
  if (!session) throw new Error("Start a session first.");
  if (message.type === "prompt") await session.pi.send({ type: "prompt", message: message.text });
  else await session.pi.send({ type: "abort" });
}

const server = new WebSocketServer({
  host: HOST,
  port: PORT,
  path: "/ws",
  verifyClient: ({ origin }: { origin: string }) => ALLOWED_ORIGINS.has(origin),
});

server.on("listening", () => console.log(`Pi UI server on ws://${HOST}:${PORT}/ws`));

server.on("connection", (socket) => {
  // Send the snapshot in the same tick as the join, so no event falls between them.
  clients.add(socket);
  send(socket, snapshot());
  void listProjects().then((projects) => send(socket, { type: "projects", projects }));

  socket.on("message", (data) => {
    handle(socket, JSON.parse(String(data)) as ClientMessage).catch((error: unknown) =>
      send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  });

  socket.on("close", () => clients.delete(socket));
});
