import type { WebSocket } from "ws";
import type { ModelRef, ServerMessage, SessionInfo, TaskSummary } from "../shared/protocol.ts";
import type { PiProcess } from "./pi-process.ts";
import { allTasks, findTask, listProjects, type Task } from "./projects.ts";
import { clients, type Session, sessions, views } from "./state.ts";
import { activity, isActive } from "./tasks.ts";
import { readBranch } from "./worktrees.ts";

export function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

export function broadcast(message: ServerMessage): void {
  for (const client of clients) send(client, message);
}

/** Send `message` to the pages that show the session in `file`. */
export function sendToViewers(file: string, message: ServerMessage): void {
  for (const [socket, viewed] of views) if (viewed === file) send(socket, message);
}

/**
 * The folder where `session` works: the worktree of its task while the task is running or in review, else its project.
 * A task without a worktree works in its project.
 */
function sessionDir(session: Session): string {
  const task = findTask(session.file)?.task;
  return task?.worktree && isActive(task) ? task.worktree.dir : session.cwd;
}

/** Send the branch of `session` to the page of `socket`. */
export async function sendBranch(socket: WebSocket, session: Session): Promise<void> {
  send(socket, { type: "branch", file: session.file, branch: await readBranch(sessionDir(session)) });
}

/** Send the branch of each session that a page shows in the project `cwd` to that page. */
export async function sendProjectBranches(cwd: string): Promise<void> {
  const shown = [...views].flatMap(([socket, file]) => {
    const session = sessions.get(file);
    return session?.cwd === cwd ? [{ socket, session }] : [];
  });
  await Promise.all(shown.map(({ socket, session }) => sendBranch(socket, session)));
}

export function statusMessage(): ServerMessage {
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

export function tasksMessage(): ServerMessage {
  return { type: "tasks", tasks: Object.fromEntries(allTasks().map(([file, tasks]) => [file, tasks.map(taskSummary)])) };
}

let projectsCalls = 0;
let projectsSent = 0;

/** Send the project list to all pages. Overlapping calls never send an older list after a newer one. */
export async function broadcastProjects(): Promise<void> {
  const call = ++projectsCalls;
  const projects = await listProjects();
  if (call < projectsSent) return;
  projectsSent = call;
  broadcast({ type: "projects", projects });
}

function modelRef({ provider, id }: ModelRef): ModelRef {
  return { provider, id };
}

// The last model list that `readInfo` read.
let lastModels: ModelRef[] = [];

/** The last model list that the server read. Empty before the first session. */
export function knownModels(): ModelRef[] {
  return lastModels;
}

export async function readInfo(pi: PiProcess): Promise<SessionInfo> {
  const [state, models, levels, stats] = await Promise.all([
    pi.send({ type: "get_state" }),
    pi.send({ type: "get_available_models" }),
    pi.send({ type: "get_available_thinking_levels" }),
    pi.send({ type: "get_session_stats" }),
  ]);
  lastModels = models.data.models.map(modelRef);
  return {
    model: state.data.model && modelRef(state.data.model),
    models: [...lastModels],
    thinkingLevel: state.data.thinkingLevel,
    thinkingLevels: levels.data.levels,
    stats: stats.data,
  };
}

/** Read the info of `session` again, and send it to the pages that show the session. */
export async function refresh(session: Session): Promise<void> {
  session.info = await readInfo(session.pi);
  sendToViewers(session.file, { type: "info", file: session.file, info: session.info });
}

/** Read the usage stats of `session` again, and send them to the pages that show the session. */
export async function refreshStats(session: Session): Promise<void> {
  const stats = await session.pi.send({ type: "get_session_stats" });
  session.info = { ...session.info, stats: stats.data };
  sendToViewers(session.file, { type: "info", file: session.file, info: session.info });
}
