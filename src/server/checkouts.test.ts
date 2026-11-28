import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedCheckouts, checkout, identifyCheckout, switching } from "./checkouts.ts";
import { sendPrompt } from "./sessions.ts";
import { type Session, sessions } from "./state.ts";

test("a prompt reserves the shared checkout across the RPC acknowledgment and agent start", async (t) => {
  const dir = process.cwd();
  const sub = `${dir}/src`;
  await Promise.all([dir, sub].map(identifyCheckout));
  const root = checkout(dir);
  assert.equal(checkout(sub), root);
  let accept!: () => void;
  const response = new Promise((resolve) => { accept = () => resolve({ data: { disposition: "started" } }); });
  const session = {
    cwd: sub, file: "chat", state: { running: false }, pi: { send: () => response },
    pendingPrompts: 0, runStarts: 0, awaitingRun: false,
  } as unknown as Session;
  sessions.set(session.file, session);
  t.after(() => { sessions.delete(session.file); switching.delete(root); });

  const prompt = { type: "prompt", message: "Hello" } as const;
  const sending = sendPrompt(session, prompt);
  assert.ok(blockedCheckouts().has(root));
  accept();
  await sending;
  assert.ok(blockedCheckouts().has(root));
  session.awaitingRun = false;
  session.state.running = true;
  assert.ok(blockedCheckouts().has(root));
  session.state.running = false;
  assert.equal(blockedCheckouts().has(root), false);

  switching.add(root);
  await assert.rejects(sendPrompt(session, prompt), /branch switch is in progress/);
});
