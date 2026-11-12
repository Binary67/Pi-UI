import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** Messages from the browser to the server. */
export type ClientMessage =
  | { type: "start"; cwd: string }
  | { type: "prompt"; text: string }
  | { type: "abort" };

/** Messages from the server to the browser. */
export type ServerMessage =
  | { type: "started"; cwd: string }
  | { type: "event"; event: JsonAgentSessionEvent }
  | { type: "exited"; code: number | null }
  | { type: "error"; message: string };
