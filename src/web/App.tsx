import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

type Item = { kind: "user" | "assistant" | "tool" | "info" | "error"; text: string };
type AgentMessage = Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"];

function textOf(message: Extract<AgentMessage, { role: "user" | "assistant" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function applyEvent(items: Item[], event: JsonAgentSessionEvent): Item[] {
  switch (event.type) {
    case "message_start":
      if (event.message.role === "user") return [...items, { kind: "user", text: textOf(event.message) }];
      if (event.message.role === "assistant") return [...items, { kind: "assistant", text: "" }];
      return items;
    case "message_update": {
      // The streaming assistant message is always the last item.
      const update = event.assistantMessageEvent;
      if (update.type !== "text_delta") return items;
      const last = items[items.length - 1];
      return [...items.slice(0, -1), { ...last, text: last.text + update.delta }];
    }
    case "message_end": {
      // Replace the streamed text with the final message.
      if (event.message.role !== "assistant") return items;
      const final: Item[] = [...items.slice(0, -1), { kind: "assistant", text: textOf(event.message) }];
      return event.message.errorMessage ? [...final, { kind: "error", text: event.message.errorMessage }] : final;
    }
    case "tool_execution_start":
      return [...items, { kind: "tool", text: event.toolName }];
    default:
      return items;
  }
}

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [cwd, setCwd] = useState("");
  const [sessionCwd, setSessionCwd] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");

  useEffect(() => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.onopen = () => setConnected(true);
    socket.onclose = () => {
      setConnected(false);
      setSessionCwd(null);
      setRunning(false);
    };
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data) as ServerMessage;
      switch (data.type) {
        case "started":
          setSessionCwd(data.cwd);
          setRunning(false);
          setItems([{ kind: "info", text: `Session started in ${data.cwd}` }]);
          break;
        case "event":
          if (data.event.type === "agent_start") setRunning(true);
          if (data.event.type === "agent_settled") setRunning(false);
          setItems((current) => applyEvent(current, data.event));
          break;
        case "exited":
          setSessionCwd(null);
          setRunning(false);
          setItems((current) => [...current, { kind: "info", text: `Pi exited with code ${data.code}` }]);
          break;
        case "error":
          setItems((current) => [...current, { kind: "error", text: data.message }]);
          break;
      }
    };
    socketRef.current = socket;
    return () => {
      socket.onclose = null;
      socket.close();
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  function send(message: ClientMessage) {
    socketRef.current?.send(JSON.stringify(message));
  }

  function submit() {
    if (!sessionCwd || running || !text.trim()) return;
    send({ type: "prompt", text });
    setText("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="app">
      <header className="bar">
        <input
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder="Project folder, for example D:\Projects\my-app"
          disabled={!connected}
        />
        <button onClick={() => send({ type: "start", cwd: cwd.trim() })} disabled={!connected || !cwd.trim()}>
          Start
        </button>
      </header>
      {!connected && <div className="status">Not connected. Run npm run dev:server, then reload this page.</div>}
      <main className="output">
        {items.map((item, index) => (
          <div key={index} className={`item ${item.kind}`}>
            {item.kind === "tool" ? `▸ ${item.text}` : item.text}
          </div>
        ))}
        <div ref={endRef} />
      </main>
      <footer className="bar">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={sessionCwd ? "Message Pi (Enter to send, Shift+Enter for a new line)" : "Start a session first"}
          disabled={!sessionCwd}
          rows={3}
        />
        <button onClick={submit} disabled={!sessionCwd || running || !text.trim()}>
          Send
        </button>
        <button onClick={() => send({ type: "abort" })} disabled={!running}>
          Stop
        </button>
      </footer>
    </div>
  );
}
