import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Project } from "../shared/protocol.ts";

const FILE = join(homedir(), ".pi-ui", "projects.json");

/** A project folder and the session files that the UI keeps for it. */
type StoredProject = { path: string; sessions: string[] };

let projects: StoredProject[] = load();

function load(): StoredProject[] {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")).projects;
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
  projects = [...projects, { path, sessions: [] }];
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

export function removeSession(file: string): void {
  projects = projects.map((project) => ({ ...project, sessions: project.sessions.filter((item) => item !== file) }));
  save();
}

/** Projects with their kept sessions, newest session first. Pi supplies the session titles. */
export async function listProjects(): Promise<Project[]> {
  return Promise.all(
    projects.map(async ({ path, sessions }) => ({
      path,
      sessions: (await SessionManager.list(path))
        .filter((info) => sessions.includes(info.path))
        .map((info) => ({ file: info.path, title: info.name ?? info.firstMessage })),
    })),
  );
}
