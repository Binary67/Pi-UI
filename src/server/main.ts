import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type WebSocket, WebSocketServer } from "ws";
import { applyEvent, type ChatState, emptyChatState } from "../shared/chat-state.ts";
import type { AgentMessage, JsonAgentSessionEvent, SessionEntry } from "../shared/pi-rpc.ts";
import type {
  ClientMessage,
  FolderListing,
  ModelRef,
  ServerMessage,
  SessionInfo,
  StreamingBehavior,
  TaskSummary,
} from "../shared/protocol.ts";
import { PiProcess } from "./pi-process.ts";
import {
  addOrchestrator,
  addProject,
  allTasks,
  findOrchestrator,
  findTask,
  getOrchestrators,
  isKept,
  keepSession,
  listProjects,
  markRead,
  markUnread,
  type Orchestrator,
  projectPaths,
  removeOrchestrator,
  removeProject,
  removeSession,
  saveTasks,
  type Task,
} from "./projects.ts";
import { forkSession, moveSession } from "./session-files.ts";
import {
  activity,
  type Changes,
  describeTask,
  isActive,
  outside,
  overlap,
  taskLine,
  taskPrompt,
  updateText,
} from "./tasks.ts";
import { readUsage } from "./usage.ts";
import {
  addWorktree,
  changedFiles,
  checkRepo,
  commitAll,
  diffSince,
  isMerged,
  readBranch,
  removeLeftovers,
  removeWorktree,
  runSetup,
  switchBranch,
} from "./worktrees.ts";

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
// The Azure OpenAI deployment for voice input, from `.env`: its full Target URI and its API key. Only the server uses
// the key, so remote devices never see it.
const TRANSCRIBE_URL = process.env.PI_UI_TRANSCRIBE_URL;
const TRANSCRIBE_KEY = process.env.PI_UI_TRANSCRIBE_KEY;

// An idle session that no page shows stays warm this long, so it opens again at once. Then its Pi process stops.
const WARM_MS = 10 * 60 * 1000;
// A phone can lose its connection without a close. A page that does not answer a ping before the next one is gone: its
// socket closes, so its session no longer counts as shown.
const HEARTBEAT_MS = 30 * 1000;

// The Pi extension with the task tools, and the instructions of the orchestrator and its subagents.
const ORCHESTRATOR_DIR = fileURLToPath(new URL("../orchestrator/", import.meta.url));
// The orchestrator plans, reviews, and merges, and the subagents edit. So the orchestrator has no edit tools. It uses
// bash for git and checks.
const ORCHESTRATOR_ARGS = [
  "-e",
  join(ORCHESTRATOR_DIR, "extension.ts"),
  "--append-system-prompt",
  join(ORCHESTRATOR_DIR, "orchestrator.md"),
  "--tools",
  "read,grep,find,ls,bash,start_tasks,list_tasks,get_task,message_task,finish_task,cancel_task",
];
const SUBAGENT_ARGS = ["--append-system-prompt", join(ORCHESTRATOR_DIR, "subagent.md")];
// The model of new subagent sessions from `.env`, as a Pi `--model` pattern. Empty or absent, Pi uses its default.
const SUBAGENT_MODEL = process.env.PI_UI_SUBAGENT_MODEL || null;
// The worktrees of the tasks, in a folder for each orchestrator: `<orchestrator id>/task-<task id>`.
const WORKTREES_DIR = join(homedir(), ".pi-ui", "worktrees");
// The session files of Pi, which the usage dashboard reads.
const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

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

/** The folder where `session` works: the worktree of its task while the task is running or in review, else its project. */
function sessionDir(session: Session): string {
  const task = findTask(session.file)?.task;
  return task && isActive(task) ? task.worktree : session.cwd;
}

/** Send the branch of `session` to the page of `socket`. */
async function sendBranch(socket: WebSocket, session: Session): Promise<void> {
  send(socket, { type: "branch", file: session.file, branch: await readBranch(sessionDir(session)) });
}

