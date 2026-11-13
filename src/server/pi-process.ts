import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type {
  JsonAgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

const RPC_ENTRY = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

type PiRecord = JsonAgentSessionEvent | RpcExtensionUIRequest | RpcResponse;
type RpcSuccess<T extends RpcCommand> = Extract<RpcResponse, { command: T["type"]; success: true }>;

/** One `pi --mode rpc` child process, controlled through JSONL on stdin and stdout. */
export class PiProcess {
  private readonly child: ChildProcessByStdio<Writable, Readable, null>;
  private readonly pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private buffer = "";

  constructor(
    cwd: string,
    args: string[],
    onEvent: (event: JsonAgentSessionEvent) => void,
    onExit: (code: number | null) => void,
  ) {
    this.child = spawn(process.execPath, [RPC_ENTRY, ...args], { cwd, stdio: ["pipe", "pipe", "inherit"] });

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

    this.child.on("close", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`Pi exited with code ${code}`));
      this.pending.clear();
      onExit(code);
    });
  }

  /** Send a command and wait for its response. Rejects when Pi reports a failure. */
  send<T extends RpcCommand>(command: T): Promise<RpcSuccess<T>> {
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

  /** Close stdin, so Pi finishes pending work and exits. Resolves when the process has exited. */
  stop(): Promise<void> {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.once("close", () => resolve()));
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
