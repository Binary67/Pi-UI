import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatState } from "./chat-state.ts";

/** Messages from the browser to the server. */
export type ClientMessage =
  /** Show a new session in `cwd`, or the session in `file`. A session that is not live starts in a new Pi process. */
  | { type: "start"; cwd: string; file?: string }
  | { type: "prompt"; file: string; text: string }
  | { type: "abort"; file: string }
  | { type: "remove_project"; path: string }
  | { type: "remove_session"; file: string }
  /** List the subfolders of `path`, or of the home folder when `path` is empty. */
  | { type: "list_folders"; path: string };

export type SessionSnapshot = { cwd: string; file: string; state: ChatState };

export type SessionSummary = { file: string; title: string };

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
  | { type: "error"; message: string };
