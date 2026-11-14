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

/** Messages from the browser to the server. */
export type ClientMessage =
  /** Show a new session in `cwd`, or the session in `file`. A session that is not live starts in a new Pi process. */
  | { type: "start"; cwd: string; file?: string }
  /** Show the orchestrator of the project in `cwd`. A project without an orchestrator gets a new one. */
  | { type: "orchestrator"; cwd: string }
  /** Pi uses `streamingBehavior` only during a run. In an idle session, the prompt starts a run. */
  | { type: "prompt"; file: string; text: string; images: PromptImage[]; streamingBehavior: StreamingBehavior }
  /** Clear the queue, then stop the run. The queued text comes back in a `restore` message. */
  | { type: "abort"; file: string }
  | { type: "set_model"; file: string; provider: string; modelId: string }
  | { type: "set_thinking_level"; file: string; level: ThinkingLevel }
  /** Copy the session in `file` up to its user message with `timestamp` into a new session, then show it. */
  | { type: "fork"; file: string; timestamp: number }
  | { type: "remove_project"; path: string }
  | { type: "remove_session"; file: string }
  /** List the subfolders of `path`, or of the home folder when `path` is empty. */
  | { type: "list_folders"; path: string }
  /** Ask for the text of a voice recording. `audio` is base64 data without a `data:` URL prefix. */
  | { type: "transcribe"; audio: string; mimeType: string }
  /** Ask for a `pong`, to check that the connection is alive. */
  | { type: "ping" };

export type SessionSnapshot = { cwd: string; file: string; state: ChatState; info: SessionInfo };

/** `unread` is true when the last run ended while no page showed the session, and no page opened it since. */
export type SessionSummary = { file: string; title: string; unread: boolean };

/** A live session runs now, or it is warm: idle, with a Pi process that is ready. */
export type SessionStatus = "running" | "warm";

/** The orchestrator session of a project. It is not in `sessions`. */
export type Project = { path: string; sessions: SessionSummary[]; orchestrator?: { file: string; unread: boolean } };

/** Only one task of an orchestrator at a time is `running` or in `review`. */
export type TaskStatus = "queued" | "running" | "review" | "done" | "cancelled";

/** A task of an orchestrator, as the task board shows it. */
export type TaskSummary = {
  id: number;
  title: string;
  status: TaskStatus;
  /** The session file of the subagent. Absent until the task starts. */
  file?: string;
  /** Why the task is in review, such as an error. */
  note?: string;
  /** The last tool call of a running task, such as `edit src/app.ts`. */
  activity?: string;
};

export type FolderListing = { path: string; parent: string; folders: { name: string; path: string }[] };

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
  /** The tasks of each orchestrator in queue order, by project path. */
  | { type: "tasks"; tasks: Record<string, TaskSummary[]> }
  | { type: "folders"; listing: FolderListing }
  | { type: "event"; file: string; event: JsonAgentSessionEvent }
  /** New model, thinking level, or usage data for the session in `file`. */
  | { type: "info"; file: string; info: SessionInfo }
  /** The text of the queued messages that an abort removed, for the composer. */
  | { type: "restore"; text: string }
  /** The text of the voice recording of a `transcribe` message, for the composer. */
  | { type: "transcript"; text: string }
  /** The answer to a `ping`. */
  | { type: "pong" }
  | { type: "error"; message: string };
