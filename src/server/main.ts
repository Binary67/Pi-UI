import { stat } from "node:fs/promises";
import { type WebSocket, WebSocketServer } from "ws";
import { applyEvent, type ChatState, emptyChatState } from "../shared/chat-state.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { PiProcess } from "./pi-process.ts";

const HOST = "127.0.0.1";
const PORT = 3001;
// Only the Vite dev page may connect. Other websites open in the browser must not control Pi.
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

type Session = { cwd: string; pi: PiProcess; state: ChatState };

// The session belongs to the server, not to a page. It continues when pages reload or disconnect.
let session: Session | undefined;
const clients = new Set<WebSocket>();

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  for (const client of clients) send(client, message);
}

function snapshot(): ServerMessage {
  return { type: "snapshot", session: session ? { cwd: session.cwd, state: session.state } : null };
}

async function start(cwd: string): Promise<void> {
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Folder not found: ${cwd}`);
  session?.pi.stop();
  const current: Session = {
    cwd,
    state: emptyChatState,
    pi: new PiProcess(
      cwd,
      (event) => {
        if (session !== current) return;
        current.state = applyEvent(current.state, event);
        broadcast({ type: "event", event });
      },
      (code) => {
        if (session !== current) return;
        session = undefined;
        broadcast(snapshot());
        broadcast({ type: "error", message: `Pi exited with code ${code}` });
      },
    ),
  };
  session = current;
  broadcast(snapshot());
}

async function handle(message: ClientMessage): Promise<void> {
  if (message.type === "start") return start(message.cwd);
  if (!session) throw new Error("Start a session first.");
  const response =
    message.type === "prompt"
      ? await session.pi.send({ type: "prompt", message: message.text })
      : await session.pi.send({ type: "abort" });
  if (!response.success) throw new Error(response.error);
}

const server = new WebSocketServer({
  host: HOST,
  port: PORT,
  path: "/ws",
  verifyClient: ({ origin }: { origin: string }) => ALLOWED_ORIGINS.has(origin),
});

server.on("listening", () => console.log(`Pi UI server on ws://${HOST}:${PORT}/ws`));

server.on("connection", (socket) => {
  // Send the snapshot in the same tick as the join, so no event falls between them.
  clients.add(socket);
  send(socket, snapshot());

  socket.on("message", (data) => {
    handle(JSON.parse(String(data)) as ClientMessage).catch((error: unknown) =>
      send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  });

  socket.on("close", () => clients.delete(socket));
});
