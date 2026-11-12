import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { type AgentMessage, applyEvent } from "../shared/chat-state.ts";
import type { ClientMessage, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";

function MessageView({ message }: { message: AgentMessage }) {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return <div className="item user">{text}</div>;
  }
  if (message.role !== "assistant") return null;
  return (
    <>
      {message.content.map((block, index) => {
        if (block.type === "text") return <div key={index} className="item assistant">{block.text}</div>;
        if (block.type === "toolCall") return <div key={index} className="item tool">▸ {block.name}</div>;
        return null;
      })}
      {message.errorMessage && <div className="item error">{message.errorMessage}</div>}
    </>
  );
}

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [cwd, setCwd] = useState("");
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [text, setText] = useState("");
  const running = session?.state.running ?? false;

  useEffect(() => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.onopen = () => setConnected(true);
    socket.onclose = () => {
      setConnected(false);
      setSession(null);
    };
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data) as ServerMessage;
      switch (data.type) {
        case "snapshot":
          setSession(data.session);
          setErrors([]);
          if (data.session) setCwd(data.session.cwd);
          break;
        case "event":
          setSession((current) => current && { ...current, state: applyEvent(current.state, data.event) });
          break;
        case "error":
          setErrors((current) => [...current, data.message]);
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
  }, [session, errors]);

  function send(message: ClientMessage) {
    socketRef.current?.send(JSON.stringify(message));
  }

  function submit() {
    if (!session || running || !text.trim()) return;
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
        {session && <div className="item info">Session in {session.cwd}</div>}
        {session?.state.messages.map((message, index) => <MessageView key={index} message={message} />)}
        {session?.state.streaming && <MessageView message={session.state.streaming} />}
        {errors.map((error, index) => (
          <div key={index} className="item error">
            {error}
          </div>
        ))}
        <div ref={endRef} />
      </main>
      <footer className="bar">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={session ? "Message Pi (Enter to send, Shift+Enter for a new line)" : "Start a session first"}
          disabled={!session}
          rows={3}
        />
        <button onClick={submit} disabled={!session || running || !text.trim()}>
          Send
        </button>
        <button onClick={() => send({ type: "abort" })} disabled={!running}>
          Stop
        </button>
      </footer>
    </div>
  );
}
