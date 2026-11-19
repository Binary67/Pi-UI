import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatState } from "../shared/chat-state.ts";
import type { Task } from "./projects.ts";
import { outside, overlap, taskPrompt, updateText } from "./tasks.ts";

function task(id: number, additions: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    status: "review",
    prompt: `Do ${id}.`,
    files: ["src/a.ts", "docs/"],
    contract: "Shared types.",
    additions,
    worktree: { dir: `/worktrees/task-${id}`, branch: `pi-ui/x/task-${id}`, base: "abc" },
  };
}

/** A task without a worktree, without owned files, and without a contract. */
function plain(id: number, additions: string[] = []): Task {
  return { id, title: `Task ${id}`, status: "review", prompt: `Do ${id}.`, files: [], additions };
}

function answer(text: string): ChatState {
  const message = { role: "assistant", content: [{ type: "text", text }] };
  return { messages: [message] } as unknown as ChatState;
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
  // A task with no owned files never overlaps.
  assert.equal(overlap([{ title: "A", files: [] }, { title: "B", files: ["src/"] }, { title: "C", files: [] }]), undefined);
});

test("the changed files outside the owned files", () => {
  assert.deepEqual(outside(task(1), ["src/a.ts", "docs/guide.md", "src/b.ts", "package.json"]), ["src/b.ts", "package.json"]);
});

test("the first prompt of a task with a worktree has its sections in order", () => {
  const prompt = taskPrompt(task(1));
  const headings = [
    "# Task 1: Task 1",
    "## Shared contract\n\nShared types.",
    "## Task\n\nDo 1.",
    "## Owned files\n\nChange only these files. A path that ends with / covers its folder.\n\n- src/a.ts\n- docs/",
    "## Work folder\n\nYou work in a git worktree of the project, on the branch pi-ui/x/task-1. Other subagents work in parallel, in other worktrees. Pi UI commits your changes when your run ends.",
  ];
  const positions = headings.map((heading) => prompt.indexOf(heading));
  assert.ok(positions.every((position) => position >= 0), prompt);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.ok(!prompt.includes("Additional instructions"));
  assert.ok(!prompt.includes("Pi UI does not commit"));
});

test("the first prompt of a task without a worktree leaves out the empty sections", () => {
  const prompt = taskPrompt(plain(2));
  assert.equal(
    prompt,
    "# Task 2: Task 2\n\n## Task\n\nDo 2.\n\n## Work folder\n\nYou work in the project folder itself. Other sessions can work in this folder at the same time. Pi UI does not commit your changes.",
  );
  assert.ok(!prompt.includes("Shared contract"));
  assert.ok(!prompt.includes("Owned files"));
});

test("the added instructions are the last section", () => {
  assert.ok(taskPrompt(task(1, ["Also A.", "Also B."])).endsWith("## Additional instructions\n\nAlso A.\n\nAlso B."));
  assert.ok(taskPrompt(plain(2, ["Also A."])).endsWith("## Work folder\n\nYou work in the project folder itself. Other sessions can work in this folder at the same time. Pi UI does not commit your changes.\n\n## Additional instructions\n\nAlso A."));
});

test("the task update lists the tasks that still run", () => {
  const text = updateText(task(1), [plain(2), plain(3)], { files: ["src/a.ts"], outside: [], diff: "" });
  assert.ok(text.startsWith(`Task 1 "Task 1" is now in review.`));
  assert.ok(text.includes("Branch: pi-ui/x/task-1"));
  assert.ok(text.includes("Changed files: src/a.ts"));
  assert.ok(text.includes("Tasks that still run: 2. Task 2, 3. Task 3"));
  assert.ok(!updateText(task(1), []).includes("Tasks that still run"));
});

test("the task update of a task without a worktree has no branch and no changed files", () => {
  const text = updateText(plain(2), [plain(3)], undefined, answer("Done."));
  assert.equal(text, `Task 2 "Task 2" is now in review.\n\nTasks that still run: 3. Task 3\n\nLast answer of the subagent:\n\nDone.`);
  assert.ok(!text.includes("Branch:"));
  assert.ok(!text.includes("hanged files"));
});

test("the task update does not cut a long last answer", () => {
  const long = "x".repeat(5000);
  assert.ok(updateText(plain(2), [], undefined, answer(long)).endsWith(`\n\n${long}`));
});
