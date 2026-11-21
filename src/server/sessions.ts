import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvent, type ChatState, emptyChatState } from "../shared/chat-state.ts";
import type { AgentMessage, JsonAgentSessionEvent, SessionEntry } from "../shared/pi-rpc.ts";
import type { StreamingBehavior } from "../shared/protocol.ts";
import {
  broadcast,
  broadcastProjects,
  readInfo,
  refreshStats,
  send,
  sendProjectBranches,
  sendToViewers,
  statusMessage,
  tasksMessage,
} from "./messages.ts";
import { PiProcess } from "./pi-process.ts";
import {
  findOrchestrator,
  findTask,
  getOrchestrators,
  keepSession,
  markUnread,
  type Orchestrator,
  saveTasks,
  type Task,
} from "./projects.ts";
import { moveSession } from "./session-files.ts";
import { type Session, sessions, views } from "./state.ts";
import {
  type Changes,
  describeTask,
  isActive,
  outside,
  overlap,
  runningText,
  taskLine,
  taskPrompt,
  updateText,
} from "./tasks.ts";
import {
  addWorktree,
  changedFiles,
  checkRepo,
  commitAll,
  diffSince,
  isMerged,
  readBranch,
  removeWorktree,
  runSetup,
} from "./worktrees.ts";

// An idle session that no page shows stays warm this long, so it opens again at once. Then its Pi process stops.
const WARM_MS = 10 * 60 * 1000;
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
export const WORKTREES_DIR = join(homedir(), ".pi-ui", "worktrees");

