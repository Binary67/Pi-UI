import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraft } from "./composerDraft.ts";

test("rejection restores text and attachments without replacing later edits in either session", () => {
  const draft = createDraft();
  draft.open("A");
  const image = { type: "image" as const, mimeType: "image/png", data: "abc" };
  draft.setText("Original");
  draft.setImages([image]);
  const sent = draft.submit("A")!;
  draft.setText("Later");
  draft.setImages([{ ...image, data: "xyz" }]);
  draft.open("B");
  draft.setText("Another chat");
  draft.finishPrompt("A", sent.id, "Rejected");
  assert.equal(draft.get().text, "Another chat");
  draft.open("A");
  assert.equal(draft.get().submission?.error, "Rejected");
  draft.restorePrompt("A");
  assert.equal(draft.get().text, "Original\n\nLater");
  assert.deepEqual(draft.get().images.map(({ data }) => data), ["abc", "xyz"]);
});

test("an acknowledgment clears only its submission; uncertain delivery needs a user decision", () => {
  const draft = createDraft();
  draft.open("A");
  draft.setText("First");
  const first = draft.submit("A")!;
  draft.setText("Second");
  draft.finishPrompt("A", first.id);
  assert.equal(draft.get().text, "Second");
  const second = draft.submit("A")!;
  draft.finishPrompt("A", first.id);
  draft.disconnected();
  assert.equal(draft.get().submission?.id, second.id);
  assert.match(draft.get().submission!.error!, /not confirmed/);
  assert.equal(draft.submit("A"), undefined);
});

test("out-of-order transcripts and failures settle only their own recording", () => {
  const draft = createDraft();
  const a = draft.waitTranscript("A");
  const b = draft.waitTranscript("B");
  draft.finishTranscript("B", b, { text: "Bravo" });
  draft.open("A");
  assert.deepEqual(draft.get().recordings, [a]);
  const retry = draft.waitTranscript("A");
  draft.finishTranscript("A", a, { error: "Recording failed" });
  draft.finishTranscript("A", a, { text: "Stale" });
  assert.deepEqual(draft.get().recordings, [retry]);
  draft.finishTranscript("A", retry, { text: "Alpha" });
  assert.equal(draft.get().text, "Alpha");
  draft.open("B");
  assert.equal(draft.get().text, "Bravo");
});
