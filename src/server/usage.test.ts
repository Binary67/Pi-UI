import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { readUsage } from "./usage.ts";

const NOW = new Date(2026, 10, 14, 12);

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-usage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSession(dir: string, folder: string, name: string, lines: unknown[]): Promise<string> {
  await mkdir(join(dir, folder), { recursive: true });
  const file = join(dir, folder, `${name}.jsonl`);
  const header = { type: "session", version: 3, id: name, timestamp: "2026-11-13T00:00:00.000Z", cwd: dir };
  await writeFile(file, [header, ...lines].map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
  return file;
}

function assistant(id: string, timestamp: number, usage = { input: 4, output: 10, cacheRead: 2, cacheWrite: 3, cost: { total: 0.5 } }) {
  return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "assistant", timestamp, durationMs: 100, usage } };
}

function user(id: string, timestamp: number) {
  return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "user", timestamp } };
}

test("sums assistant and user messages per local day", async (t) => {
  const dir = await fixture(t);
  await writeSession(dir, "a", "one", [
    user("u1", new Date(2026, 10, 14, 9).getTime()),
    assistant("a1", new Date(2026, 10, 14, 10).getTime()),
    assistant("a2", new Date(2026, 10, 14, 11).getTime()),
    user("u2", new Date(2026, 10, 13, 23, 59).getTime()),
    { type: "message", id: "t1", parentId: null, timestamp: "", message: { role: "toolResult", timestamp: new Date(2026, 10, 14, 9).getTime() } },
  ]);
  const days = await readUsage(dir, NOW);
  assert.deepEqual(days[29], {
    date: "2026-11-14",
    cost: 1,
    input: 8,
    cacheRead: 4,
    cacheWrite: 6,
    output: 20,
    durationMs: 200,
    assistantMessages: 2,
    userMessages: 1,
  });
  assert.equal(days[28]!.userMessages, 1);
  assert.equal(days[28]!.assistantMessages, 0);
});

test("returns 30 days with zeros, oldest first", async (t) => {
  const dir = await fixture(t);
  const days = await readUsage(dir, NOW);
  assert.equal(days.length, 30);
  assert.equal(days[0]!.date, "2026-10-16");
  assert.equal(days[29]!.date, "2026-11-14");
  assert.ok(days.every((day) => day.cost === 0 && day.assistantMessages === 0 && day.userMessages === 0));
});

test("skips messages outside the window", async (t) => {
  const dir = await fixture(t);
  await writeSession(dir, "a", "one", [
    user("u1", new Date(2026, 10, 15).getTime()),
    user("u2", new Date(2026, 9, 15, 23, 59).getTime()),
    user("u3", new Date(2026, 9, 16).getTime()),
  ]);
  const days = await readUsage(dir, NOW);
  assert.equal(days.reduce((sum, day) => sum + day.userMessages, 0), 1);
  assert.equal(days[0]!.userMessages, 1);
});

test("a message copied into a second file counts once", async (t) => {
  const dir = await fixture(t);
  const entries = [user("u1", new Date(2026, 10, 14, 9).getTime()), assistant("a1", new Date(2026, 10, 14, 10).getTime())];
  await writeSession(dir, "a", "one", entries);
  await writeSession(dir, "b", "two", [...entries, assistant("a2", new Date(2026, 10, 14, 11).getTime())]);
  const day = (await readUsage(dir, NOW))[29]!;
  assert.equal(day.userMessages, 1);
  assert.equal(day.assistantMessages, 2);
});

test("skips malformed lines", async (t) => {
  const dir = await fixture(t);
  await writeSession(dir, "a", "one", ["{broken", user("u1", new Date(2026, 10, 14, 9).getTime()), '{"type":"message","id":"x","mess']);
  assert.equal((await readUsage(dir, NOW))[29]!.userMessages, 1);
});

test("skips a file with an old modification time", async (t) => {
  const dir = await fixture(t);
  const file = await writeSession(dir, "a", "one", [user("u1", new Date(2026, 10, 14, 9).getTime())]);
  const old = new Date(2026, 9, 1);
  await utimes(file, old, old);
  assert.equal((await readUsage(dir, NOW))[29]!.userMessages, 0);
});

test("a missing folder gives 30 days of zeros", async (t) => {
  const dir = await fixture(t);
  const days = await readUsage(join(dir, "missing"), NOW);
  assert.equal(days.length, 30);
  assert.ok(days.every((day) => day.assistantMessages === 0 && day.userMessages === 0));
});

test("a changed file is read again", async (t) => {
  const dir = await fixture(t);
  const timestamp = new Date(2026, 10, 14, 9).getTime();
  await writeSession(dir, "a", "one", [user("u1", timestamp)]);
  assert.equal((await readUsage(dir, NOW))[29]!.userMessages, 1);
  await writeSession(dir, "a", "one", [user("u1", timestamp), user("u2", timestamp + 1000)]);
  assert.equal((await readUsage(dir, NOW))[29]!.userMessages, 2);
});
