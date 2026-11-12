import { stat } from "node:fs/promises";
import { WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { PiProcess } from "./pi-process.ts";

const HOST = "127.0.0.1";
const PORT = 3001;
// Only the Vite dev page may connect. Other websites open in the browser must not control Pi.
const ALLOWED_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

const server = new WebSocketServer({
  host: HOST,
  port: PORT,
  path: "/ws",
  verifyClient: ({ origin }: { origin: string }) => ALLOWED_ORIGINS.has(origin),
});

server.on("listening", () => console.log(`Pi UI server on ws://${HOST}:${PORT}/ws`));

// Each browser connection owns one Pi process. Closing the page stops it.
server.on("connection", (socket) => {
  let pi: PiProcess | undefined;
  const send = (message: ServerMessage) => socket.send(JSON.stringify(message));

  async function start(cwd: string): Promise<void> {
    pi?.stop();
    pi = undefined;
    const info = await stat(cwd).catch(() => undefined);
    if (!info?.isDirectory()) {
      send({ type: "error", message: `Folder not found: ${cwd}` });
      return;
    }
    const current: PiProcess = new PiProcess(
      cwd,
      (event) => {
        if (pi === current) send({ type: "event", event });
      },
      (code) => {
        if (pi !== current) return;
        pi = undefined;
        send({ type: "exited", code });
      },
    );
    pi = current;
    send({ type: "started", cwd });
  }

  async function handle(message: ClientMessage): Promise<void> {
    if (message.type === "start") return start(message.cwd);
    if (!pi) return send({ type: "error", message: "Start a session first." });
    const response =
      message.type === "prompt"
        ? await pi.send({ type: "prompt", message: message.text })
        : await pi.send({ type: "abort" });
    if (!response.success) send({ type: "error", message: response.error });
  }

  socket.on("message", (data) => {
    handle(JSON.parse(String(data)) as ClientMessage).catch((error: unknown) =>
      send({ type: "error", message: error instanceof Error ? error.message : String(error) }),
    );
  });

  socket.on("close", () => {
    pi?.stop();
    pi = undefined;
  });
});
