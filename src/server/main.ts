import { once } from "node:events";
import { type WebSocket, WebSocketServer } from "ws";
import { parseClientMessage } from "./client-message.ts";
import { handle, starting } from "./handle.ts";
import { send, statusMessage, tasksMessage } from "./messages.ts";
import { allTasks, getOrchestrators, listProjects, loadProjects, projectPaths } from "./projects.ts";
import { refreshCheckouts } from "./checkouts.ts";
import { aborts, release, report, WORKTREES_DIR } from "./sessions.ts";
import { clients, views } from "./state.ts";
import { isActive } from "./tasks.ts";
import { removeLeftovers } from "./worktrees.ts";

const HOST = "127.0.0.1";
const PORT = 3001;
// The tailnet URL of this Mac, from `.env`. Empty or absent, remote access is off.
const REMOTE_URL = process.env.PI_UI_REMOTE_URL || null;
// Only the Vite dev page, locally or at REMOTE_URL, may connect. Other websites open in the browser must not control Pi.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(REMOTE_URL ? [new URL(REMOTE_URL).origin] : []),
]);

// A phone can lose its connection without a close. A page that does not answer a ping before the next one is gone: its
// socket closes, so its session no longer counts as shown.
const HEARTBEAT_MS = 30 * 1000;
// The largest message from a page. A voice recording or an image in a prompt arrives as base64 in one message.
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

let ready = false;
const server = new WebSocketServer({
  host: HOST,
  port: PORT,
  path: "/ws",
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient: ({ origin }: { origin: string }) => ready && ALLOWED_ORIGINS.has(origin),
});
// Binding is the single-instance guard. Read the authoritative state only after acquiring it.
await once(server, "listening");
// Replaying an update can launch a setup command before the UI is ready.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    for (const abort of aborts.values()) abort.abort();
    process.kill(process.pid, signal);
  });
}
loadProjects();
await refreshCheckouts();

// Delete the worktrees and branches that no active task owns. No task can start during the sweep.
await removeLeftovers(
  WORKTREES_DIR,
  projectPaths(),
  allTasks().flatMap(([, tasks]) =>
    tasks.flatMap((task) => (isActive(task) && task.worktree ? [{ worktree: task.worktree.dir, branch: task.worktree.branch }] : [])),
  ),
);

// The updates that the last server run did not deliver. `report` commits the changes of a worktree task first.
const recovery: Promise<void>[] = [];
for (const path of projectPaths()) {
  for (const { tasks } of getOrchestrators(path)) {
    for (const task of tasks.filter((item) => item.status === "review" && item.pending)) {
      recovery.push(report(path, task, { ...task }).catch((error: unknown) =>
        console.error(`Could not send the update of task ${task.id}:`, error),
      ));
    }
  }
}

await Promise.all(recovery);

// The pages that answered the last ping.
const alive = new WeakSet<WebSocket>();
setInterval(() => {
  for (const client of clients) {
    if (alive.delete(client)) client.ping();
    else client.terminate();
  }
}, HEARTBEAT_MS);

server.on("connection", (socket) => {
  clients.add(socket);
  alive.add(socket);
  socket.on("pong", () => alive.add(socket));
  // Without a listener, a protocol error or an oversized frame crashes the server. The close handler cleans up.
  socket.on("error", () => socket.terminate());
  send(socket, { type: "remote", url: REMOTE_URL });
  send(socket, statusMessage());
  send(socket, tasksMessage());
  void listProjects().then((projects) => send(socket, { type: "projects", projects }));

  socket.on("message", (data) => {
    // The parse is inside the chain, so a malformed message gives an error and the server keeps running.
    Promise.resolve()
      .then(() => handle(socket, parseClientMessage(String(data))))
      .catch((error: unknown) => send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }));
  });

  socket.on("close", () => {
    clients.delete(socket);
    starting.delete(socket);
    const file = views.get(socket);
    views.delete(socket);
    if (file) release(file);
  });
});
ready = true;
console.log(`Pi UI server on ws://${HOST}:${PORT}/ws`);
