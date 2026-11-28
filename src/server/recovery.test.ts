import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Session } from "./state.ts";

test("restart restores owners from both orchestrators and delivers the saved answer before clearing it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-ui-recovery-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    await rm(home, { recursive: true, force: true });
  });
  const file = join(home, ".pi-ui", "projects.json");
  await mkdir(join(home, ".pi-ui"));
  const base = { id: 1, prompt: "Research", files: ["src/"], additions: [] };
  const orchestrators = [
    { id: "one", file: "one", tasks: [{ ...base, title: "A", status: "review", pending: true, pendingResult: { answer: "Found it.", direct: true } }] },
    { id: "two", file: "two", tasks: [{ ...base, title: "B", status: "running" }] },
  ];
  await writeFile(file, JSON.stringify({ projects: [{ path: home, sessions: [], unread: [], orchestrators }] }));
  const { activeProjectTasks, loadProjects } = await import("./projects.ts");
  loadProjects();
  const [a, b] = activeProjectTasks(home);
  assert.equal(a.title, "A");
  assert.equal(b.title, "B");
  assert.equal(b.status, "review");

  const { report } = await import("./sessions.ts");
  const { sessions } = await import("./state.ts");
  let received = "";
  const orchestrator = {
    file: "one", cwd: home, state: { running: false }, pendingPrompts: 0, runStarts: 0,
    pi: { send: async ({ message }: { message: string }) => {
      received = message;
      assert.equal(a.pending, true);
      return { data: { disposition: "handled" } };
    } },
  } as unknown as Session;
  sessions.set("one", orchestrator);
  t.after(() => { clearTimeout(orchestrator.timer); sessions.delete("one"); });
  await report(home, a);
  assert.match(received, /Found it\./);
  assert.match(received, /sent messages to this subagent directly/);
  const saved = JSON.parse(await readFile(file, "utf8")).projects[0].orchestrators[0].tasks[0];
  assert.equal(saved.pending, false);
  assert.equal(saved.pendingResult, undefined);
});
