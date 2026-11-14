import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Project, TaskSummary } from "../shared/protocol.ts";
import { listSessions } from "./session-files.ts";

const FILE = join(homedir(), ".pi-ui", "projects.json");

/**
 * A task of an orchestrator: its contract, and the git worktree where its subagent works. `additions` are the
 * instructions that the orchestrator sent to the subagent.
 */
export type Task = Omit<TaskSummary, "activity"> & {
  goal: string;
  /** The owned files: the only files that the subagent may change. A path that ends with `/` covers its folder. */
  files: string[];
  inputs: string;
  outputs: string;
  criteria: string;
  /** The shared contract of the tasks that started together. */
  contract: string;
  /** The shell command that prepares the worktree before the subagent starts. */
  setup?: string;
  additions: string[];
  /** The worktree folder and its branch. Both exist while the task is running or in review. */
  worktree: string;
  branch: string;
  /** The commit that the branch starts from. */
  base: string;
  /** When the last run of the task started. */
  started?: number;
  /** True when the user sent a message to the subagent after the last task update. */
  direct?: boolean;
};

/** An orchestrator session, and its tasks in start order. `id` names its worktrees and branches. */
export type Orchestrator = { id: string; file: string; tasks: Task[] };

/**
 * A project folder, the session files that the UI keeps for it, its orchestrators in start order, and the files with a
 * run that ended unseen. Each orchestrator solves one problem.
 */
type StoredProject = { path: string; sessions: string[]; unread: string[]; orchestrators: Orchestrator[] };

let projects: StoredProject[] = load();

function load(): StoredProject[] {
  try {
    // A file from before the unread lists has none. Then no session is unread.
    const loaded: StoredProject[] = JSON.parse(readFileSync(FILE, "utf8")).projects.map((project: StoredProject) => ({
      ...project,
      unread: project.unread ?? [],
    }));
    // The Pi processes of the last server run have stopped. A task that was running then waits for review.
    for (const task of loaded.flatMap((project) => project.orchestrators.flatMap((item) => item.tasks))) {
      if (task.status === "running") Object.assign(task, { status: "review", note: "Interrupted by a server restart." });
    }
    return loaded;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Synchronous writes, so two quick changes cannot interleave in the file.
function save(): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify({ projects }, null, 2)}\n`);
}

/** Add the project folder `path`. Returns true when it was not a project yet. */
export function addProject(path: string): boolean {
  if (projects.some((project) => project.path === path)) return false;
  projects = [...projects, { path, sessions: [], unread: [], orchestrators: [] }];
  save();
  return true;
}

export function removeProject(path: string): void {
  projects = projects.filter((project) => project.path !== path);
  save();
}

export function keepSession(path: string, file: string): void {
  const project = projects.find((item) => item.path === path);
  if (!project || project.sessions.includes(file)) return;
  project.sessions.push(file);
  save();
}

/** True when the UI keeps the session in `file`, as a session or as an orchestrator of a project. */
export function isKept(file: string): boolean {
  return projects.some(
    (project) => project.sessions.includes(file) || project.orchestrators.some((item) => item.file === file),
  );
}

/** The orchestrators of the project in `path`. */
export function getOrchestrators(path: string): Orchestrator[] {
  return projects.find((project) => project.path === path)?.orchestrators ?? [];
}

/** The orchestrator in `file`, and its project path. The server changes its tasks in place, then calls `saveTasks`. */
export function findOrchestrator(file: string): { path: string; orchestrator: Orchestrator } | undefined {
  for (const { path, orchestrators } of projects) {
    const orchestrator = orchestrators.find((item) => item.file === file);
    if (orchestrator) return { path, orchestrator };
  }
  return undefined;
}

/** Add the new session in `file` as an orchestrator of the project in `path`. */
export function addOrchestrator(path: string, file: string): void {
  const project = projects.find((item) => item.path === path);
  if (!project) return;
  project.orchestrators.push({ id: randomUUID().slice(0, 8), file, tasks: [] });
  save();
}

/** Remove the orchestrator in `file`, with the sessions of its tasks. Returns it, with its project path. */
export function removeOrchestrator(file: string): { path: string; orchestrator: Orchestrator } | undefined {
  const found = findOrchestrator(file);
  const project = found && projects.find((item) => item.path === found.path);
  if (!found || !project) return undefined;
  const { orchestrator } = found;
  const files = new Set([orchestrator.file, ...orchestrator.tasks.flatMap((task) => task.file ?? [])]);
  Object.assign(project, {
    orchestrators: project.orchestrators.filter((item) => item !== orchestrator),
    sessions: project.sessions.filter((item) => !files.has(item)),
    unread: project.unread.filter((item) => !files.has(item)),
  });
  save();
  return found;
}

/** The project path and the task of the subagent session in `file`. */
export function findTask(file: string): { path: string; task: Task } | undefined {
  for (const { path, orchestrators } of projects) {
    const task = orchestrators.flatMap((orchestrator) => orchestrator.tasks).find((item) => item.file === file);
    if (task) return { path, task };
  }
  return undefined;
}

/** The tasks of each orchestrator, by its session file. */
export function allTasks(): [string, Task[]][] {
  return projects.flatMap(({ orchestrators }) =>
    orchestrators.map(({ file, tasks }): [string, Task[]] => [file, tasks]),
  );
}

/** Save the tasks after the server changed them. */
export function saveTasks(): void {
  save();
}

export function removeSession(file: string): void {
  projects = projects.map((project) => ({
    ...project,
    sessions: project.sessions.filter((item) => item !== file),
    unread: project.unread.filter((item) => item !== file),
  }));
  save();
}

/** Mark the session in `file` as unread: its run ended while no page showed it. */
export function markUnread(path: string, file: string): void {
  const project = projects.find((item) => item.path === path);
  if (!project || project.unread.includes(file)) return;
  project.unread.push(file);
  save();
}

/** Mark the session in `file` as read. Returns true when it was unread. */
export function markRead(file: string): boolean {
  if (!projects.some((project) => project.unread.includes(file))) return false;
  projects = projects.map((project) => ({ ...project, unread: project.unread.filter((item) => item !== file) }));
  save();
  return true;
}

/** Projects with their kept sessions, newest session first. Titles come from Pi's session files. */
export async function listProjects(): Promise<Project[]> {
  return Promise.all(
    projects.map(async ({ path, sessions, unread, orchestrators }) => {
      const listed = await listSessions(orchestrators.map(({ file }) => file));
      const titles = new Map(listed.map((info) => [info.path, info.title]));
      return {
        path,
        sessions: (await listSessions(sessions)).map((info) => ({
          file: info.path,
          title: info.title,
          unread: unread.includes(info.path),
        })),
        // Newest first. Pi saves the session file of an orchestrator only after its first message.
        orchestrators: orchestrators.toReversed().map(({ file }) => ({
          file,
          title: titles.get(file) ?? "New orchestrator",
          unread: unread.includes(file),
        })),
      };
    }),
  );
}
