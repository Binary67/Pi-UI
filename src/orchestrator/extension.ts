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
    execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: Context): Promise<ToolResult>;
  }): void;
  registerCommand(name: string, options: { description: string; handler(args: string): Promise<void> }): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { deliverAs: "followUp"; triggerTurn: boolean },
  ): void;
};

const ID = { type: "integer", description: "The task id." };

function object(properties: object, required: string[]): object {
  return { type: "object", properties, required, additionalProperties: false };
}

const TOOLS = [
  {
    name: "queue_tasks",
    label: "Queue tasks",
    promptSnippet: "Add tasks to the queue of subagents",
    description:
      "Add tasks to the end of the queue. Subagents do the tasks one at a time, in queue order. The first new task starts at once when no task is running or in review. A subagent does not see this conversation, so each prompt must stand alone.",
    parameters: object(
      {
        tasks: {
          type: "array",
          minItems: 1,
          items: object(
            {
              title: { type: "string", description: "A short title for the task board and the session list." },
              prompt: {
                type: "string",
                description: "The complete instructions: the goal, the relevant files, the constraints, and the acceptance criteria.",
              },
            },
            ["title", "prompt"],
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
    description: "List all tasks in queue order, with status, note, cost, and the current activity of the running task.",
    parameters: object({}, []),
  },
  {
    name: "get_task",
    label: "Get task",
    promptSnippet: "Show the progress or the result of one task",
    description:
      "Show one task: status, run time, prompt, added instructions, current tool, recent tool calls, changed files and diffs, the latest text of the subagent, and cost. Use it to check progress and to review a task.",
    parameters: object({ id: ID }, ["id"]),
  },
  {
    name: "message_task",
    label: "Message task",
    promptSnippet: "Send instructions to the subagent of a task",
    description:
      "Send instructions to the subagent of a task. For a running task, mode steer delivers the text after its current tool calls, and mode followUp delivers it when its run ends. For a task in review, the text starts a new run in the same session. For a queued task, the text is added to its prompt. Done and cancelled tasks cannot get messages.",
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
    label: "Finish task",
    promptSnippet: "Accept a task in review",
    description: "Accept a task in review and mark it done. The next queued task then starts.",
    parameters: object({ id: ID }, ["id"]),
  },
  {
    name: "cancel_task",
    label: "Cancel task",
    promptSnippet: "Cancel a task",
    description: "Cancel a task that is queued, running, or in review. A running subagent stops. The next queued task then starts.",
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
