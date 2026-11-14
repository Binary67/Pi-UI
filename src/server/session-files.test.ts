import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { forkSession, listSessions, moveSession } from "./session-files.ts";

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-sessions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSession(dir: string, name: string, entries: unknown[]): Promise<string> {
  const file = join(dir, `${name}.jsonl`);
  const header = { type: "session", version: 3, id: name, timestamp: "2026-11-13T00:00:00.000Z", cwd: dir };
  await writeFile(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

function message(id: string, parentId: string | null, value: { role: string; timestamp: number; [key: string]: unknown }) {
  return { type: "message", id, parentId, timestamp: new Date(value.timestamp).toISOString(), message: value };
}

test("session listing uses message activity, titles, and strict LF framing", async (t) => {
  const dir = await fixture(t);
  const newer = await writeSession(dir, "newer", [
    message("u1", null, { role: "user", content: "Original\u2028prompt\u2029text", timestamp: 1000 }),
    message("a1", "u1", { role: "assistant", content: [{ type: "text", text: "Reply" }], timestamp: 5000 }),
    { type: "session_info", id: "name", parentId: "a1", timestamp: "2026-11-13T01:00:00.000Z", name: " Named chat " },
  ]);
  const older = await writeSession(dir, "older", [
    message("u2", null, {
      role: "user",
      content: [
        { type: "image", data: "aA==", mimeType: "image/png" },
        { type: "text", text: "First" },
        { type: "text", text: "prompt" },
      ],
      timestamp: 2000,
    }),
    { type: "custom", id: "metadata", parentId: "u2", timestamp: "2026-11-13T23:00:00.000Z", data: "not activity" },
  ]);
  await writeFile(newer, (await readFile(newer, "utf8")) + '{"type":"session_info","name":"Incomplete');
  const invalid = join(dir, "invalid.jsonl");
  await writeFile(invalid, "{}\n");
  await writeSession(dir, "not-kept", []);
  const sessions = await listSessions([older, invalid, join(dir, "missing.jsonl"), newer]);
  assert.deepEqual(sessions, [
    { path: newer, title: "Named chat", modified: 5000 },
    { path: older, title: "First prompt", modified: 2000 },
  ]);
});

test("cleared titles use the first user text; empty and image-only chats have a placeholder", async (t) => {
  const dir = await fixture(t);
  const cleared = await writeSession(dir, "cleared", [
    message("u1", null, { role: "user", content: "Original\u2028prompt", timestamp: 1000 }),
    { type: "session_info", id: "n1", parentId: "u1", timestamp: "2026-11-13T01:00:00.000Z", name: "Old name" },
    { type: "session_info", id: "n2", parentId: "n1", timestamp: "2026-11-13T02:00:00.000Z", name: "" },
  ]);
  const images = await writeSession(dir, "images", [
    message("u2", null, { role: "user", content: [{ type: "image", data: "aA==", mimeType: "image/png" }], timestamp: 2000 }),
  ]);
  const empty = await writeSession(dir, "empty", []);
  const sessions = await listSessions([cleared, images, empty]);
  assert.equal(sessions.find((session) => session.path === cleared)?.title, "Original\u2028prompt");
  assert.equal(sessions.find((session) => session.path === images)?.title, "(no messages)");
  assert.equal(sessions.find((session) => session.path === empty)?.modified, Date.parse("2026-11-13T00:00:00.000Z"));
});

test("forks preserve ancestry, images, opaque metadata, compaction references, and latest labels", async (t) => {
  const dir = await fixture(t);
  const user = message("u1", null, {
    role: "user",
    content: [{ type: "text", text: "First prompt" }, { type: "image", data: "aA==", mimeType: "image/png" }],
    timestamp: 1000,
  });
  const assistant = message("a1", "u1", {
    role: "assistant",
    content: [{ type: "text", text: "Reply", textSignature: "opaque" }],
    provider: "fixture",
    model: "fixture",
    usage: { input: 1, output: 2 },
    timestamp: 2000,
  });
  const source = await writeSession(dir, "source", [
    user,
    assistant,
    { type: "label", id: "l1", parentId: "a1", targetId: "u1", label: "Old", timestamp: "2026-11-13T01:00:00.000Z" },
    { type: "label", id: "l2", parentId: "l1", targetId: "a1", label: "Clear me", timestamp: "2026-11-13T02:00:00.000Z" },
    { type: "custom", id: "custom", parentId: "l2", customType: "fixture", data: { opaque: true }, timestamp: "2026-11-13T03:00:00.000Z" },
    { type: "compaction", id: "compact", parentId: "custom", firstKeptEntryId: "l1", summary: "Summary", tokensBefore: 123, systemMessage: { role: "system", content: "Checkpoint" }, timestamp: "2026-11-13T04:00:00.000Z" },
    { type: "context_edit", id: "edit", parentId: "compact", targetId: "u1", replacement: null, timestamp: "2026-11-13T05:00:00.000Z" },
    message("target", "edit", { role: "user", content: "Selected prompt", timestamp: 3000 }),
    message("future", "target", { role: "assistant", content: [], timestamp: 4000 }),
    message("other-branch", "u1", { role: "user", content: "Do not copy", timestamp: 5000 }),
    { type: "session_info", id: "name", parentId: "other-branch", name: "Current\ntitle", timestamp: "2026-11-13T06:00:00.000Z" },
    { type: "label", id: "updated", parentId: "name", targetId: "u1", label: "Updated", timestamp: "2026-11-13T07:00:00.000Z" },
    { type: "label", id: "cleared", parentId: "updated", targetId: "a1", timestamp: "2026-11-13T08:00:00.000Z" },
    { type: "label", id: "dropped", parentId: "cleared", targetId: "target", label: "Not retained", timestamp: "2026-11-13T09:00:00.000Z" },
  ]);
  const original = await readFile(source, "utf8");
  const forked = await forkSession(source, 3000);
  assert.ok(forked);
  const [header, ...entries] = (await readFile(forked, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(header.version, 3);
  assert.equal(header.cwd, dir);
  assert.equal(header.parentSession, source);
  assert.notEqual(header.id, "source");
  assert.deepEqual(entries.slice(0, 5).map((entry) => entry.id), ["u1", "a1", "custom", "compact", "edit"]);
  assert.deepEqual(entries[0], user);
  assert.deepEqual(entries[1], assistant);
  assert.deepEqual(entries[2].data, { opaque: true });
  assert.equal(entries[3].firstKeptEntryId, "custom");
  assert.equal(entries[3].systemMessage.content, "Checkpoint");
  assert.equal(entries[4].replacement, null);
  assert.equal(entries[5].type, "label");
  assert.equal(entries[5].targetId, "u1");
  assert.equal(entries[5].label, "Updated");
  assert.equal(entries[5].timestamp, "2026-11-13T07:00:00.000Z");
  assert.equal(entries[6].name, "Fork: Current title");
  assert.equal(entries.length, 7);
  for (let index = 0; index < entries.length; index++) {
    assert.equal(entries[index].parentId, index === 0 ? null : entries[index - 1].id);
  }
  assert.equal(await readFile(source, "utf8"), original);
});

test("forking the first prompt creates no file, and a missing prompt is reported", async (t) => {
  const dir = await fixture(t);
  const source = await writeSession(dir, "source", [
    message("system", null, { role: "system", content: "Prompt", timestamp: 500 }),
    { type: "model_change", id: "model", parentId: "system", provider: "fixture", modelId: "fixture", timestamp: "2026-11-13T01:00:00.000Z" },
    message("u1", "model", { role: "user", content: "First prompt", timestamp: 1000 }),
  ]);
  const original = await readFile(source, "utf8");
  assert.equal(await forkSession(source, 1000), undefined);
  await assert.rejects(forkSession(source, 9999), /message is not in the session file/);
  assert.deepEqual(await readdir(dir), ["source.jsonl"]);
  assert.equal(await readFile(source, "utf8"), original);
});

test("forks retain a compaction's self-reference and fall back to the prior prompt for the name", async (t) => {
  const dir = await fixture(t);
  const source = await writeSession(dir, "source", [
    message("u1", null, { role: "user", content: "First\nprompt", timestamp: 1000 }),
    { type: "compaction", id: "compact", parentId: "u1", firstKeptEntryId: "compact", summary: "Retain none", timestamp: "2026-11-13T01:00:00.000Z" },
    message("u2", "compact", { role: "user", content: "Selected", timestamp: 2000 }),
  ]);
  const forked = await forkSession(source, 2000);
  assert.ok(forked);
  const records = (await readFile(forked, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records[2].firstKeptEntryId, "compact");
  assert.equal(records.at(-1).name, "Fork: First prompt");
});

test("a moved session gets the new working folder and keeps its entries, and a missing file stays absent", async (t) => {
  const dir = await fixture(t);
  const file = await writeSession(dir, "moved", [
    message("u1", null, { role: "user", content: "Prompt", timestamp: 1000 }),
  ]);
  const before = (await readFile(file, "utf8")).split("\n");
  await moveSession(file, "/projects/app");
  const after = (await readFile(file, "utf8")).split("\n");
  assert.deepEqual(JSON.parse(after[0]), { ...JSON.parse(before[0]), cwd: "/projects/app" });
  assert.deepEqual(after.slice(1), before.slice(1));

  await moveSession(join(dir, "missing.jsonl"), "/projects/app");
  assert.deepEqual((await readdir(dir)).sort(), ["moved.jsonl"]);
});
