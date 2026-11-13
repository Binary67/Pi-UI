import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatState } from "./chat-state.ts";

/** Messages from the browser to the server. */
export type ClientMessage =
  /** Start a new session in `cwd`, or open the session in `file`. */
  | { type: "start"; cwd: string; file?: string }
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "remove_project"; path: string }
  | { type: "remove_session"; file: string }
  /** List the subfolders of `path`, or of the home folder when `path` is empty. */
  | { type: "list_folders"; path: string };

export type SessionSnapshot = { cwd: string; file: string; state: ChatState };

export type SessionSummary = { file: string; title: string };

export type Project = { path: string; sessions: SessionSummary[] };

export type FolderListing = { path: string; parent: string; folders: { name: string; path: string }[] };

/** Messages from the server to the browser. */
export type ServerMessage =
  | { type: "snapshot"; session: SessionSnapshot | null }
  | { type: "projects"; projects: Project[] }
  | { type: "folders"; listing: FolderListing }
  | { type: "event"; event: JsonAgentSessionEvent }
  | { type: "error"; message: string };
