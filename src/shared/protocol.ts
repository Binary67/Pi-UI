import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatState } from "./chat-state.ts";

/** Messages from the browser to the server. */
export type ClientMessage =
  | { type: "start"; cwd: string }
  | { type: "prompt"; text: string }
  | { type: "abort" };

export type SessionSnapshot = { cwd: string; state: ChatState };

/** Messages from the server to the browser. */
export type ServerMessage =
  | { type: "snapshot"; session: SessionSnapshot | null }
  | { type: "event"; event: JsonAgentSessionEvent }
  | { type: "error"; message: string };
