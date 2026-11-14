import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "./projects.ts";
import { outside, overlap, taskPrompt } from "./tasks.ts";

function task(id: number, additions: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    status: "running",
    goal: `Do ${id}.`,
    files: ["src/a.ts", "docs/"],
    inputs: "The API.",
    outputs: "A function.",
    criteria: "Typecheck passes.",
    contract: "Shared types.",
    additions,
    worktree: `/worktrees/task-${id}`,
    branch: `pi-ui/x/task-${id}`,
    base: "abc",
  };
}

test("owned files overlap when they are equal, or when a folder covers a file", () => {
  assert.equal(overlap([{ title: "A", files: ["src/a.ts"] }, { title: "B", files: ["src/b.ts"] }]), undefined);
  assert.equal(overlap([{ title: "A", files: ["src/a.ts"] }, { title: "B", files: ["src/a.ts"] }]), `"src/a.ts" of "A" and "src/a.ts" of "B"`);
  assert.equal(overlap([{ title: "A", files: ["src/a.ts"] }, { title: "B", files: ["src/"] }]), `"src/a.ts" of "A" and "src/" of "B"`);
  // Only a path that ends with / covers a folder.
  assert.equal(overlap([{ title: "A", files: ["src"] }, { title: "B", files: ["src/a.ts"] }]), undefined);
  assert.equal(
    overlap([{ title: "A", files: ["a"] }, { title: "B", files: ["b"] }, { title: "C", files: ["b"] }]),
    `"b" of "B" and "b" of "C"`,
  );
});

test("the changed files outside the owned files", () => {
  assert.deepEqual(outside(task(1), ["src/a.ts", "docs/guide.md", "src/b.ts", "package.json"]), ["src/b.ts", "package.json"]);
});

test("the first prompt of a subagent has the contract, and the added instructions at the end", () => {
  const prompt = taskPrompt(task(1));
  for (const part of ["# Task 1: Task 1", "Shared types.", "Do 1.", "- src/a.ts\n- docs/", "The API.", "A function.", "Typecheck passes."]) {
    assert.ok(prompt.includes(part), part);
  }
  assert.ok(!prompt.includes("Additional instructions"));
  assert.ok(taskPrompt(task(1, ["Also A.", "Also B."])).endsWith("## Additional instructions\n\nAlso A.\n\nAlso B."));
});
