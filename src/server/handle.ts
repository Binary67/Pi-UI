import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { ClientMessage } from "../shared/protocol.ts";
import { listFolders, toPath } from "./folders.ts";
import { broadcast, broadcastProjects, refresh, send, sendBranch, sendProjectBranches, tasksMessage } from "./messages.ts";
import {
  addOrchestrator,
  addProject,
  findOrchestrator,
  findTask,
  getOrchestrators,
  isKept,
  keepSession,
  markRead,
  removeOrchestrator,
  removeProject,
  removeSession,
  saveTasks,
} from "./projects.ts";
import { forkSession } from "./session-files.ts";
import {
  closeTask,
  dropSpare,
  held,
  inFlight,
  launch,
  open,
  opening,
  ORCHESTRATOR_ARGS,
  prepareSpare,
  register,
  release,
  stopSession,
  WORKTREES_DIR,
} from "./sessions.ts";
import { clients, sessions, views } from "./state.ts";
import { isActive } from "./tasks.ts";
import { transcribe } from "./transcribe.ts";
import { readUsage } from "./usage.ts";
import { switchBranch } from "./worktrees.ts";

// The session files of Pi, which the usage dashboard reads.
const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

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
  // The updates for a removed orchestrator have no reader.
  held.get(orchestrator.file)?.clear();
  held.delete(orchestrator.file);
  inFlight.delete(orchestrator.file);
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
  await rm(join(WORKTREES_DIR, orchestrator.id), { recursive: true, force: true }).catch((error: unknown) =>
    console.error("Could not delete the worktree folder of the orchestrator:", error),
  );
}

// The starts of a page run one at a time, in order. Quick clicks then end on the session that the user chose last.
export const starting = new Map<WebSocket, Promise<void>>();

export async function handle(socket: WebSocket, message: ClientMessage): Promise<void> {
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
      dropSpare(message.path);
      return broadcastProjects();
    case "remove_session":
      // An orchestrator goes with its tasks.
      if (findOrchestrator(message.file)) return dropOrchestrator(message.file);
      const removed = findTask(message.file)?.task;
      if (removed && isActive(removed)) throw new Error("Finish or cancel the task first.");
      // A running session would come back in the sidebar with its next message.
      if (sessions.get(message.file)?.state.running) throw new Error("This session is running. Stop it or wait until it ends.");
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
  // A done or cancelled task has no worktree any more. Its subagent would change the project folder directly.
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
      if (task) throw new Error("A task session cannot switch the branch.");
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
      if (findOrchestrator(session.file) || findTask(session.file)) {
        throw new Error("An orchestrator or a task session cannot be forked.");
      }
      const file = await forkSession(session.file, message.timestamp);
      if (file) keepSession(session.cwd, file);
      // The fork opens in its own Pi process, after the other starts of the page. The original session does not change.
      return handle(socket, { type: "start", cwd: session.cwd, file });
    }
  }
}
