import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Project, TaskSummary } from "../shared/protocol.ts";
import { listSessions } from "./session-files.ts";

const FILE = join(homedir(), ".pi-ui", "projects.json");

/** A task of an orchestrator. `additions` are the instructions that the orchestrator added after it queued the task. */
export type Task = Omit<TaskSummary, "activity"> & {
  prompt: string;
  additions: string[];
  /** When the last run of the task started. */
  started?: number;
  /** True when the user sent a message to the subagent after the last task update. */
  direct?: boolean;
};

/** The orchestrator session of a project, and its tasks in queue order. */
export type Orchestrator = { file: string; tasks: Task[] };

/** A project folder, the session files that the UI keeps for it, and the files with a run that ended unseen. */
type StoredProject = { path: string; sessions: string[]; unread: string[]; orchestrator?: Orchestrator };

let projects: StoredProject[] = load();

function load(): StoredProject[] {
  try {
    // A file from before the unread lists has none. Then no session is unread.
    const loaded: StoredProject[] = JSON.parse(readFileSync(FILE, "utf8")).projects.map((project: StoredProject) => ({
      ...project,
      unread: project.unread ?? [],
    }));
    // The Pi processes of the last server run have stopped. A task that was running then waits for review.
    for (const task of loaded.flatMap((project) => project.orchestrator?.tasks ?? [])) {
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
  projects = [...projects, { path, sessions: [], unread: [] }];
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

/** True when the UI keeps the session in `file`, as a session or as the orchestrator of a project. */
export function isKept(file: string): boolean {
  return projects.some((project) => project.sessions.includes(file) || project.orchestrator?.file === file);
}

/** The orchestrator of the project in `path`. The server changes its tasks in place, then calls `saveTasks`. */
export function getOrchestrator(path: string): Orchestrator | undefined {
  return projects.find((project) => project.path === path)?.orchestrator;
}

/** Make the session in `file` the orchestrator of the project in `path`. The project keeps its tasks. */
export function setOrchestrator(path: string, file: string): void {
  const project = projects.find((item) => item.path === path);
  if (!project) return;
  project.orchestrator = { file, tasks: project.orchestrator?.tasks ?? [] };
  save();
}

/** The project path of the orchestrator in `file`. */
export function orchestratorPath(file: string): string | undefined {
  return projects.find((project) => project.orchestrator?.file === file)?.path;
}

/** The project path and the task of the subagent session in `file`. */
export function findTask(file: string): { path: string; task: Task } | undefined {
  for (const { path, orchestrator } of projects) {
    const task = orchestrator?.tasks.find((item) => item.file === file);
    if (task) return { path, task };
  }
  return undefined;
}

/** The tasks of each orchestrator, by project path. */
export function allTasks(): [string, Task[]][] {
  return projects.flatMap(({ path, orchestrator }) => (orchestrator ? [[path, orchestrator.tasks] as [string, Task[]]] : []));
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
    projects.map(async ({ path, sessions, unread, orchestrator }) => ({
      path,
      sessions: (await listSessions(sessions)).map((info) => ({
        file: info.path,
        title: info.title,
        unread: unread.includes(info.path),
      })),
      orchestrator: orchestrator && { file: orchestrator.file, unread: unread.includes(orchestrator.file) },
    })),
  );
}
