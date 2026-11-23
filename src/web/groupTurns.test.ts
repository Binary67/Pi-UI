import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage, AssistantMessage } from "../shared/chat-state.ts";
import { groupTurns } from "./groupTurns.ts";

let time = 0;

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: (time += 1000) } as AgentMessage;
}

function update(id: number): AgentMessage {
  return { role: "custom", customType: "task_update", content: `Task ${id}`, timestamp: (time += 1000) } as AgentMessage;
}

function result(): AgentMessage {
  return { role: "toolResult", toolCallId: "t", content: [], timestamp: (time += 1000) } as unknown as AgentMessage;
}

/** An assistant message. A block is a text, `tool` for a tool call, or `think:` and a thinking text. */
function assistant(blocks: string[], stopReason = "stop"): AssistantMessage {
  const content = blocks.map((block) =>
    block === "tool"
      ? { type: "toolCall", id: "t", name: "bash", arguments: {} }
      : block.startsWith("think:")
        ? { type: "thinking", thinking: block.slice(6) }
        : { type: "text", text: block },
  );
  return { role: "assistant", content, stopReason, timestamp: (time += 1000), durationMs: 500 } as unknown as AssistantMessage;
}

test("a plain done turn collapses its steps and keeps the answer below", () => {
  const items = [user("Hi"), assistant(["tool"], "toolUse"), result(), assistant(["Done."])];
  const [turn] = groupTurns(items, null);
  assert.deepEqual(turn.work, { first: 1, last: 3, tools: 1, duration: 3500, thinking: false, earlier: false });
});

test("a turn with only an answer does not collapse", () => {
  assert.equal(groupTurns([user("Hi"), assistant(["Hello."])], null)[0].work, undefined);
});

test("the thinking of the answer goes into the group", () => {
  const [turn] = groupTurns([user("Hi"), assistant(["think:Hmm", "Hello."])], null);
  assert.deepEqual(turn.work, { first: 1, last: 1, tools: 0, duration: 1500, thinking: true, earlier: false });
  const [blank] = groupTurns([user("Hi"), assistant(["think: ", "Hello."])], null);
  assert.equal(blank.work, undefined);
});

test("a running turn collapses when the streaming message has text and no tool call", () => {
  const streaming = assistant(["think:Hmm", "Par"]);
  const items = [user("Hi"), assistant(["tool"], "toolUse"), result(), streaming];
  const [turn] = groupTurns(items, streaming);
  // The duration is unknown while the answer streams.
  assert.deepEqual(turn.work, { first: 1, last: 3, tools: 1, duration: undefined, thinking: true, earlier: false });
});

test("a running turn does not collapse when the streaming message has a tool call", () => {
  const streaming = assistant(["Let me look.", "tool"]);
  const items = [user("Hi"), assistant(["tool"], "toolUse"), result(), streaming];
  assert.equal(groupTurns(items, streaming)[0].work, undefined);
});

test("a streaming message without text does not collapse", () => {
  const streaming = assistant(["think:Hmm"]);
  assert.equal(groupTurns([user("Hi"), streaming], streaming)[0].work, undefined);
});

test("earlier turns of an exchange collapse fully, and the final turn shows its answer", () => {
  const items = [
    user("Start tasks"),
    assistant(["tool"], "toolUse"),
    result(),
    assistant(["Started."]),
    update(1),
    assistant(["think:Check", "Task 1 is fine."]),
    update(2),
    assistant(["tool"], "toolUse"),
    result(),
    assistant(["All done."]),
  ];
  const turns = groupTurns(items, null);
  assert.deepEqual(
    turns.map((turn) => turn.start),
    [0, 4, 6],
  );
  assert.deepEqual(turns[0].work, { first: 1, last: 4, tools: 1, duration: 3500, thinking: false, earlier: true });
  assert.deepEqual(turns[1].work, { first: 1, last: 2, tools: 0, duration: 1500, thinking: false, earlier: true });
  assert.deepEqual(turns[2].work, { first: 1, last: 3, tools: 1, duration: 3500, thinking: false, earlier: false });
});

test("an earlier turn without an assistant message does not collapse", () => {
  const turns = groupTurns([user("Start"), update(1), assistant(["Fine."])], null);
  assert.equal(turns[0].work, undefined);
  assert.equal(turns[1].work, undefined);
});

test("a new user message starts a new exchange", () => {
  const items = [user("One"), assistant(["tool"], "toolUse"), result(), assistant(["First."]), user("Two"), assistant(["Second."])];
  const turns = groupTurns(items, null);
  assert.equal(turns[0].work?.earlier, false);
  assert.equal(turns[1].work, undefined);
});

test("a turn that ends with an error shows uncollapsed", () => {
  const items = [user("Hi"), assistant(["tool"], "toolUse"), result(), assistant(["Partial."], "error")];
  assert.equal(groupTurns(items, null)[0].work, undefined);
  // An earlier turn collapses also when it ends with an error.
  const earlier = groupTurns([...items, update(1), assistant(["Fine."])], null);
  assert.equal(earlier[0].work?.earlier, true);
});
