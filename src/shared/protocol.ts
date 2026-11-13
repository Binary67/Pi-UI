import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcSessionState,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
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
  | { type: "list_folders"; path: string };

export type SessionSnapshot = { cwd: string; file: string; state: ChatState; info: SessionInfo };

/** `unread` is true when the last run ended while no page showed the session, and no page opened it since. */
export type SessionSummary = { file: string; title: string; unread: boolean };

/** A live session runs now, or it is warm: idle, with a Pi process that is ready. */
export type SessionStatus = "running" | "warm";

export type Project = { path: string; sessions: SessionSummary[] };

export type FolderListing = { path: string; parent: string; folders: { name: string; path: string }[] };

/** Messages from the server to the browser. */
export type ServerMessage =
  /** The session that this page shows now. */
  | { type: "snapshot"; session: SessionSnapshot | null }
  /** A new Pi process starts. The next snapshot or error ends the wait. */
  | { type: "starting" }
  | { type: "projects"; projects: Project[] }
  /** The status of each live session, by session file. A session that is not in the list is cold. */
  | { type: "status"; sessions: Record<string, SessionStatus> }
  | { type: "folders"; listing: FolderListing }
  | { type: "event"; file: string; event: JsonAgentSessionEvent }
  /** New model, thinking level, or usage data for the session in `file`. */
  | { type: "info"; file: string; info: SessionInfo }
  /** The text of the queued messages that an abort removed, for the composer. */
  | { type: "restore"; text: string }
  | { type: "error"; message: string };
