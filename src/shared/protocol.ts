import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcSessionState,
  SessionStats,
} from "./pi-rpc.ts";
import type { ChatState } from "./chat-state.ts";

/** An image attached to a prompt, in the Pi wire format: base64 data and a MIME type. */
export type PromptImage = NonNullable<Extract<RpcCommand, { type: "prompt" }>["images"]>[number];

/** How Pi handles a prompt during a run. `steer` guides the next LLM call, `followUp` waits until the run ends. */
export type StreamingBehavior = NonNullable<Extract<RpcCommand, { type: "prompt" }>["streamingBehavior"]>;

export type ThinkingLevel = RpcSessionState["thinkingLevel"];

/** The parts of a Pi model that the page shows. The full model can contain provider headers. */
export type ModelRef = Pick<NonNullable<RpcSessionState["model"]>, "provider" | "id">;

/** The kinds of session. Pi-UI remembers the last model and thinking level of each kind for its new sessions. */
export type SessionKind = "chat" | "orchestrator" | "subagent";

/** A remembered model and thinking level. An absent field leaves the Pi default. */
export type ModelChoice = { model?: ModelRef; thinkingLevel?: ThinkingLevel };

/** The model, thinking level, and usage of a session: the data of the TUI footer. */
export type SessionInfo = {
  /** Absent when no model is selected. */
  model?: ModelRef;
  /** The models that have credentials. */
  models: ModelRef[];
  thinkingLevel: ThinkingLevel;
  /** The levels of the model. Only "off" for a model without reasoning. */
  thinkingLevels: ThinkingLevel[];
  stats: SessionStats;
};

/** The git branch of the folder where a session works. */
export type BranchInfo = {
  /** The current branch. At a detached HEAD, the short hash of the commit. */
  current: string;
  /** True at a detached HEAD. */
  detached: boolean;
  /** The local branches, sorted by name, without the `pi-ui/*` task branches. */
  branches: string[];
};

/** Messages from the browser to the server. */
export type ClientMessage =
  /** Show a new session in `cwd`, or the session in `file`. A session that is not live starts in a new Pi process. */
  | { type: "start"; cwd: string; file?: string }
  /**
   * Show the empty orchestrator of the project in `cwd`, or a new one when it has none. Each orchestrator solves one
   * problem.
   */
  | { type: "orchestrator"; cwd: string }
  /** Pi uses `streamingBehavior` only during a run. In an idle session, the prompt starts a run. */
  | { type: "prompt"; file: string; text: string; images: PromptImage[]; streamingBehavior: StreamingBehavior }
  /** Clear the queue, then stop the run. The queued text comes back in a `restore` message. */
  | { type: "abort"; file: string }
  | { type: "set_model"; file: string; provider: string; modelId: string }
  | { type: "set_thinking_level"; file: string; level: ThinkingLevel }
  /** Ask for the subagent choice. The answer is a `subagent` message. */
  | { type: "get_subagent" }
  | { type: "set_subagent_model"; provider: string; modelId: string }
  | { type: "set_subagent_thinking_level"; level: ThinkingLevel }
  /** Copy the session in `file` up to its user message with `timestamp` into a new session, then show it. */
  | { type: "fork"; file: string; timestamp: number }
  /** Read the branch of the session in `file` again. The answer is a `branch` message. */
  | { type: "list_branches"; file: string }
  /** Switch the project of the session in `file` to `branch`. With `create`, make the branch from the current commit first. */
  | { type: "switch_branch"; file: string; branch: string; create: boolean }
  | { type: "remove_project"; path: string }
  | { type: "rename_project"; path: string; name: string }
  /** An orchestrator goes with the sessions of its tasks. Its active tasks are cancelled. */
  | { type: "remove_session"; file: string }
  /** List the subfolders of `path`, or of the home folder when `path` is empty. */
  | { type: "list_folders"; path: string }
  /** Ask for the usage of the last 30 days. The answer is a `usage` message. */
  | { type: "get_usage" }
  /** Ask for the text of a voice recording. `audio` is base64 data without a `data:` URL prefix. */
  | { type: "transcribe"; audio: string; mimeType: string }
  /** Ask for a `pong`, to check that the connection is alive. */
  | { type: "ping" };

export type SessionSnapshot = { cwd: string; file: string; state: ChatState; info: SessionInfo };

/** `unread` is true when the last run ended while no page showed the session, and no page opened it since. */
export type SessionSummary = { file: string; title: string; unread: boolean };

/** A live session runs now, or it is warm: idle, with a Pi process that is ready. */
export type SessionStatus = "running" | "warm";

/** The orchestrator sessions of a project, newest first. They are not in `sessions`. */
export type Project = { path: string; name?: string; sessions: SessionSummary[]; orchestrators: SessionSummary[] };

/** The tasks of an orchestrator run in parallel. A task is active while it is `running` or in `review`. A task with a worktree keeps it during that time. */
export type TaskStatus = "running" | "review" | "done" | "cancelled";

/** A task of an orchestrator, as the task board shows it. */
export type TaskSummary = {
  id: number;
  title: string;
  status: TaskStatus;
  /** The session file of the subagent. Absent until the setup of the task ends. */
  file?: string;
  /** Why the task is in review, such as an error. */
  note?: string;
  /** The setup command or the last tool call of a running task, such as `edit src/app.ts`. */
  activity?: string;
};

export type FolderListing = { path: string; parent: string; folders: { name: string; path: string }[] };

/** The usage of one local day, from the messages of all Pi session files. */
export type UsageDay = {
  /** The local date, `YYYY-MM-DD`. */
  date: string;
  /** Sum of `usage.cost.total` of the assistant messages, in dollars. */
  cost: number;
  /** Sums of `usage.input`, `usage.cacheRead`, `usage.cacheWrite`, and `usage.output` of the assistant messages. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Sum of `durationMs` of the assistant messages. */
  durationMs: number;
  assistantMessages: number;
  userMessages: number;
};

/** Messages from the server to the browser. */
export type ServerMessage =
  /** The tailnet URL that opens this UI on other devices. Null when remote access is off. */
  | { type: "remote"; url: string | null }
  /** The session that this page shows now. */
  | { type: "snapshot"; session: SessionSnapshot | null }
  /** A new Pi process starts. The next snapshot or error ends the wait. */
  | { type: "starting" }
  | { type: "projects"; projects: Project[] }
  /** The status of each live session, by session file. A session that is not in the list is cold. */
  | { type: "status"; sessions: Record<string, SessionStatus> }
  /** The tasks of each orchestrator in start order, by the session file of the orchestrator. */
  | { type: "tasks"; tasks: Record<string, TaskSummary[]> }
  | { type: "folders"; listing: FolderListing }
  | { type: "event"; file: string; event: JsonAgentSessionEvent }
  /** New model, thinking level, or usage data for the session in `file`. */
  | { type: "info"; file: string; info: SessionInfo }
  /** The subagent choice, and the last model list that the server read. The list is empty before the first session. */
  | { type: "subagent"; choice: ModelChoice; models: ModelRef[] }
  /** The branch of the session in `file`. Null when its folder is not in a git repository. */
  | { type: "branch"; file: string; branch: BranchInfo | null }
  /** The text of the queued messages that an abort removed, for the composer. */
  | { type: "restore"; text: string }
  /** The text of the voice recording of a `transcribe` message, for the composer. */
  | { type: "transcript"; text: string }
  /** The usage of each local day of the last 30 days, oldest first, today last. A day without use has zeros. */
  | { type: "usage"; days: UsageDay[] }
  /** The answer to a `ping`. */
  | { type: "pong" }
  | { type: "error"; message: string };
