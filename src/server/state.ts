import type { WebSocket } from "ws";
import type { ChatState } from "../shared/chat-state.ts";
import type { SessionInfo } from "../shared/protocol.ts";
import type { PiProcess } from "./pi-process.ts";

export type Session = { cwd: string; file: string; pi: PiProcess; state: ChatState; info: SessionInfo; timer?: NodeJS.Timeout };

// Sessions belong to the server, not to a page. Each live session has its own Pi process, so all of them can run at
// the same time. A session stops after it was idle for WARM_MS with no page that shows it. Its file keeps it for a
// later open.
export const sessions = new Map<string, Session>();
// The session file that each page shows.
export const views = new Map<WebSocket, string>();
export const clients = new Set<WebSocket>();
