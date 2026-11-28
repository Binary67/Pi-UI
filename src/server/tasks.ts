import type { ChatState } from "../shared/chat-state.ts";
import type { AgentMessage, AssistantMessage } from "../shared/pi-rpc.ts";
import type { Task } from "./projects.ts";

/** The longest diff text of one task view, in characters. A longer text keeps its end. */
const DIFF_LIMIT = 10000;
/** The number of recent tool calls in a task view. */
const RECENT_CALLS = 10;
/** The argument that describes a tool call best, in order of preference. */
const SUMMARY_KEYS = ["command", "path", "pattern", "url", "query"];

type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** The git changes of a task since its base commit. `outside` has the changed files outside the owned files. */
export type Changes = { files: string[]; outside: string[]; diff: string };

/** True while the task is running or in review. */
export function isActive(task: Task): boolean {
  return task.status === "running" || task.status === "review";
}

// Only the check and allocation of a batch are serialized. Subagents run outside this queue.
const allocations = new Map<string, Promise<string>>();

export function allocatingTasks(path: string): boolean {
  return allocations.has(path);
}

export async function allocateTasks(path: string, allocate: () => Promise<string>): Promise<string> {
  const previous = allocations.get(path) ?? Promise.resolve();
  const run = previous.then(allocate, allocate);
  allocations.set(path, run);
  try {
    return await run;
  } finally {
    if (allocations.get(path) === run) allocations.delete(path);
  }
}

/** True when the owned path `owner` covers `path`. An owned path that ends with `/` covers its folder. */
export function covers(owner: string, path: string): boolean {
  return owner === path || (owner.endsWith("/") && path.startsWith(owner));
}

/** The first owned paths that two of `tasks` share, as text. Undefined when no owned files overlap. */
export function overlap(tasks: Pick<Task, "title" | "files">[], owners: Pick<Task, "title" | "files">[] = []): string | undefined {
  for (const [index, a] of tasks.entries()) {
    for (const b of [...owners, ...tasks.slice(index + 1)]) {
      for (const x of a.files) {
        const y = b.files.find((file) => covers(x, file) || covers(file, x));
        if (y !== undefined) return `"${x}" of "${a.title}" and "${y}" of "${b.title}"`;
      }
    }
  }
  return undefined;
}

/** The files in `files` that are outside the owned files of `task`. */
export function outside(task: Pick<Task, "files">, files: string[]): string[] {
  return files.filter((file) => !task.files.some((owner) => covers(owner, file)));
}

/** The first prompt of a subagent: its task, where it works, and the instructions that the orchestrator added. */
export function taskPrompt(task: Task): string {
  const sections = [`# Task ${task.id}: ${task.title}`];
  if (task.contract) sections.push(`## Shared contract\n\n${task.contract}`);
  sections.push(`## Task\n\n${task.prompt}`);
  if (task.files.length) {
    const files = task.files.map((file) => `- ${file}`).join("\n");
    sections.push(`## Owned files\n\nChange only these files. A path that ends with / covers its folder.\n\n${files}`);
  }
  const folder = task.worktree
    ? `You work in a git worktree of the project, on the branch ${task.worktree.branch}. Other subagents work in parallel, in other worktrees. Pi UI commits your changes when your run ends.`
    : "You work in the project folder itself. Other sessions can work in this folder at the same time. Pi UI does not commit your changes.";
  sections.push(`## Work folder\n\n${folder}`);
  if (task.additions.length) sections.push(`## Additional instructions\n\n${task.additions.join("\n\n")}`);
  return sections.join("\n\n");
}

function cut(text: string, limit: number): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function messages(state: ChatState): AgentMessage[] {
  return state.streaming ? [...state.messages, state.streaming] : state.messages;
}

function toolCalls(state: ChatState): ToolCall[] {
  return messages(state).flatMap((message) =>
    message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
  );
}

function describeCall(call: ToolCall): string {
  const value = SUMMARY_KEYS.map((key) => call.arguments[key]).find((item) => typeof item === "string");
  return typeof value === "string" ? `${call.name} ${value.split("\n")[0].slice(0, 120)}` : call.name;
}

