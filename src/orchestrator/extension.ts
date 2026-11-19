/**
 * The task tools of the orchestrator. Pi UI loads this extension into the orchestrator session of a project, with `-e`.
 *
 * Pi RPC has no channel for the requests of an extension. So each tool sends its request to the Pi UI server as an
 * editor dialog: the title is `pi-ui:<tool name>`, and the text is the JSON parameters. The server answers with JSON:
 * `{ result }` with the text for the model, or `{ error }`. The server sends a task update back with the command
 * `/pi-ui-task <JSON>`. The command adds the update to the conversation and starts a turn.
 */

// Pi gives an extension its own package, but this project does not install it. These are the parts in use.
type ToolResult = { content: { type: "text"; text: string }[]; details: undefined };
type Context = { ui: { editor(title: string, prefill: string): Promise<string | undefined> } };
type ExtensionAPI = {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: object;
    executionMode?: "sequential";
    execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Context): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, options: { description: string; handler(args: string): Promise<void> }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { deliverAs: "followUp"; triggerTurn: boolean },
  ): void;
};

const ID = { type: "integer", description: "The task id." };
const TEXT = (description: string) => ({ type: "string", description });

function object(properties: object, required: string[]): object {
  return { type: "object", properties, required, additionalProperties: false };
}

// The tools that change shared state (task ids, git branches, worktrees) are sequential. Pi then runs all calls of a message in order.
const TOOLS = [
  {
    name: "start_tasks",
    executionMode: "sequential" as const,
    label: "Start tasks",
    promptSnippet: "Start tasks in parallel, each with its own subagent, with or without a git worktree",
    description:
      "Start tasks in parallel. Each task gets its own subagent. A task with worktree true gets a new git worktree and branch from the last commit of the project, and it goes through a review and a merge. A task with worktree false runs in the project folder, and Pi UI does not commit its changes. A subagent does not see this conversation, so each prompt must stand alone. When the run of a task ends, a task update arrives.",
    parameters: object(
      {
        contract: TEXT(
          "The shared contract: the interfaces, types, names, file layout, and decisions that the tasks share. Each subagent of this call gets it.",
        ),
        setup: TEXT(
          "A shell command that prepares each new worktree before its subagent starts, such as `npm ci`. It runs only in the worktree of a task with worktree true. A worktree has no ignored files, such as dependencies or .env. Leave it out when the subagents need no setup.",
        ),
        tasks: {
          type: "array",
          minItems: 1,
          items: object(
            {
              title: TEXT("A short title for the task board and the session list."),
              prompt: TEXT(
                "The whole task, as free text. The subagent does not see this conversation, so the prompt must stand alone.",
              ),
              worktree: {
                type: "boolean",
                description:
                  "true: the task gets its own git worktree and branch from the last commit, with a review and a merge. The project must be the top folder of a git repository without uncommitted changes. false: the subagent runs in the project folder, and Pi UI does not commit its changes.",
              },
              files: {
                type: "array",
                items: { type: "string" },
                description:
                  "The owned files: the only files that the subagent may change, relative to the project folder, without ./. A path that ends with / covers its folder. The owned files of active tasks must not overlap. Leave it out when the task gives none.",
              },
            },
            ["title", "prompt", "worktree"],
          ),
        },
      },
      ["tasks"],
    ),
  },
  {
    name: "list_tasks",
    label: "List tasks",
    promptSnippet: "List the tasks with their status",
    description: "List all tasks in start order, with status, note, cost, and the current activity of each running task.",
    parameters: object({}, []),
  },
  {
    name: "get_task",
    label: "Get task",
    promptSnippet: "Show the progress or the result of one task",
    description:
      "Show one task: status, run time, prompt, owned files, contract, added instructions, current tool, recent tool calls, the latest text of the subagent, and cost. For a task with a worktree, it also shows the worktree, branch, base commit, changed files, changed files outside the owned files, and the diff since the base commit. Use it to check progress and to review a task.",
    parameters: object({ id: ID }, ["id"]),
  },
  {
    name: "message_task",
    executionMode: "sequential" as const,
    label: "Message task",
    promptSnippet: "Send instructions to the subagent of a task",
    description:
      "Send instructions to the subagent of a running task or a task in review. For a running task, mode steer delivers the text after its current tool calls, and mode followUp delivers it when its run ends. For a task in review, the text starts a new run in the same session, in the same worktree or project folder. During the setup, or for a task that could not start, the text is added to its prompt, and a task that could not start starts again. Done and cancelled tasks cannot get messages.",
    parameters: object(
      {
        id: ID,
        text: { type: "string", description: "The instructions for the subagent." },
        mode: {
          type: "string",
          enum: ["steer", "followUp"],
          description: "steer changes the current work. followUp adds work after the current run.",
        },
      },
      ["id", "text", "mode"],
    ),
  },
  {
    name: "finish_task",
    executionMode: "sequential" as const,
    label: "Finish task",
    promptSnippet: "Close a task in review",
    description:
      "Close a task in review and mark it done. For a task with a worktree, call it after you merged its branch into the current branch of the project. Pi UI checks the merge, stops the subagent, and deletes the worktree and the branch. For a task without a worktree, it stops the subagent and closes the task.",
    parameters: object({ id: ID }, ["id"]),
  },
  {
    name: "cancel_task",
    executionMode: "sequential" as const,
    label: "Cancel task",
    promptSnippet: "Cancel a task",
    description:
      "Cancel a running task or a task in review. Its subagent stops. A worktree and its branch are deleted without a merge.",
    parameters: object({ id: ID }, ["id"]),
  },
];

export default function (pi: ExtensionAPI) {
  for (const tool of TOOLS) {
    pi.registerTool({
      ...tool,
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const answer = await ctx.ui.editor(`pi-ui:${tool.name}`, JSON.stringify(params));
        if (answer === undefined) throw new Error("Pi UI did not answer. The task tools work only in Pi UI.");
        const { result, error } = JSON.parse(answer) as { result?: string; error?: string };
        if (error !== undefined) throw new Error(error);
        return { content: [{ type: "text", text: result! }], details: undefined };
      },
    });
  }

  pi.registerCommand("pi-ui-task", {
    description: "Pi UI: add a task update to the conversation",
    handler: async (args) => {
      const { text, details } = JSON.parse(args) as { text: string; details: unknown };
      pi.sendMessage({ customType: "task_update", content: text, display: true, details }, { deliverAs: "followUp", triggerTurn: true });
    },
  });
}
