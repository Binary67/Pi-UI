import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  addWorktree,
  changedFiles,
  checkRepo,
  commitAll,
  diffSince,
  isMerged,
  removeWorktree,
  runSetup,
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
  await runSetup(worktree, "mkdir deps && echo ok > deps/lib.txt");
  await assert.rejects(runSetup(worktree, "echo missing >&2; exit 3"), /The setup command failed: missing/);

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
