import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "./projects.ts";
import { nextTask, taskPrompt } from "./tasks.ts";

function task(id: number, status: Task["status"], additions: string[] = []): Task {
  return { id, title: `Task ${id}`, prompt: `Do ${id}.`, status, additions };
}

test("the next task is the first queued task, only while no task is running or in review", () => {
  assert.equal(nextTask([task(1, "done"), task(2, "cancelled"), task(3, "queued"), task(4, "queued")])?.id, 3);
  assert.equal(nextTask([task(1, "running"), task(2, "queued")]), undefined);
  assert.equal(nextTask([task(1, "queued"), task(2, "review")]), undefined);
  assert.equal(nextTask([task(1, "done")]), undefined);
});

test("the first prompt of a subagent includes the instructions that were added in the queue", () => {
  assert.equal(taskPrompt(task(1, "queued")), "Do 1.");
  assert.equal(
    taskPrompt(task(1, "queued", ["Also A.", "Also B."])),
    "Do 1.\n\nAdditional instructions:\n\nAlso A.\n\nAlso B.",
  );
});
