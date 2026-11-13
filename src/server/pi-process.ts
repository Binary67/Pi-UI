import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "../shared/pi-rpc.ts";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

type PiRecord = JsonAgentSessionEvent | RpcExtensionUIRequest | RpcResponse;
type RpcSuccess<T extends RpcCommand> = Extract<RpcResponse, { command: T["type"]; success: true }>;

/** One `pi --mode rpc` child process, controlled through JSONL on stdin and stdout. */
export class PiProcess {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly closed: Promise<void>;
  private readonly pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private buffer = "";
  private failure?: Error;

  constructor(
    cwd: string,
    args: string[],
    onEvent: (event: JsonAgentSessionEvent) => void,
    onExit: (code: number | null) => void,
  ) {
    this.child = spawn("pi", ["--mode", "rpc", ...args], { cwd, stdio: ["pipe", "pipe", "inherit"] });
    this.child.on("error", (error) =>
      this.fail(new Error(`Could not start Pi: ${error.message}. Make sure pi is installed and available on PATH.`)),
    );
    this.child.stdin.on("error", (error) => this.fail(error));

    // Split only on LF: JSON strings can contain U+2028 and U+2029, so readline is not safe here.
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end).replace(/\r$/, "");
        this.buffer = this.buffer.slice(end + 1);
        if (line) this.handleRecord(JSON.parse(line) as PiRecord, onEvent);
      }
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

  /** Close stdin, so Pi finishes pending work and exits. Resolves when the process has exited. */
  stop(): Promise<void> {
    this.child.stdin.end();
    return this.closed;
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
      // The UI has no dialogs yet. Cancel them, so the run does not wait forever.
      if (DIALOG_METHODS.has(record.method)) {
        this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
      }
    } else {
      onEvent(record);
    }
  }

  private write(record: RpcCommand | RpcExtensionUIResponse): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }
}
