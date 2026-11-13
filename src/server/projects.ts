import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Project } from "../shared/protocol.ts";
import { listSessions } from "./session-files.ts";

const FILE = join(homedir(), ".pi-ui", "projects.json");

/** A project folder, the session files that the UI keeps for it, and the files with a run that ended unseen. */
type StoredProject = { path: string; sessions: string[]; unread: string[] };

let projects: StoredProject[] = load();

function load(): StoredProject[] {
  try {
    // A file from before the unread lists has none. Then no session is unread.
    return JSON.parse(readFileSync(FILE, "utf8")).projects.map((project: StoredProject) => ({
      ...project,
      unread: project.unread ?? [],
    }));
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

export function addProject(path: string): void {
  if (projects.some((project) => project.path === path)) return;
  projects = [...projects, { path, sessions: [], unread: [] }];
  save();
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

/** True when the UI keeps the session in `file`. */
export function isKept(file: string): boolean {
  return projects.some((project) => project.sessions.includes(file));
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
    projects.map(async ({ path, sessions, unread }) => ({
      path,
      sessions: (await listSessions(sessions)).map((info) => ({
        file: info.path,
        title: info.title,
        unread: unread.includes(info.path),
      })),
    })),
  );
}
