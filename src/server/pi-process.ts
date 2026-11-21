import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { spawn } from "cross-spawn";
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "../shared/pi-rpc.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
// The orchestrator extension sends its requests as editor dialogs with this title prefix. See src/orchestrator/extension.ts.
const REQUEST_PREFIX = "pi-ui:";
// Time that Pi gets to exit after stdin is closed. After this time, stop() kills it.
const STOP_GRACE_MS = 10_000;

/** Handles a request of the orchestrator extension. Returns the text for the model, or throws an error for it. */
export type RequestHandler = (name: string, params: unknown) => Promise<string>;

type PiRecord = JsonAgentSessionEvent | RpcExtensionUIRequest | RpcResponse;
type RpcSuccess<T extends RpcCommand> = Extract<RpcResponse, { command: T["type"]; success: true }>;

/** One `pi --mode rpc` child process, controlled through JSONL on stdin and stdout. */
export class PiProcess {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
  private readonly onRequest?: RequestHandler;
  private nextId = 0;
  private parts: string[] = [];
  private failure?: Error;

  constructor(
    cwd: string,
    args: string[],
    onEvent: (event: JsonAgentSessionEvent) => void,
    onExit: (code: number | null) => void,
    onRequest?: RequestHandler,
  ) {
    this.onRequest = onRequest;
    this.child = spawn("pi", ["--mode", "rpc", ...args], { cwd, stdio: ["pipe", "pipe", "inherit"] });
    this.child.on("error", (error) =>
      this.fail(new Error(`Could not start Pi: ${error.message}. Make sure pi is installed and available on PATH.`)),
    );
    this.child.stdin.on("error", (error) => this.fail(error));

    // Split only on LF: JSON strings can contain U+2028 and U+2029, so readline is not safe here.
    this.child.stdout.setEncoding("utf8");
    // The parts of a partial record are joined once, when its LF arrives. So the work is linear in the size of the data.
    this.child.stdout.on("data", (chunk: string) => {
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf("\n", start)) !== -1) {
        this.parts.push(chunk.slice(start, end));
        const line = this.parts.join("").replace(/\r$/, "");
        this.parts = [];
        start = end + 1;
        if (!line) continue;
        let record: PiRecord;
        try {
          record = JSON.parse(line) as PiRecord;
        } catch {
          // A stray line on stdout must not stop the stream. The next lines still arrive.
          console.error("Pi wrote a line that is not JSON:", line);
          continue;
        }
        this.handleRecord(record, onEvent);
      }
      if (start < chunk.length) this.parts.push(start ? chunk.slice(start) : chunk);
    });

    this.closed = new Promise((resolve) => {
      this.child.on("close", (code) => {
        this.fail(new Error(`Pi exited with code ${code}`));
        onExit(code);
        resolve();
      });
    });
  }

  /** Send a command and wait for its response. Rejects when Pi reports a failure. */
  send<T extends RpcCommand>(command: T): Promise<RpcSuccess<T>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const settle = (response: RpcResponse) =>
        response.success ? resolve(response as RpcSuccess<T>) : reject(new Error(response.error));
      this.pending.set(id, { resolve: settle, reject });
      this.write({ ...command, id });
    });
  }

  /** True while a command waits for its response. */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /** True after the process has exited. */
  get exited(): boolean {
    return this.failure !== undefined || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** Close stdin, so Pi finishes pending work and exits. Kills Pi with SIGKILL when it is still running after `graceMs`. Resolves when the process has exited. */
  stop(graceMs = STOP_GRACE_MS): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, graceMs);
    return this.closed.finally(() => clearTimeout(timer));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const { reject } of this.pending.values()) reject(this.failure);
    this.pending.clear();
  }

  private handleRecord(record: PiRecord, onEvent: (event: JsonAgentSessionEvent) => void): void {
    if (record.type === "response") {
      const { id = "" } = record;
      this.pending.get(id)?.resolve(record);
      this.pending.delete(id);
    } else if (record.type === "extension_ui_request") {
      if (this.onRequest && record.method === "editor" && record.title?.startsWith(REQUEST_PREFIX)) {
        void this.answer(this.onRequest, record.id, record.title.slice(REQUEST_PREFIX.length), record.prefill);
      } else if (DIALOG_METHODS.has(record.method)) {
        // The UI has no dialogs yet. Cancel them, so the run does not wait forever.
        this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
      }
    } else {
      onEvent(record);
    }
  }

  /** Answer a request of the orchestrator extension with JSON: `{ result }`, or `{ error }`. */
  private async answer(onRequest: RequestHandler, id: string, name: string, prefill = ""): Promise<void> {
    // A bad `prefill` or a synchronous throw also gives an `{ error }` answer, so Pi does not wait for ever.
    const value = await Promise.resolve().then(() => onRequest(name, JSON.parse(prefill))).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    this.write({ type: "extension_ui_response", id, value: JSON.stringify(value) });
  }

  private write(record: RpcCommand | RpcExtensionUIResponse): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }
}
