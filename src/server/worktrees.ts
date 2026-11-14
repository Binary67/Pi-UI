import { execFile, spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type { BranchInfo } from "../shared/protocol.ts";

const exec = promisify(execFile);
// Diffs can be long.
const MAX_BUFFER = 64 * 1024 * 1024;
// The error of a failed setup command keeps only the end of its output.
const OUTPUT_LIMIT = 2000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/**
 * Throws unless `path` is the top folder of a git repository with a commit and without uncommitted changes. Subagents
 * start from the last commit, so they would not see uncommitted changes.
 */
export async function checkRepo(path: string): Promise<void> {
  const prefix = await git(path, ["rev-parse", "--show-prefix"]).catch(() => {
    throw new Error("The project is not a git repository. Run git init and make a first commit.");
  });
  if (prefix.trim()) throw new Error("Open the top folder of the git repository as the project.");
  await git(path, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new Error("The repository has no commit. Make a first commit.");
  });
  if ((await git(path, ["status", "--porcelain"])).trim()) {
    throw new Error("The project has uncommitted changes. Commit them first, because subagents start from the last commit.");
  }
}

/** Make the worktree `dir` on the new branch `branch`, from the last commit of the repository in `path`. Returns the commit. */
export async function addWorktree(path: string, dir: string, branch: string): Promise<string> {
  const base = (await git(path, ["rev-parse", "HEAD"])).trim();
  await git(path, ["worktree", "add", "-b", branch, dir, base]);
  return base;
}

/** The branch state of the git repository that contains `dir`. Null when `dir` is not in a git repository. */
export async function readBranch(dir: string): Promise<BranchInfo | null> {
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
  if (inside.trim() !== "true") return null;
  // A repository without a commit has an unborn branch. A detached HEAD has no branch name.
  const name = (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
  const current = name || (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
  const listed = await git(dir, ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"]);
  const branches = listed.split("\n").filter((branch) => branch && !branch.startsWith("pi-ui/")).sort();
  return { current, detached: !name, branches };
}

/** Switch the repository in `dir` to `branch`. With `create`, make the branch from the current commit first. */
export async function switchBranch(dir: string, branch: string, create: boolean): Promise<void> {
  try {
    await git(dir, ["switch", ...(create ? ["-c"] : []), branch]);
  } catch (error) {
    const { stderr = "", message } = error as { stderr?: string; message: string };
    throw new Error(stderr.trim() || message);
  }
}

/**
 * Run the shell command `command` in `dir`. A failure reports the end of the output. When `signal` aborts, the command
 * and all its child processes are killed.
 */
export function runSetup(dir: string, command: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Nobody can answer a question of the command, so it gets no stdin. It leads its own process group.
    const child = spawn("/bin/sh", ["-c", command], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk).slice(-OUTPUT_LIMIT - 1);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const abort = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      reject(new Error("The setup command was stopped."));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (code === 0) return resolve();
      const text = output.trim() || `The command exited with code ${code}.`;
      reject(new Error(`The setup command failed: ${text.length > OUTPUT_LIMIT ? `…${text.slice(-OUTPUT_LIMIT)}` : text}`));
    });
  });
}

/** Commit all changes in the worktree `dir` with `message`. Returns false when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  if (!(await git(dir, ["status", "--porcelain"])).trim()) return false;
  await git(dir, ["add", "-A"]);
  // The hooks of the project are for its own commits, not for the snapshots on a task branch.
  await git(dir, ["commit", "--no-verify", "-m", message]);
  return true;
}

/** The files that changed in the worktree `dir` since the commit `base`, with uncommitted and new files. */
export async function changedFiles(dir: string, base: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(dir, ["diff", "--name-only", "-z", base]),
    git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean);
}

/** The diff of the worktree `dir` since the commit `base`. A new file shows only after it is committed. */
export function diffSince(dir: string, base: string): Promise<string> {
  return git(dir, ["diff", base]);
}

/** True when `branch` is merged into the current branch of the repository in `path`. */
export function isMerged(path: string, branch: string): Promise<boolean> {
  return git(path, ["merge-base", "--is-ancestor", branch, "HEAD"]).then(
    () => true,
    (error: { code?: number }) => {
      if (error.code === 1) return false;
      throw error;
    },
  );
}

/** Delete the worktree `dir` and its branch `branch` from the repository in `path`. */
export async function removeWorktree(path: string, dir: string, branch: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await git(path, ["worktree", "prune"]);
  // The orchestrator can delete a merged branch itself.
  if ((await git(path, ["branch", "--list", branch])).trim()) await git(path, ["branch", "-D", branch]);
}

/** Delete every entry under `folder` that is not an active worktree and does not contain one. */
async function removeUnused(folder: string, active: string[]): Promise<void> {
  const entries = await readdir(folder).catch(() => []);
  for (const name of entries) {
    const entry = join(folder, name);
    if (active.includes(entry)) continue;
    if (active.some((worktree) => worktree.startsWith(entry + sep))) await removeUnused(entry, active);
    else await rm(entry, { recursive: true, force: true });
  }
}

/**
 * Delete what no active task owns. Under `root`, that is every entry that is not an active worktree and does not
 * contain one. In each repository of `paths`, it is every `pi-ui/*` branch that is not an active branch. A path that
 * fails is reported and skipped.
 */
export async function removeLeftovers(
  root: string,
  paths: string[],
  active: { worktree: string; branch: string }[],
): Promise<void> {
  await removeUnused(root, active.map((item) => item.worktree));
  const branches = new Set(active.map((item) => item.branch));
  for (const path of paths) {
    try {
      await git(path, ["worktree", "prune"]);
      const listed = await git(path, ["branch", "--list", "pi-ui/*", "--format=%(refname:short)"]);
      for (const branch of listed.split("\n").filter(Boolean)) {
        if (!branches.has(branch)) await git(path, ["branch", "-D", branch]);
      }
    } catch (error) {
      console.error(`Could not clean up the repository ${path}:`, error);
    }
  }
}
