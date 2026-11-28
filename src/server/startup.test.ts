import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a failed bind leaves worktrees untouched", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-ui-bind-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    await rm(home, { recursive: true, force: true });
  });
  const worktree = join(home, ".pi-ui", "worktrees", "being-created");
  await mkdir(worktree, { recursive: true });
  const file = join(worktree, "work");
  await writeFile(file, "unfinished");
  t.mock.method(Server.prototype, "listen", function (this: Server) {
    process.nextTick(() => this.emit("error", new Error("address already in use")));
    return this;
  });
  await assert.rejects(import("./main.ts"), /address already in use/);
  assert.equal(await readFile(file, "utf8"), "unfinished");
});
