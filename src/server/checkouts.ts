import { realpath } from "node:fs/promises";
import { activeProjectTasks, findTask, projectPaths } from "./projects.ts";
import { type Session, sessions } from "./state.ts";
import { allocatingTasks, isActive } from "./tasks.ts";
import { worktreeRoot } from "./worktrees.ts";

const roots = new Map<string, string>();
// Sessions are removed from the live map before their asynchronous abort and shutdown finish.
export const stoppingDirs = new Map<Session, string>();
export const switching = new Set<string>();
export const SWITCH_IN_PROGRESS = "A branch switch is in progress. Wait until it ends.";

export async function identifyCheckout(dir: string): Promise<void> {
  const root = await worktreeRoot(dir);
  roots.set(dir, root ?? await realpath(dir).catch(() => dir));
}

/** Refresh live folders and active tasks' worktrees and merge destinations, including repos initialized since opening. */
export async function refreshCheckouts(): Promise<void> {
  const dirs = new Set([...stoppingDirs.values(), ...[...sessions.values()].map(sessionDir)]);
  for (const path of projectPaths()) {
    const active = activeProjectTasks(path);
    if (active.length || allocatingTasks(path)) dirs.add(path);
    for (const task of active) if (task.worktree) dirs.add(task.worktree.dir);
  }
  await Promise.all([...dirs].map(identifyCheckout));
}

export function checkout(dir: string): string {
  return roots.get(dir) ?? dir;
}

export function sessionDir(session: Session): string {
  const task = findTask(session.file)?.task;
  return task?.worktree && isActive(task) ? task.worktree.dir : session.cwd;
}

/** Reasons a branch cannot change, by physical checkout. Active tasks also reserve their merge destination. */
export function blockedCheckouts(): Map<string, string> {
  const blocked = new Map<string, string>();
  const activeTasks = "An orchestrator has tasks in this checkout that are running or in review. Finish or cancel them first.";
  for (const path of projectPaths()) {
    if (allocatingTasks(path)) blocked.set(checkout(path), activeTasks);
    for (const task of activeProjectTasks(path)) {
      blocked.set(checkout(path), activeTasks);
      if (task.worktree) blocked.set(checkout(task.worktree.dir), activeTasks);
    }
  }
  for (const session of sessions.values()) {
    if (session.state.running || session.pendingPrompts || session.awaitingRun) {
      blocked.set(checkout(sessionDir(session)), "A session in this checkout is running. Wait until it ends.");
    }
  }
  for (const dir of stoppingDirs.values()) blocked.set(checkout(dir), "A session in this checkout is stopping.");
  for (const root of switching) blocked.set(root, SWITCH_IN_PROGRESS);
  return blocked;
}
