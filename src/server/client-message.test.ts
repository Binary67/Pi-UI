import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientMessage } from "./client-message.ts";

test("a valid message passes", () => {
  const messages = [
    { type: "ping" },
    { type: "start", cwd: "/work" },
    { type: "start", cwd: "/work", file: "/work/a.jsonl" },
    { type: "fork", file: "a.jsonl", timestamp: 5 },
    { type: "switch_branch", file: "a.jsonl", branch: "main", create: false },
    { type: "set_thinking_level", file: "a.jsonl", level: "high" },
    { type: "get_subagent" },
    { type: "set_subagent_model", provider: "openai", modelId: "gpt-5" },
    { type: "set_subagent_thinking_level", level: "low" },
    {
      type: "prompt",
      file: "a.jsonl",
      text: "Hi",
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      streamingBehavior: "steer",
    },
  ];
  for (const message of messages) assert.deepEqual(parseClientMessage(JSON.stringify(message)), message);
});

test("a value that is not an object throws", () => {
  for (const data of ["5", "null", '"ping"']) assert.throws(() => parseClientMessage(data), /must be a JSON object/);
});

test("an unknown type throws", () => {
  assert.throws(() => parseClientMessage('{"type":"nope"}'), /Unknown message type/);
  assert.throws(() => parseClientMessage('{"type":"toString"}'), /Unknown message type/);
  assert.throws(() => parseClientMessage("{}"), /Unknown message type/);
});

test("a missing field throws", () => {
  assert.throws(() => parseClientMessage('{"type":"prompt","file":"a","images":[],"streamingBehavior":"steer"}'), /"prompt" has a wrong field: text/);
});

test("a field of the wrong type throws", () => {
  assert.throws(() => parseClientMessage('{"type":"fork","file":"a","timestamp":"5"}'), /"fork" has a wrong field: timestamp/);
  assert.throws(() => parseClientMessage('{"type":"set_thinking_level","file":"a","level":"max"}'), /wrong field: level/);
  assert.throws(() => parseClientMessage('{"type":"set_subagent_model","provider":"openai"}'), /wrong field: modelId/);
  assert.throws(
    () => parseClientMessage('{"type":"prompt","file":"a","text":"Hi","images":[{"data":"x"}],"streamingBehavior":"steer"}'),
    /wrong field: images/,
  );
});
