import { ArrowDown, ArrowLeft, ArrowUp, Folder, Pi, Square, SquarePen } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyEvent } from "../shared/chat-state.ts";
import type { ClientMessage, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { Banner, MessageView, type ToolResults, Working } from "./Message.tsx";

const RECENT_KEY = "pi-ui.recent-folders";
const RECENT_LIMIT = 5;
/** Distance in pixels from the page bottom that still counts as "at the bottom". */
const BOTTOM_SLACK = 80;
const COMPOSER_MAX_HEIGHT = 200;

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function isAtBottom(): boolean {
  const root = document.documentElement;
  return root.scrollHeight - root.scrollTop - root.clientHeight < BOTTOM_SLACK;
}

function scrollToBottom(behavior: ScrollBehavior): void {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [connected, setConnected] = useState(false);
  const [cwd, setCwd] = useState("");
  const [recent, setRecent] = useState<string[]>(() => JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"));
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [atBottom, setAtBottom] = useState(true);
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
          if (data.session) {
            const path = data.session.cwd;
            setCwd(path);
            setPicking(false);
            setRecent((current) => {
              const next = [path, ...current.filter((item) => item !== path)].slice(0, RECENT_LIMIT);
              localStorage.setItem(RECENT_KEY, JSON.stringify(next));
              return next;
            });
          }
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
    const onScroll = () => setAtBottom(isAtBottom());
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Follow new content only when the reader is already at the bottom.
  useEffect(() => {
    if (atBottom) scrollToBottom("instant");
  }, [session, errors, atBottom]);

  // Grow the composer with its text, up to a limit.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [text, session, picking]);

  function send(message: ClientMessage) {
    socketRef.current?.send(JSON.stringify(message));
  }

  function start(path: string) {
    setErrors([]);
    send({ type: "start", cwd: path.trim() });
  }

  function onStart(event: FormEvent) {
    event.preventDefault();
    start(cwd);
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

  const showChat = session && !picking;
  const messages = session?.state.messages ?? [];
  const streaming = session?.state.streaming ?? null;
  // One list, so a streamed message keeps its element when it completes.
  const items = streaming ? [...messages, streaming] : messages;
  const results: ToolResults = new Map();
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">
            <Pi size={16} />
          </span>
          Pi
        </div>
        {showChat && (
          <span className="chip" title={session.cwd}>
            <Folder size={14} />
            <span>{folderName(session.cwd)}</span>
          </span>
        )}
        <div className="header-actions">
          {showChat && (
            <button className="icon-button" onClick={() => setPicking(true)} title="New session">
              <SquarePen size={18} />
            </button>
          )}
        </div>
      </header>

      {!connected && (
        <div className="column notice">
          <Banner>
            Not connected. Run <code>npm run dev:server</code>, then reload this page.
          </Banner>
        </div>
      )}

      {showChat ? (
        <>
          <main className="thread">
            <div className="column">
              {items.map((message, index) => (
                <MessageView
                  key={index}
                  message={message}
                  results={results}
                  running={running}
                  streaming={message === streaming}
                />
              ))}
              {running && !streaming?.content.length && <Working />}
              {errors.map((error, index) => (
                <Banner key={index}>{error}</Banner>
              ))}
            </div>
          </main>
          <div className="dock">
            <div className="column">
              {!atBottom && (
                <button className="scroll-down" onClick={() => scrollToBottom("smooth")} title="Scroll to bottom">
                  <ArrowDown size={18} />
                </button>
              )}
              <div className="composer">
                <textarea
                  ref={textareaRef}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Message Pi…"
                  rows={1}
                  autoFocus
                />
                {running ? (
                  <button className="send stop" onClick={() => send({ type: "abort" })} title="Stop">
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button className="send" onClick={submit} disabled={!text.trim()} title="Send">
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
              <p className="hint">Enter to send · Shift+Enter for new line</p>
            </div>
          </div>
        </>
      ) : (
        <main className="welcome">
          <div className="welcome-inner">
            <h1>{greeting()}</h1>
            <p className="welcome-sub">Choose a project folder to start a session.</p>
            <form className="folder-card" onSubmit={onStart}>
              <Folder size={18} />
              <input
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="D:\Projects\my-app"
                disabled={!connected}
                autoFocus
              />
              <button type="submit" className="primary" disabled={!connected || !cwd.trim()}>
                Start
              </button>
            </form>
            {errors.map((error, index) => (
              <Banner key={index}>{error}</Banner>
            ))}
            {recent.length > 0 && (
              <section className="recent">
                <h2>Recent</h2>
                <ul>
                  {recent.map((path) => (
                    <li key={path}>
                      <button onClick={() => start(path)} disabled={!connected} title={path}>
                        <Folder size={16} />
                        <span className="recent-name">{folderName(path)}</span>
                        <span className="recent-path">{path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {session && (
              <button className="link" onClick={() => setPicking(false)}>
                <ArrowLeft size={14} />
                Back to session
              </button>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