/** The last tool call of the session, such as `edit src/app.ts`. */
export function activity(state: ChatState): string | undefined {
  const call = toolCalls(state).at(-1);
  return call && describeCall(call);
}

function text(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n\n")
    .trim();
}

/** The last answer of the subagent, with its error. */
export function lastAnswer(messages: AgentMessage[]): string {
  const message = messages.findLast((item) => item.role === "assistant" || item.role === "user");
  if (message?.role !== "assistant") return "(no answer)";
  const parts = [text(message), message.errorMessage && `Error: ${message.errorMessage}`];
  return parts.filter(Boolean).join("\n\n") || "(no text)";
}

function changesText({ files, outside }: Changes): string {
  return [
    files.length ? `Changed files: ${files.join(", ")}` : "No changed files.",
    outside.length && `Changed files outside the owned files: ${outside.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** One line of `list_tasks`. `state` and `cost` are absent when the session of the task is not live. */
export function taskLine(task: Task, state?: ChatState, cost?: number): string {
  const now = task.status === "running" && state ? activity(state) : undefined;
  return [
    `${task.id}. [${task.status}] ${task.title}`,
    task.note && `note: ${task.note}`,
    now && `now: ${now}`,
    cost !== undefined && `$${cost.toFixed(2)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The view of a task for `get_task`. `state` and `cost` are absent before the subagent starts. `changes` is absent when
 * the task has no worktree.
 */
export function describeTask(task: Task, state?: ChatState, cost?: number, changes?: Changes): string {
  const status =
    task.status === "running" && task.started
      ? `running for ${formatDuration(Date.now() - task.started)}`
      : task.status;
  const lines = [`Task ${task.id}: ${task.title}`, `Status: ${status}`];
  if (task.note) lines.push(`Note: ${task.note}`);
  if (changes && task.worktree) {
    const { dir, branch, base } = task.worktree;
    lines.push(`Worktree: ${dir}`, `Branch: ${branch}`, `Base commit: ${base}`);
  }
  lines.push("", "Instructions:", taskPrompt(task));
  if (state) {
    const calls = toolCalls(state);
    const results = new Map(
      state.messages.flatMap((message) => (message.role === "toolResult" ? [[message.toolCallId, message] as const] : [])),
    );
    const current = calls.at(-1);
    if (state.running && current && !results.has(current.id)) lines.push("", `Current tool: ${describeCall(current)}`);
    if (calls.length) {
      lines.push("", `Recent tool calls (${Math.min(calls.length, RECENT_CALLS)} of ${calls.length}):`);
      for (const call of calls.slice(-RECENT_CALLS)) {
        lines.push(`- ${describeCall(call)}${results.get(call.id)?.isError ? " (error)" : ""}`);
      }
    }
  }
  if (changes) {
    lines.push("", changesText(changes));
    if (changes.diff) lines.push("", "Diff since the base commit:", cut(changes.diff, DIFF_LIMIT));
  }
  if (state) {
    const latest = messages(state).findLast((message) => message.role === "assistant" && text(message));
    if (latest?.role === "assistant") lines.push("", "Latest assistant text:", text(latest));
  }
  if (cost !== undefined) lines.push("", `Cost: $${cost.toFixed(2)}`);
  return lines.join("\n");
}

/**
 * The task update for the orchestrator, after a run of the task ended. `changes` is absent when the task has no
 * worktree. The answer and direct-message flag belong to the run that produced this update.
 */
export function updateText(task: Task, changes?: Changes): string {
  return [
    `Task ${task.id} "${task.title}" is now in ${task.status}.`,
    task.note && `Note: ${task.note}`,
    task.pendingResult?.direct && "The user sent messages to this subagent directly.",
    task.worktree && `Branch: ${task.worktree.branch}`,
    changes && changesText(changes),
    task.pendingResult?.answer && `Last answer of the subagent:\n\n${task.pendingResult.answer}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The line with the tasks of `running` for the end of a task update. Undefined when no task runs. */
export function runningText(running: Task[]): string | undefined {
  if (!running.length) return undefined;
  return `Tasks that still run: ${running.map((item) => `${item.id}. ${item.title}`).join(", ")}`;
}
