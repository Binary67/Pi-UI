import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JsonAgentSessionEvent } from "../shared/pi-rpc.ts";
import { PiProcess } from "./pi-process.ts";

test("missing Pi rejects current and subsequent commands without crashing or installing anything", { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-missing-pi-"));
  const path = process.env.PATH;
  let pi: PiProcess;
  try {
    process.env.PATH = dir;
    pi = new PiProcess(dir, [], () => {}, () => {});
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
  t.after(async () => {
    await pi.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(pi.send({ type: "get_state" }), /Could not start Pi:.*PATH/);
  await assert.rejects(pi.send({ type: "get_entries" }), /Could not start Pi:.*PATH/);
  assert.equal(pi.exited, true);
  assert.equal(pi.busy, false);
  await pi.stop();
});

test("the PATH executable receives RPC/session args and handles framing, correlation, dialogs, orchestrator requests, and shutdown", { timeout: 5000 }, async (t) => {
  // On macOS, the temp folder is a symlink. Pi reports the real path as its cwd.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-ui-fake-pi-")));
  const sessionFile = join(dir, "session.jsonl");
  await writeFile(join(dir, "pi"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "--mode" || args[1] !== "rpc" || args[2] !== "--session") process.exit(1);
const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let state;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (command.type === "get_state") state = command;
    if (command.type === "get_available_models") {
      send({ type: "response", command: command.type, id: command.id, success: true, data: { models: [] } });
      const text = ("hello" + String.fromCharCode(8232) + "world" + String.fromCharCode(8233)).repeat(10000);
      const event = JSON.stringify({ type: "message_end", message: { role: "user", content: text, timestamp: 1000 } });
      process.stdout.write(event.slice(0, 37));
      setImmediate(() => {
        process.stdout.write(event.slice(37) + "\\r\\n");
        send({ type: "extension_ui_request", id: "dialog", method: "confirm" });
        send({ type: "extension_ui_request", id: "bridge", method: "editor", title: "pi-ui:echo", prefill: JSON.stringify({ text: "hi" }) });
        send({ type: "response", command: state.type, id: state.id, success: true, data: { sessionFile: args[3], thinkingLevel: "off", model: { provider: "fixture", id: process.cwd() } } });
      });
    }
    if (command.type === "extension_ui_response" && command.id === "dialog" && command.cancelled) {
      send({ type: "queue_update", steering: [], followUp: ["cancelled"] });
    }
    if (command.type === "extension_ui_response" && command.id === "bridge") {
      send({ type: "queue_update", steering: [command.value], followUp: [] });
    }
    if (command.type === "prompt") send({ type: "response", command: command.type, id: command.id, success: false, error: "Fixture rejection" });
  }
});
`, { mode: 0o755 });
  const events: JsonAgentSessionEvent[] = [];
  let confirmCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => { confirmCancelled = resolve; });
  let confirmAnswered!: () => void;
  const answered = new Promise<void>((resolve) => { confirmAnswered = resolve; });
  const path = process.env.PATH;
  let exitCode: number | null | undefined;
  let pi: PiProcess;
  try {
    process.env.PATH = dir;
    pi = new PiProcess(dir, ["--session", sessionFile], (event) => {
      events.push(event);
      if (event.type === "queue_update" && event.followUp.length) confirmCancelled();
      if (event.type === "queue_update" && event.steering.length) confirmAnswered();
    }, (code) => { exitCode = code; }, async (name, params) => `${name}: ${(params as { text: string }).text}`);
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
  t.after(async () => {
    await pi.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const state = pi.send({ type: "get_state" });
  const models = pi.send({ type: "get_available_models" });
  assert.equal(pi.busy, true);
  assert.deepEqual((await models).data.models, []);
  assert.equal((await state).data.sessionFile, sessionFile);
  assert.equal((await state).data.model?.id, dir);
  await cancelled;
  const event = events[0];
  assert.equal(event.type, "message_end");
  assert.ok(event.type === "message_end" && event.message.role === "user");
  assert.equal(event.message.content, "hello\u2028world\u2029".repeat(10000));
  assert.deepEqual(events[1], { type: "queue_update", steering: [], followUp: ["cancelled"] });
  await answered;
  assert.deepEqual(events[2], { type: "queue_update", steering: [JSON.stringify({ result: "echo: hi" })], followUp: [] });
  await assert.rejects(pi.send({ type: "prompt", message: "No model request" }), /Fixture rejection/);
  assert.equal(pi.busy, false);
  await pi.stop();
  assert.equal(exitCode, 0);
  assert.equal(pi.exited, true);
  await pi.stop();
  await assert.rejects(pi.send({ type: "get_state" }), /Pi exited with code 0/);
});

test("a large record in many small writes is parsed in order with the records that follow it", { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-fake-pi-large-"));
  await writeFile(join(dir, "pi"), `#!${process.execPath}
const send = (record) => JSON.stringify(record) + "\\n";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (command.type !== "get_state") continue;
    const text = "x".repeat(4 * 1024 * 1024 + 123) + String.fromCharCode(8232);
    const big = send({ type: "message_end", message: { role: "user", content: text, timestamp: 1000 } });
    const rest = send({ type: "queue_update", steering: ["a"], followUp: [] })
      + send({ type: "queue_update", steering: ["b"], followUp: [] }).replace("\\n", "\\r\\n")
      + send({ type: "response", command: command.type, id: command.id, success: true, data: {} });
    const all = big + rest;
    for (let i = 0; i < all.length; i += 4096) process.stdout.write(all.slice(i, i + 4096));
  }
});
`, { mode: 0o755 });
  const events: JsonAgentSessionEvent[] = [];
  const path = process.env.PATH;
  let pi: PiProcess;
  try {
    process.env.PATH = dir;
    pi = new PiProcess(dir, [], (event) => events.push(event), () => {});
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
  t.after(async () => {
    await pi.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await pi.send({ type: "get_state" });
  assert.equal(events.length, 3);
  const [big, first, second] = events;
  assert.ok(big.type === "message_end" && big.message.role === "user");
  assert.equal(big.message.content, "x".repeat(4 * 1024 * 1024 + 123) + "\u2028");
  assert.deepEqual(first, { type: "queue_update", steering: ["a"], followUp: [] });
  assert.deepEqual(second, { type: "queue_update", steering: ["b"], followUp: [] });
});

test("stop kills a Pi that ignores stdin EOF after the grace period", { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-fake-pi-hang-"));
  await writeFile(join(dir, "pi"), `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => setInterval(() => {}, 1000));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  let exitCode: number | null | undefined;
  const path = process.env.PATH;
  let pi: PiProcess;
  try {
    process.env.PATH = dir;
    pi = new PiProcess(dir, [], () => {}, (code) => { exitCode = code; });
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
  const started = Date.now();
  await pi.stop(200);
  assert.ok(Date.now() - started >= 200);
  assert.equal(exitCode, null);
  assert.equal(pi.exited, true);
  await pi.stop(200);
});

test("a line that is not JSON does not throw, and the records after it still arrive", { timeout: 5000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-fake-pi-stray-"));
  await writeFile(join(dir, "pi"), `#!${process.execPath}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (command.type !== "get_state") continue;
    process.stdout.write("stray text\\n");
    process.stdout.write(JSON.stringify({ type: "queue_update", steering: ["a"], followUp: [] }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "response", command: command.type, id: command.id, success: true, data: {} }) + "\\n");
  }
});
`, { mode: 0o755 });
  const events: JsonAgentSessionEvent[] = [];
  const path = process.env.PATH;
  let pi: PiProcess;
  try {
    process.env.PATH = dir;
    pi = new PiProcess(dir, [], (event) => events.push(event), () => {});
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
  t.after(async () => {
    await pi.stop();
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(console, "error", () => {});
  await pi.send({ type: "get_state" });
  assert.deepEqual(events, [{ type: "queue_update", steering: ["a"], followUp: [] }]);
});