/** Send the branch of each session that a page shows in the project `cwd` to that page. */
async function sendProjectBranches(cwd: string): Promise<void> {
  const shown = [...views].flatMap(([socket, file]) => {
    const session = sessions.get(file);
    return session?.cwd === cwd ? [{ socket, session }] : [];
  });
  await Promise.all(shown.map(({ socket, session }) => sendBranch(socket, session)));
}

function statusMessage(): ServerMessage {
  return {
    type: "status",
    sessions: Object.fromEntries(
      [...sessions.values()].map((session) => [session.file, session.state.running ? "running" : "warm"] as const),
    ),
  };
}

function taskSummary({ id, title, status, file, note, setup }: Task): TaskSummary {
  const state = status === "running" && file ? sessions.get(file)?.state : undefined;
  // A running task without a session runs its setup command.
  const now = status === "running" && !file ? setup && `setup: ${setup}` : state && activity(state);
  return { id, title, status, file, note, activity: now || undefined };
}

function tasksMessage(): ServerMessage {
  return { type: "tasks", tasks: Object.fromEntries(allTasks().map(([file, tasks]) => [file, tasks.map(taskSummary)])) };
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

/** Read the usage stats of `session` again, and send them to the pages that show the session. */
async function refreshStats(session: Session): Promise<void> {
  const stats = await session.pi.send({ type: "get_session_stats" });
  session.info = { ...session.info, stats: stats.data };
  sendToViewers(session.file, { type: "info", file: session.file, info: session.info });
}

/**
 * Start a Pi process for the session in `file`, or for a new session in `cwd`, with the extra Pi options `args`. The
 * session is not live yet. A new session works in the folder `dir`, such as the worktree of a task. A saved session
 * works in the folder in its file.
 */
async function launch(cwd: string, file?: string, args: string[] = [], dir = cwd): Promise<Session> {
  // Two Pi processes must not write to the same file.
  if (file) await stopping.get(file);
  let session: Session | undefined;
  const pi = new PiProcess(
    dir,
    [...(file ? ["--session", file] : []), ...args],
    (event) => {
      if (!session) return;
      const previous = session.state;
      session.state = applyEvent(previous, event);
      // The page needs only the events that change the chat.
      if (session.state !== previous) sendToViewers(session.file, { type: "event", file: session.file, event });
      // Pi saves the session file when the first user message ends. From then on, the sidebar can list it. An
      // orchestrator has its own row in the sidebar, and its title comes from the first message.
      if (event.type === "message_end" && event.message.role === "user") {
        if (!findOrchestrator(session.file)) keepSession(session.cwd, session.file);
        void broadcastProjects();
      }
      // Only an assistant message or a compaction changes the usage stats. A refresh fails only when the Pi process
      // stops. The exit handler reports that.
      if ((event.type === "message_end" && event.message.role === "assistant") || event.type === "compaction_end") {
        refreshStats(session).catch(() => {});
      }
      if (event.type === "agent_start" || event.type === "agent_settled") broadcast(statusMessage());
      if (event.type === "agent_start" || event.type === "agent_settled" || event.type === "tool_execution_start") {
        followTask(session, event);
      }
      if (event.type === "agent_settled") {
        // A run that ends while no page shows its session stays unread in the sidebar until a page opens it.
        if (![...views.values()].includes(session.file)) {
          markUnread(session.cwd, session.file);
          void broadcastProjects();
        }
        release(session.file);
        // The agent can change the branch with bash.
        sendProjectBranches(session.cwd).catch((error: unknown) => console.error("Could not read the branch:", error));
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
      const found = findTask(session.file);
      if (found?.task.status === "running") {
        toReview(found.path, found.task, `Pi exited with code ${code}.`, session.state);
        broadcast(tasksMessage());
      }
    },
    (name, params) => runTool(session!.file, name, params),
  );
  try {
    const state = await pi.send({ type: "get_state" });
    // Unlike `get_messages`, the entries keep the messages before a compaction. The active branch goes from the leaf back
    // to the first entry.
    const { data } = await pi.send({ type: "get_entries" });
    const byId = new Map<string | null, SessionEntry>(data.entries.map((entry) => [entry.id, entry]));
    const messages: AgentMessage[] = [];
    for (let entry = byId.get(data.leafId); entry; entry = byId.get(entry.parentId)) {
      if (entry.type === "message") messages.push(entry.message!);
      // A message from an extension, such as a task update for the orchestrator.
      if (entry.type === "custom_message") {
        const { customType, content, display, details, timestamp } = entry;
        messages.push({
          role: "custom",
          customType: customType!,
          content: content!,
          display: display!,
          details,
          timestamp: Date.parse(timestamp),
        });
      }
    }
    session = {
      cwd,
      file: state.data.sessionFile!,
      pi,
      state: { ...emptyChatState, messages: messages.reverse() },
      info: await readInfo(pi),
    };
  } catch (error) {
    // The Pi process stays alive after a failed command. A new open of the file waits for its stop.
    if (file) stopping.set(file, pi.stop().finally(() => stopping.delete(file)));
    else void pi.stop();
    throw error;
  }
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
  // The orchestrator and the subagents need their extra Pi options each time they open.
  const args = findOrchestrator(file) ? ORCHESTRATOR_ARGS : findTask(file) ? SUBAGENT_ARGS : [];
  const opened = launch(cwd, file, args).then(register).finally(() => opening.delete(file));
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
  const cwd = toPath(folder);
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
    sendBranch(socket, session).catch((error: unknown) => console.error("Could not read the branch:", error));
  }
  if (previous) release(previous);
  prepareSpare(cwd);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Show the empty orchestrator of the project in `folder` on the page of `socket`, or a new one when it has none.
 * Each orchestrator solves one problem.
 */
async function startOrchestrator(socket: WebSocket, folder: string): Promise<void> {
  const cwd = toPath(folder);
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Folder not found: ${folder}`);
  if (addProject(cwd)) await broadcastProjects();
  // An empty orchestrator opens again, so the sidebar gets no second empty row.
  // Pi saves its file only after the first message.
  const empty = getOrchestrators(cwd).find(
    (item) => item.tasks.length === 0 && !existsSync(item.file) && !sessions.get(item.file)?.state.running,
  );
  if (empty) return start(socket, cwd, empty.file);
  send(socket, { type: "starting" });
  const { file } = register(await launch(cwd, undefined, ORCHESTRATOR_ARGS));
  addOrchestrator(cwd, file);
  await broadcastProjects();
  return start(socket, cwd, file);
}

/**
 * Remove the orchestrator in `file` from the sidebar, with the sessions of its tasks. Its active tasks are cancelled:
 * their subagents stop, and their worktrees and branches are deleted. The session files stay.
 */
async function dropOrchestrator(file: string): Promise<void> {
  // From now on, no task tool, task update, or prompt reaches the orchestrator or its tasks.
  const removed = removeOrchestrator(file);
  if (!removed) return;
  const { path, orchestrator } = removed;
  const files = [orchestrator.file, ...orchestrator.tasks.flatMap((task) => task.file ?? [])];
  for (const [socket, viewed] of views) {
    if (!files.includes(viewed)) continue;
    views.delete(socket);
    release(viewed);
    send(socket, { type: "snapshot", session: null });
  }
  broadcast(tasksMessage());
  await broadcastProjects();
  const active = orchestrator.tasks.filter(isActive);
  for (const task of active) task.status = "cancelled";
  // The project folder can be gone. Then the cleanup of a task fails, but the orchestrator still goes.
  const results = await Promise.allSettled([stopSession(orchestrator.file), ...active.map((task) => closeTask(path, task))]);
  for (const result of results) {
    if (result.status === "rejected") console.error("Could not clean up the orchestrator:", result.reason);
  }
  await rm(join(WORKTREES_DIR, orchestrator.id), { recursive: true, force: true });
}

/** Stop the Pi process of the session in `file`. A run stops first. Resolves when the process has exited. */
async function stopSession(file: string): Promise<void> {
  const session = sessions.get(file) ?? (await opening.get(file)?.catch(() => undefined));
  if (session && sessions.get(file) === session) {
    // Out of the map, the session does not report its exit to the pages.
    clearTimeout(session.timer);
    sessions.delete(file);
    broadcast(statusMessage());
    if (session.state.running) {
      await session.pi.send({ type: "clear_queue" });
      await session.pi.send({ type: "abort" });
    }
    stopping.set(file, session.pi.stop().finally(() => stopping.delete(file)));
  }
  await stopping.get(file);
}

/** Follow a subagent run: the status of its task, its activity on the task board, and the update for the orchestrator. */
function followTask(session: Session, event: JsonAgentSessionEvent): void {
  const found = findTask(session.file);
  if (!found) return;
  const { path, task } = found;
  // A task in review runs again when the user sends a message to its subagent directly.
  if (event.type === "agent_start" && task.status === "review") {
    Object.assign(task, { status: "running", started: Date.now(), note: undefined });
    saveTasks();
  }
  if (event.type === "agent_settled" && task.status === "running") {
    const last = session.state.messages.findLast((message) => message.role === "assistant");
    const failed = last?.role === "assistant" && last.stopReason === "error";
    const note = event.aborted ? "Stopped by the user." : failed ? `The run failed: ${last.errorMessage}` : undefined;
    toReview(path, task, note, session.state);
  }
  broadcast(tasksMessage());
}

/** Move a running task to review. Then commit its changes, and send the task update to the orchestrator. */
function toReview(path: string, task: Task, note: string | undefined, state?: ChatState): void {
  Object.assign(task, { status: "review", note });
  // The update describes the task as it is now, also when the task changes during the commit.
  const update = { ...task };
  task.direct = false;
  saveTasks();
  report(path, task, update, state).catch((error: unknown) =>
    console.error(`Could not send the update of task ${task.id}:`, error),
  );
}

/** Commit the changes of `task`, so that its branch is complete for the review and the merge. Then send `update`. */
async function report(path: string, task: Task, update: Task, state?: ChatState): Promise<void> {
  await commitAll(task.worktree, task.title).catch((error: unknown) => {
    update.note = [update.note, `The server could not commit the changes: ${errorText(error)}`].filter(Boolean).join(" ");
  });
  await notify(path, task, update, updateText(update, await taskChanges(task), state));
}

/** The git changes of `task` in its worktree. */
async function taskChanges(task: Task): Promise<Changes> {
  const [files, diff] = await Promise.all([changedFiles(task.worktree, task.base), diffSince(task.worktree, task.base)]);
  return { files, outside: outside(task, files), diff };
}

/** Send the task update `text` to the orchestrator of `task`. The update starts a turn of the orchestrator. */
async function notify(path: string, task: Task, update: Task, text: string): Promise<void> {
  // The project or the orchestrator of the task can be gone.
  const orchestrator = getOrchestrators(path).find((item) => item.tasks.includes(task));
  if (!orchestrator) return;
  const session = await open(path, orchestrator.file);
  const details = { id: update.id, title: update.title, status: update.status, note: update.note };
  // Pi runs an extension command at once, also during a run. The extension delivers the update when the run ends.
  await session.pi.send({
    type: "prompt",
    message: `/pi-ui-task ${JSON.stringify({ text, details })}`,
    streamingBehavior: "followUp",
  });
  release(session.file);
}

// The starts of tasks in progress: the setup, and the start of the subagent.
const launches = new Map<Task, Promise<void>>();
// Each start in progress can be aborted. This stops the setup command.
const aborts = new Map<Task, AbortController>();

/** Start `task` in the background. */
function startTask(path: string, task: Task): void {
  const abort = new AbortController();
  aborts.set(task, abort);
  launches.set(
    task,
    launchTask(path, task, abort.signal).finally(() => {
      launches.delete(task);
      aborts.delete(task);
    }),
  );
}

/** Run the setup command of `task` in its worktree. Then start a new subagent session there, with the task prompt. */
async function launchTask(path: string, task: Task, signal: AbortSignal): Promise<void> {
  Object.assign(task, { status: "running", started: Date.now(), note: undefined });
  saveTasks();
  broadcast(tasksMessage());
  try {
    if (task.setup) await runSetup(task.worktree, task.setup, signal);
    // The task can be cancelled during its setup.
    if (task.status !== "running") return;
    // A session records its model, so only a new subagent session gets `--model`.
    const model = SUBAGENT_MODEL ? ["--model", SUBAGENT_MODEL] : [];
    const session = register(
      await launch(path, undefined, [...SUBAGENT_ARGS, ...model, "--name", task.title], task.worktree),
    );
    task.file = session.file;
    saveTasks();
    // The task can be cancelled while Pi starts. Then `closeTask` stops the session.
    if (task.status !== "running") return;
    await session.pi.send({ type: "prompt", message: taskPrompt(task) });
  } catch (error) {
    // When the Pi process exited, its exit handler already moved the task to review.
    if (task.status === "running") toReview(path, task, `The task could not start: ${errorText(error)}`);
  }
  broadcast(tasksMessage());
}

/** Stop the subagent of `task`, then delete its worktree and branch. The session moves to the project folder. */
async function closeTask(path: string, task: Task): Promise<void> {
  // The worktree stays until the setup and the subagent have ended. A running setup command stops now.
  aborts.get(task)?.abort();
  await launches.get(task);
  if (task.file) await stopSession(task.file);
  await removeWorktree(path, task.worktree, task.branch);
  if (task.file) await moveSession(task.file, path);
}

/** Run `closeTask`. When it fails, the task goes back to review, so that `cancel_task` can try the cleanup again. */
async function closeOrBack(path: string, task: Task): Promise<void> {
  try {
    await closeTask(path, task);
  } catch (error) {
    Object.assign(task, { status: "review", note: `The cleanup failed: ${errorText(error)}. Run cancel_task to try again.` });
    throw error;
  }
}

type TaskSpec = Pick<Task, "title" | "goal" | "files" | "inputs" | "outputs" | "criteria">;
/** The parameters of the task tools. Pi checks them against the schemas of the extension, so each tool gets its own. */
type ToolParams = {
  contract: string;
  setup?: string;
  tasks: TaskSpec[];
  id: number;
  text: string;
  mode: StreamingBehavior;
};

/** Run the task tool `name` for the orchestrator in `file`. Returns the text for the model. */
async function runTool(file: string, name: string, params: unknown): Promise<string> {
  const found = findOrchestrator(file);
  if (!found) throw new Error("Only an orchestrator can use the task tools.");
  try {
    return await taskTool(found.path, found.orchestrator, name, params as ToolParams);
  } finally {
    saveTasks();
    broadcast(tasksMessage());
  }
}

async function taskTool(path: string, orchestrator: Orchestrator, name: string, params: ToolParams): Promise<string> {
  const { tasks } = orchestrator;
  if (name === "start_tasks") {
    await checkRepo(path);
    const conflict = overlap([...tasks.filter(isActive), ...params.tasks]);
    if (conflict) throw new Error(`The owned files overlap: ${conflict}. A file can belong to only one active task.`);
    // Phase 1 makes all worktrees. When one fails, none of the tasks starts.
    const first = Math.max(0, ...tasks.map((task) => task.id)) + 1;
    const made: Task[] = [];
    const undo = () => Promise.all(made.map((task) => removeWorktree(path, task.worktree, task.branch).catch(() => {})));
    for (const [index, spec] of params.tasks.entries()) {
      const id = first + index;
      const worktree = join(WORKTREES_DIR, orchestrator.id, `task-${id}`);
      const branch = `pi-ui/${orchestrator.id}/task-${id}`;
      try {
        const base = await addWorktree(path, worktree, branch);
        const { contract, setup } = params;
        made.push({ ...spec, id, status: "running", contract, setup, additions: [], worktree, branch, base });
      } catch (error) {
        await undo();
        throw new Error(`The task "${spec.title}" could not start: ${errorText(error)}`);
      }
    }
    // The orchestrator can be removed while the worktrees are made. Then nobody owns them.
    if (findOrchestrator(orchestrator.file)?.orchestrator !== orchestrator) {
      await undo();
      throw new Error("The orchestrator was removed.");
    }
    // Phase 2 starts the tasks.
    tasks.push(...made);
    for (const task of made) startTask(path, task);
    return `Started: ${made.map((task) => `${task.id}. ${task.title}`).join(", ")}. An update arrives when the run of each task ends.`;
  }
  if (name === "list_tasks") {
    const lines = tasks.map((task) => {
      const session = task.file ? sessions.get(task.file) : undefined;
      return taskLine(task, session?.state, session?.info.stats.cost);
    });
    return lines.join("\n") || "No tasks.";
  }
  const task = tasks.find((item) => item.id === params.id);
  if (!task) throw new Error(`Task ${params.id} does not exist.`);
  switch (name) {
    case "get_task": {
      const changes = isActive(task) ? await taskChanges(task) : undefined;
      if (!task.file) return describeTask(task, undefined, undefined, changes);
      // A session that is not live opens, so that the view has its messages.
      const session = await open(path, task.file);
      release(session.file);
      return describeTask(task, session.state, session.info.stats.cost, changes);
    }
    case "message_task": {
      if (!isActive(task)) throw new Error(`Task ${task.id} is ${task.status}. Propose a new task instead.`);
      task.additions.push(params.text);
      // A task without a session runs its setup now, or could not start.
      if (!task.file) {
        if (task.status === "running") return `Added to the prompt of task ${task.id}. Its subagent gets it after the setup.`;
        startTask(path, task);
        return `Task ${task.id} starts again, with the added instructions.`;
      }
      const session = await open(path, task.file);
      await session.pi.send({ type: "prompt", message: params.text, streamingBehavior: params.mode });
      return `Sent to task ${task.id}.`;
    }
    case "finish_task": {
      if (task.status !== "review") throw new Error(`Task ${task.id} is ${task.status}. Only a task in review can finish.`);
      // Changes after the last commit, such as from a server restart, need a review and a merge too.
      if (await commitAll(task.worktree, task.title)) {
        throw new Error(`Task ${task.id} had uncommitted changes. They are now on ${task.branch}. Review and merge them first.`);
      }
      if (!(await isMerged(path, task.branch))) {
        throw new Error(`${task.branch} is not merged. Merge it into the current branch of the project first.`);
      }
      Object.assign(task, { status: "done", note: undefined });
      await closeOrBack(path, task);
      return `Task ${task.id} is done. Its worktree and branch are deleted.`;
    }
    case "cancel_task": {
      if (!isActive(task)) throw new Error(`Task ${task.id} is already ${task.status}.`);
      task.status = "cancelled";
      await closeOrBack(path, task);
      return `Task ${task.id} is cancelled. Its worktree and branch are deleted.`;
    }
  }
  throw new Error(`Unknown task tool: ${name}`);
}

/** A typed path as a full path. `~` and relative paths start at the home folder, and an empty path is the home folder. */
function toPath(input: string): string {
  return resolve(homedir(), input.trim().replace(/^~(?=$|\/)/, homedir()));
}

/** Subfolders of `path`, or of the home folder when `path` is empty. Hidden folders are left out. */
async function listFolders(path: string): Promise<FolderListing> {
  const dir = toPath(path);
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

/** The text of a voice recording: base64 `audio` of the type `mimeType`. The Azure deployment makes the transcript. */
async function transcribe(audio: string, mimeType: string): Promise<string> {
  if (!TRANSCRIBE_URL || !TRANSCRIBE_KEY) {
    throw new Error("For voice input, set PI_UI_TRANSCRIBE_URL and PI_UI_TRANSCRIBE_KEY in .env and restart the servers.");
  }
  // Azure checks that the extension of the file name matches the type: `audio/webm;codecs=opus` is `audio.webm`.
  const type = mimeType.split(";")[0];
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(audio, "base64")], { type }), `audio.${type.split("/")[1]}`);
  // Voice input is English only.
  form.append("language", "en");
  const response = await fetch(TRANSCRIBE_URL, { method: "POST", headers: { "api-key": TRANSCRIBE_KEY }, body: form });
  if (!response.ok) throw new Error(`Transcription failed with status ${response.status}: ${await response.text()}`);
  const { text } = (await response.json()) as { text: string };
  return text;
}

// The starts of a page run one at a time, in order. Quick clicks then end on the session that the user chose last.
const starting = new Map<WebSocket, Promise<void>>();

async function handle(socket: WebSocket, message: ClientMessage): Promise<void> {
  switch (message.type) {
    case "ping":
      return send(socket, { type: "pong" });
    case "list_folders":
      return send(socket, { type: "folders", listing: await listFolders(message.path) });
    case "transcribe":
      return send(socket, { type: "transcript", text: await transcribe(message.audio, message.mimeType) });
    case "get_usage":
      return send(socket, { type: "usage", days: await readUsage(SESSIONS_DIR, new Date()) });
    case "start":
    case "orchestrator": {
      const run = (starting.get(socket) ?? Promise.resolve()).then(() =>
        message.type === "start" ? start(socket, message.cwd, message.file) : startOrchestrator(socket, message.cwd),
      );
      starting.set(socket, run.catch(() => {}));
      return run;
    }
    case "remove_project":
      await Promise.all(getOrchestrators(message.path).map((orchestrator) => dropOrchestrator(orchestrator.file)));
      removeProject(message.path);
      return broadcastProjects();
    case "remove_session":
      // An orchestrator goes with its tasks.
      if (findOrchestrator(message.file)) return dropOrchestrator(message.file);
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
  const task = findTask(message.file)?.task;
  // A done or cancelled task has no worktree. Its subagent would change the project folder directly.
  if (message.type === "prompt" && task && !isActive(task)) {
    throw new Error(`This task is ${task.status}. Ask the orchestrator for a new task.`);
  }
  const session = sessions.get(message.file);
  if (!session) throw new Error("Start a session first.");
  switch (message.type) {
    case "prompt": {
      // The next task update tells the orchestrator that the user talked to the subagent directly.
      if (task) {
        task.direct = true;
        saveTasks();
      }
      await session.pi.send({
        type: "prompt",
        message: message.text,
        images: message.images,
        streamingBehavior: message.streamingBehavior,
      });
      return;
    }
    case "abort": {
      // As with Esc in the TUI, queued messages go back to the composer. Otherwise they run after the abort.
      const { data } = await session.pi.send({ type: "clear_queue" });
      const text = [...data.steering, ...data.followUp].join("\n\n");
      if (text) send(socket, { type: "restore", text });
      await session.pi.send({ type: "abort" });
      return;
    }
    case "list_branches":
      return sendBranch(socket, session);
    case "switch_branch": {
      if (task) throw new Error("A task session stays on its task branch.");
      if ([...sessions.values()].some((other) => other.cwd === session.cwd && other.state.running)) {
        throw new Error("A session of this project is running. Wait until it ends.");
      }
      if (getOrchestrators(session.cwd).some((orchestrator) => orchestrator.tasks.some(isActive))) {
        throw new Error("An orchestrator of this project has tasks that are running or in review. Finish or cancel them first.");
      }
      // The startup sweep deletes the `pi-ui/*` branches that no task owns.
      if (message.branch.startsWith("-") || message.branch.startsWith("pi-ui/")) {
        throw new Error("A branch name cannot start with - or pi-ui/.");
      }
      await switchBranch(session.cwd, message.branch, message.create);
      return sendProjectBranches(session.cwd);
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

// Delete the worktrees and branches that no active task owns. No task can start during the sweep.
await removeLeftovers(
  WORKTREES_DIR,
  projectPaths(),
  allTasks().flatMap(([, tasks]) => tasks.filter(isActive)),
);

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
  send(socket, tasksMessage());
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
