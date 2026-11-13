import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bot,
  CornerLeftUp,
  Folder,
  FolderPlus,
  Globe,
  Pi,
  Puzzle,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { applyEvent } from "../shared/chat-state.ts";
import type { ClientMessage, FolderListing, Project, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { Banner, MessageView, Skeleton, type ToolResults, Working } from "./Message.tsx";

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
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const running = session?.state.running ?? false;

  useEffect(() => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socket.onopen = () => {
      setConnected(true);
      send({ type: "list_folders", path: "" });
    };
    socket.onclose = () => {
      setConnected(false);
      setSession(null);
      setProjects([]);
      setLoading(false);
    };
    socket.onmessage = (message) => {
      const data = JSON.parse(message.data) as ServerMessage;
      switch (data.type) {
        case "snapshot":
          setSession(data.session);
          setErrors([]);
          setLoading(false);
          if (data.session) setPicking(false);
          break;
        case "starting":
          setLoading(true);
          break;
        case "projects":
          setProjects(data.projects);
          break;
        case "folders":
          setListing(data.listing);
          // An empty input asked for the home folder. Show its path there.
          setCwd((current) => current || data.listing.path);
          break;
        case "event":
          setSession((current) => current && { ...current, state: applyEvent(current.state, data.event) });
          break;
        case "error":
          setErrors((current) => [...current, data.message]);
          setLoading(false);
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

  function start(path: string, file?: string) {
    setErrors([]);
    send({ type: "start", cwd: path.trim(), file });
  }

  function addProject() {
    setCwd("");
    setPicking(true);
    send({ type: "list_folders", path: "" });
  }

  function browse(path: string) {
    setCwd(path);
    send({ type: "list_folders", path });
  }

  function onPathChange(event: ChangeEvent<HTMLInputElement>) {
    const path = event.target.value;
    setCwd(path);
    if (path.trim()) send({ type: "list_folders", path });
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

  const showChat = session && !picking && !loading;
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
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Pi size={16} />
          </span>
          Pi
        </div>
        <button className="nav-item" disabled>
          <Globe size={16} />
          Remote
          <span className="soon">Soon</span>
        </button>
        <button className="nav-item" disabled>
          <Puzzle size={16} />
          Plugins
          <span className="soon">Soon</span>
        </button>
        <button className="nav-item" disabled>
          <Bot size={16} />
          Bots
          <span className="soon">Soon</span>
        </button>
        <div className="sidebar-heading">
          <span className="project-name">Projects</span>
          <button className="row-action" onClick={addProject} title="Add project">
            <FolderPlus size={14} />
          </button>
        </div>
        {projects.map((project) => (
          <section key={project.path} className="project">
            <div className="project-row" title={project.path}>
              <span className="project-name">{folderName(project.path)}</span>
              <button className="row-action" onClick={() => start(project.path)} title="New session">
                <SquarePen size={14} />
              </button>
              {project.path !== session?.cwd && (
                <button
                  className="row-action"
                  onClick={() => send({ type: "remove_project", path: project.path })}
                  title="Remove project"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <ul className="sessions">
              {project.sessions.map((item) => {
                const active = item.file === session?.file;
                return (
                  <li key={item.file} className={active ? "session-row active" : "session-row"}>
                    <button
                      className="session-open"
                      onClick={() => (active ? setPicking(false) : start(project.path, item.file))}
                      title={item.title}
                    >
                      {item.title}
                    </button>
                    {!active && (
                      <button
                        className="row-action"
                        onClick={() => send({ type: "remove_session", file: item.file })}
                        title="Remove session"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </aside>

      <div className="main">
        <header className="header">
          {loading && <span className="skeleton skeleton-chip" />}
          {showChat && (
            <span className="chip" title={session.cwd}>
              <Folder size={14} />
              <span>{folderName(session.cwd)}</span>
            </span>
          )}
          <div className="header-actions">
            {showChat && (
              <button className="icon-button" onClick={() => start(session.cwd)} title="New session">
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

        {loading ? (
          <Skeleton />
        ) : showChat ? (
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
                  onChange={onPathChange}
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
              {connected && listing && (
                <ul className="folders">
                  {listing.parent !== listing.path && (
                    <li>
                      <button onClick={() => browse(listing.parent)} title={listing.parent}>
                        <CornerLeftUp size={16} />
                        <span>..</span>
                      </button>
                    </li>
                  )}
                  {listing.folders.map((folder) => (
                    <li key={folder.path}>
                      <button onClick={() => browse(folder.path)} title={folder.path}>
                        <Folder size={16} />
                        <span>{folder.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
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
    </div>
  );
}