// Opens in progress, by session file. A second open of the same file waits for the first one.
export const opening = new Map<string, Promise<Session>>();
// Processes that stop now, by session file. A new open of the file waits until the old process has exited.
const stopping = new Map<string, Promise<void>>();
// A Pi process that waits for the next new session in `cwd`, so a new chat or orchestrator opens at once. The server
// keeps one spare of each kind, for the project of the chat that a page opened last. The kind sets the Pi options.
const spares: Partial<Record<"chat" | "orchestrator", { cwd: string; session: Promise<Session> }>> = {};
const SPARE_ARGS = { chat: [], orchestrator: ORCHESTRATOR_ARGS };
// The task updates that wait for an orchestrator, by its session file. Each task has at most one, in arrival order.
export const held = new Map<string, Map<Task, { path: string; update: Task; text: string }>>();
// The orchestrators that got an update and have not settled since. `state.running` becomes true only at `agent_start`,
// so without this set, a second update could go to Pi before the run of the first one starts.
export const inFlight = new Set<string>();

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
        // A session that the server stopped, such as a removed orchestrator, stays out of the sidebar.
        if (sessions.get(session.file) === session && ![...views.values()].includes(session.file)) {
          markUnread(session.cwd, session.file);
          void broadcastProjects();
        }
        release(session.file);
        // The run of an update has ended, so the orchestrator is idle and can get the next update.
        inFlight.delete(session.file);
        deliver(session.file).catch((error: unknown) => console.error("Could not send a task update:", error));
        // The agent can change the branch with bash.
        sendProjectBranches(session.cwd).catch((error: unknown) => console.error("Could not read the branch:", error));
      }
    },
    (code) => {
      // An update that was in flight can no longer settle.
      if (session) inFlight.delete(session.file);
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
export function register(session: Session): Session {
  sessions.set(session.file, session);
  broadcast(statusMessage());
  return session;
}

/** Start a spare Pi process of each kind for `cwd`, unless one exists. A spare for another project stops. */
export function prepareSpares(cwd: string): void {
  for (const kind of ["chat", "orchestrator"] as const) {
    if (spares[kind]?.cwd === cwd) continue;
    // A spare has no session file yet, so its stop needs no entry in `stopping`.
    void spares[kind]?.session.then((session) => session.pi.stop(), () => {});
    const session = launch(cwd, undefined, SPARE_ARGS[kind]);
    // A spare that fails to start reports the error to the page that takes it.
    session.catch(() => {});
    spares[kind] = { cwd, session };
  }
}

/** Stop the spare Pi processes of the project `cwd`, if the server keeps any for it. */
export function dropSpare(cwd: string): void {
  for (const kind of ["chat", "orchestrator"] as const) {
    const old = spares[kind];
    if (old?.cwd !== cwd) continue;
    delete spares[kind];
    void old.session.then((session) => session.pi.stop(), () => {});
  }
}

/** Take the spare of `kind` for `cwd`, or start a new Pi process of that kind. The session is not live yet. */
export async function takeSpare(kind: "chat" | "orchestrator", cwd: string): Promise<Session> {
  const ready = spares[kind]?.cwd === cwd ? spares[kind].session : undefined;
  if (ready) delete spares[kind];
  const session = await ready;
  // A spare that has exited cannot run the session. Then a new process starts.
  return session && !session.pi.exited ? session : await launch(cwd, undefined, SPARE_ARGS[kind]);
}

/** The live session in `file`, or a new Pi process for it. Without `file`, a new session in `cwd`. */
export async function open(cwd: string, file?: string): Promise<Session> {
  if (!file) {
    return register(await takeSpare("chat", cwd));
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
export function release(file: string): void {
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stop the Pi process of the session in `file`. A run stops first. Resolves when the process has exited. */
export async function stopSession(file: string): Promise<void> {
  const session = sessions.get(file) ?? (await opening.get(file)?.catch(() => undefined));
  if (session && sessions.get(file) === session) {
    // Out of the map, the session does not report its exit to the pages.
    clearTimeout(session.timer);
    sessions.delete(file);
    broadcast(statusMessage());
    if (session.state.running) {
      // A Pi process that has died rejects both commands. The process stops next anyway.
      await session.pi.send({ type: "clear_queue" }).catch(() => {});
      await session.pi.send({ type: "abort" }).catch(() => {});
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

/** Move a running task to review. Then commit its changes if it has a worktree, and send the task update to the orchestrator. */
function toReview(path: string, task: Task, note: string | undefined, state?: ChatState): void {
  Object.assign(task, { status: "review", note });
  // The update describes the task as it is now, also when the task changes during the commit.
  const update = { ...task };
  task.direct = false;
  task.pending = true;
  saveTasks();
  report(path, task, update, state).catch((error: unknown) =>
    console.error(`Could not send the update of task ${task.id}:`, error),
  );
}

/** Commit the changes of `task`, so that its branch is complete for the review and the merge. Then send `update`. */
export async function report(path: string, task: Task, update: Task, state?: ChatState): Promise<void> {
  if (task.worktree) {
    const { worktree } = task;
    await checkBranch(worktree)
      .then(() => commitAll(worktree.dir, task.title))
      .catch((error: unknown) => {
        update.note = [update.note, `The server could not commit the changes: ${errorText(error)}`].filter(Boolean).join(" ");
      });
  }
  // A git failure must not lose the update.
  const changes = await taskChanges(task).catch((error: unknown) => {
    update.note = [update.note, `The server could not read the changes: ${errorText(error)}`].filter(Boolean).join(" ");
    return undefined;
  });
  await notify(path, task, update, updateText(update, changes, state));
}

/** Throws unless the worktree `dir` is on its task branch `branch`. A commit on another branch would not reach the task branch. */
async function checkBranch({ dir, branch }: { dir: string; branch: string }): Promise<void> {
  const current = (await readBranch(dir))?.current;
  if (current === branch) return;
  throw new Error(
    current
      ? `The worktree is on ${current}, not on ${branch}. Tell the subagent to switch back to ${branch} and to bring its work there.`
      : `The worktree is not in a git repository. Tell the subagent to restore it on ${branch} and to bring its work there.`,
  );
}

/** The git changes of `task` in its worktree. Undefined when the task has no worktree. */
async function taskChanges(task: Task): Promise<Changes | undefined> {
  if (!task.worktree) return undefined;
  const { dir, base } = task.worktree;
  const [files, diff] = await Promise.all([changedFiles(dir, base), diffSince(dir, base)]);
  return { files, outside: task.files.length ? outside(task, files) : [], diff };
}

/** Hold the task update `text` for the orchestrator of `task`. It goes out when the orchestrator is idle. */
async function notify(path: string, task: Task, update: Task, text: string): Promise<void> {
  // The project or the orchestrator of the task can be gone.
  const orchestrator = getOrchestrators(path).find((item) => item.tasks.includes(task));
  if (!orchestrator) return;
  // Pi keeps a follow-up in its own queue, and the server cannot remove it from there. So the server holds the update
  // until the orchestrator is idle. A newer update of the same task replaces the old one.
  const queue = held.get(orchestrator.file) ?? new Map();
  held.set(orchestrator.file, queue);
  queue.delete(task);
  queue.set(task, { path, update, text });
  await deliver(orchestrator.file);
}

/** Send the next held update to the orchestrator in `file`, if it is idle. The update starts a turn of the orchestrator. */
async function deliver(file: string): Promise<void> {
  const queue = held.get(file);
  if (!queue || inFlight.has(file) || sessions.get(file)?.state.running) return;
  for (const [task, entry] of queue) {
    const { path, update, text } = entry;
    // An update that is out of date must not open the session of the orchestrator.
    if (task.status !== "review") {
      queue.delete(task);
      continue;
    }
    // No await comes before this line, so a second call cannot send at the same time.
    inFlight.add(file);
    try {
      const session = await open(path, file);
      try {
        // The task can be cancelled or run again while the session opens.
        if (task.status === "review") {
          const details = { id: update.id, title: update.title, status: update.status, note: update.note };
          // The list of the other running tasks is built now, because the update can be held for a long time.
          const others = findOrchestrator(file)?.orchestrator.tasks.filter((item) => item !== task && item.status === "running");
          const full = [text, runningText(others ?? [])].filter(Boolean).join("\n\n");
          await session.pi.send({
            type: "prompt",
            message: `/pi-ui-task ${JSON.stringify({ text: full, details })}`,
            streamingBehavior: "followUp",
          });
          // The entry stays in the queue until the send worked. A newer update of the task can replace it meanwhile.
          if (queue.get(task) === entry) {
            queue.delete(task);
            task.pending = false;
            saveTasks();
          }
          return;
        }
        if (queue.get(task) === entry) queue.delete(task);
      } finally {
        // The session is idle again, so its warm timer starts again.
        release(session.file);
      }
    } catch (error) {
      // A failed send must not block the next updates.
      inFlight.delete(file);
      throw error;
    }
  }
  inFlight.delete(file);
}

// The starts of tasks in progress: the setup, and the start of the subagent.
const launches = new Map<Task, Promise<void>>();
// Each start in progress can be aborted. This stops the setup command.
export const aborts = new Map<Task, AbortController>();

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

/**
 * Run the setup command of `task` in its worktree. Then start a new subagent session in the worktree, or in the project
 * folder when the task has no worktree, with the task prompt.
 */
async function launchTask(path: string, task: Task, signal: AbortSignal): Promise<void> {
  Object.assign(task, { status: "running", started: Date.now(), note: undefined });
  saveTasks();
  broadcast(tasksMessage());
  try {
    if (task.worktree && task.setup) await runSetup(task.worktree.dir, task.setup, signal);
    // The task can be cancelled during its setup.
    if (task.status !== "running") return;
    // A session records its model, so only a new subagent session gets `--model`.
    const model = SUBAGENT_MODEL ? ["--model", SUBAGENT_MODEL] : [];
    const session = register(
      await launch(path, undefined, [...SUBAGENT_ARGS, ...model, "--name", task.title], task.worktree?.dir),
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

/** Stop the subagent of `task`. Then delete its worktree and branch, if it has them. The session moves to the project folder. */
export async function closeTask(path: string, task: Task): Promise<void> {
  // The worktree stays until the setup and the subagent have ended. A running setup command stops now.
  aborts.get(task)?.abort();
  await launches.get(task);
  if (task.file) await stopSession(task.file);
  if (task.worktree) {
    await removeWorktree(path, task.worktree.dir, task.worktree.branch);
    if (task.file) await moveSession(task.file, path);
  }
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

type TaskSpec = Pick<Task, "title" | "prompt"> & { worktree: boolean; files?: string[] };
/** The parameters of the task tools. Pi checks them against the schemas of the extension, so each tool gets its own. */
type ToolCall =
  | { name: "start_tasks"; params: { contract?: string; setup?: string; tasks: TaskSpec[] } }
  | { name: "list_tasks"; params: Record<string, never> }
  | { name: "get_task" | "finish_task" | "cancel_task"; params: { id: number } }
  | { name: "message_task"; params: { id: number; text: string; mode: StreamingBehavior } };

/** Run the task tool `name` for the orchestrator in `file`. Returns the text for the model. */
async function runTool(file: string, name: string, params: unknown): Promise<string> {
  const found = findOrchestrator(file);
  if (!found) throw new Error("Only an orchestrator can use the task tools.");
  try {
    return await taskTool(found.path, found.orchestrator, { name, params } as ToolCall);
  } finally {
    saveTasks();
    broadcast(tasksMessage());
  }
}

async function taskTool(path: string, orchestrator: Orchestrator, { name, params }: ToolCall): Promise<string> {
  const { tasks } = orchestrator;
  if (name === "start_tasks") {
    if (params.tasks.some((spec) => spec.worktree)) await checkRepo(path);
    const conflict = overlap([...tasks.filter(isActive), ...params.tasks.map(({ title, files = [] }) => ({ title, files }))]);
    if (conflict) throw new Error(`The owned files overlap: ${conflict}. A file can belong to only one active task.`);
    // Phase 1 makes all worktrees. When one fails, none of the tasks starts.
    const first = Math.max(0, ...tasks.map((task) => task.id)) + 1;
    const made: Task[] = [];
    const undo = () =>
      Promise.all(made.flatMap(({ worktree }) => (worktree ? [removeWorktree(path, worktree.dir, worktree.branch).catch(() => {})] : [])));
    for (const [index, spec] of params.tasks.entries()) {
      const id = first + index;
      const { title, prompt, files = [] } = spec;
      const { contract } = params;
      const task: Task = { id, title, status: "running", prompt, files, additions: [] };
      if (contract) task.contract = contract;
      try {
        if (spec.worktree) {
          const dir = join(WORKTREES_DIR, orchestrator.id, `task-${id}`);
          const branch = `pi-ui/${orchestrator.id}/task-${id}`;
          task.worktree = { dir, branch, base: await addWorktree(path, dir, branch) };
          task.setup = params.setup;
        }
        made.push(task);
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
  if (name !== "get_task" && name !== "message_task" && name !== "finish_task" && name !== "cancel_task") {
    throw new Error(`Unknown task tool: ${name}`);
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
      // A task without a session runs its setup now (if it has a worktree), or could not start.
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
      if (task.worktree) {
        const { dir, branch } = task.worktree;
        await checkBranch(task.worktree);
        // Changes after the last commit, such as from a server restart, need a review and a merge too.
        if (await commitAll(dir, task.title)) {
          throw new Error(`Task ${task.id} had uncommitted changes. They are now on ${branch}. Review and merge them first.`);
        }
        if (!(await isMerged(path, branch))) {
          throw new Error(`${branch} is not merged. Merge it into the current branch of the project first.`);
        }
      }
      Object.assign(task, { status: "done", note: undefined });
      await closeOrBack(path, task);
      return task.worktree ? `Task ${task.id} is done. Its worktree and branch are deleted.` : `Task ${task.id} is done.`;
    }
    case "cancel_task": {
      if (!isActive(task)) throw new Error(`Task ${task.id} is already ${task.status}.`);
      task.status = "cancelled";
      await closeOrBack(path, task);
      return task.worktree ? `Task ${task.id} is cancelled. Its worktree and branch are deleted.` : `Task ${task.id} is cancelled.`;
    }
  }
}
