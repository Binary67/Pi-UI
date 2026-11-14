import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
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

// The commits of the tests need an identity, also on a machine without a git configuration.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-worktrees-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a project must be the top folder of a repository with a commit and without uncommitted changes", async (t) => {
  const dir = await fixture(t);
  await assert.rejects(checkRepo(dir), /not a git repository/);
  git(dir, "init", "-q");
  await assert.rejects(checkRepo(dir), /no commit/);
  await writeFile(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  await checkRepo(dir);
  await writeFile(join(dir, "b.txt"), "b\n");
  await assert.rejects(checkRepo(dir), /uncommitted changes/);
  await rm(join(dir, "b.txt"));
  await mkdir(join(dir, "sub"));
  await assert.rejects(checkRepo(join(dir, "sub")), /top folder/);
});

test("a task branch goes from a new worktree to a merge, then the worktree and the branch are deleted", async (t) => {
  const dir = await fixture(t);
  const repo = join(dir, "repo");
  git(dir, "init", "-q", repo);
  await writeFile(join(repo, "a.txt"), "a\n");
  await writeFile(join(repo, ".gitignore"), "deps/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

  const worktree = join(dir, "worktrees", "x", "task-1");
  const branch = "pi-ui/x/task-1";
  const base = await addWorktree(repo, worktree, branch);
  assert.equal(base, git(repo, "rev-parse", "HEAD").trim());
  await runSetup(worktree, "mkdir deps && echo ok > deps/lib.txt", new AbortController().signal);
  await assert.rejects(runSetup(worktree, "echo missing >&2; exit 3", new AbortController().signal), /The setup command failed: missing/);

  await writeFile(join(worktree, "a.txt"), "changed\n");
  await writeFile(join(worktree, "b.txt"), "new\n");
  // Ignored files, such as the dependencies of the setup, are not changes.
  assert.deepEqual((await changedFiles(worktree, base)).sort(), ["a.txt", "b.txt"]);
  assert.match(await diffSince(worktree, base), /\+changed/);

  assert.equal(await commitAll(worktree, "Task 1"), true);
  assert.equal(await commitAll(worktree, "Task 1"), false);
  assert.deepEqual((await changedFiles(worktree, base)).sort(), ["a.txt", "b.txt"]);
  assert.equal(await isMerged(repo, branch), false);

  git(repo, "merge", "-q", "--no-ff", "--no-edit", branch);
  assert.equal(await isMerged(repo, branch), true);

  await removeWorktree(repo, worktree, branch);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(repo, "branch", "--list", branch), "");
  assert.doesNotMatch(git(repo, "worktree", "list"), /task-1/);
  // The branch can be gone already.
  await removeWorktree(repo, worktree, branch);
});

test("the startup sweep keeps the active worktree and branch, and deletes the rest", async (t) => {
  const dir = await fixture(t);
  const repo = join(dir, "repo");
  git(dir, "init", "-q", repo);
  await writeFile(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

  const root = join(dir, "worktrees");
  const keep = { worktree: join(root, "x", "task-1"), branch: "pi-ui/x/task-1" };
  const leak = { worktree: join(root, "x", "task-2"), branch: "pi-ui/x/task-2" };
  await addWorktree(repo, keep.worktree, keep.branch);
  await addWorktree(repo, leak.worktree, leak.branch);
  await mkdir(join(root, "orphan"));
  git(repo, "branch", "other");

  // A path that is not a repository does not stop the sweep.
  await removeLeftovers(root, [join(dir, "missing"), repo], [keep]);
  assert.equal(existsSync(keep.worktree), true);
  assert.equal(existsSync(leak.worktree), false);
  assert.equal(existsSync(join(root, "orphan")), false);
  assert.match(git(repo, "branch", "--list", keep.branch), /task-1/);
  assert.equal(git(repo, "branch", "--list", leak.branch), "");
  assert.match(git(repo, "branch", "--list", "other"), /other/);
  assert.doesNotMatch(git(repo, "worktree", "list"), /task-2/);
});

test("a branch is read from a repository, with sorted names and without task branches", async (t) => {
  const dir = await fixture(t);
  assert.equal(await readBranch(dir), null);
  const repo = join(dir, "repo");
  git(dir, "init", "-q", "-b", "main", repo);
  // A repository without a commit has its unborn branch.
  assert.deepEqual(await readBranch(repo), { current: "main", detached: false, branches: [] });
  await writeFile(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "branch", "zeta");
  git(repo, "branch", "alpha");
  git(repo, "branch", "feature/x");
  git(repo, "branch", "pi-ui/x/task-1");
  assert.deepEqual(await readBranch(repo), {
    current: "main",
    detached: false,
    branches: ["alpha", "feature/x", "main", "zeta"],
  });
  // A subfolder belongs to the repository.
  await mkdir(join(repo, "sub"));
  assert.equal((await readBranch(join(repo, "sub")))?.current, "main");

  git(repo, "checkout", "-q", "--detach");
  const hash = git(repo, "rev-parse", "--short", "HEAD").trim();
  assert.deepEqual(await readBranch(repo), {
    current: hash,
    detached: true,
    branches: ["alpha", "feature/x", "main", "zeta"],
  });
});

test("a switch creates a branch and changes to it, and a failed switch gives the git message", async (t) => {
  const dir = await fixture(t);
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");

  await switchBranch(dir, "work", true);
  assert.equal((await readBranch(dir))?.current, "work");
  await switchBranch(dir, "main", false);
  assert.equal((await readBranch(dir))?.current, "main");
  await assert.rejects(switchBranch(dir, "missing", false), /invalid reference: missing/);
  await assert.rejects(switchBranch(dir, "work", true), /already exists/);
  await assert.rejects(switchBranch(dir, "bad name", true), /not a valid branch name/);

  // Uncommitted changes that conflict with the other branch stop the switch.
  await switchBranch(dir, "work", false);
  await writeFile(join(dir, "a.txt"), "work\n");
  git(dir, "commit", "-q", "-am", "work");
  await switchBranch(dir, "main", false);
  await writeFile(join(dir, "a.txt"), "dirty\n");
  await assert.rejects(switchBranch(dir, "work", false), /would be overwritten/);
});

test("an aborted setup command rejects fast, and its child processes are killed", async (t) => {
  const dir = await fixture(t);
  const abort = new AbortController();
  const started = Date.now();
  const run = runSetup(dir, "sleep 30 & echo $! > child.pid; wait", abort.signal);
  const rejected = assert.rejects(run);
  const pidFile = join(dir, "child.pid");
  while (!existsSync(pidFile) || !(await readFile(pidFile, "utf8")).trim()) await sleep(10);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  abort.abort();
  await rejected;
  assert.ok(Date.now() - started < 1000);
  await sleep(50);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  // A signal that is aborted already stops the command at once.
  await assert.rejects(runSetup(dir, "sleep 30", abort.signal));
});
