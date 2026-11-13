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
  SquarePen,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type AgentMessage, applyEvent } from "../shared/chat-state.ts";
import type {
  ClientMessage,
  FolderListing,
  Project,
  PromptImage,
  ServerMessage,
  SessionSnapshot,
  SessionStatus,
  StreamingBehavior,
} from "../shared/protocol.ts";
import { Banner, MessageView, Skeleton, type ToolResults, WorkGroup, Working } from "./Message.tsx";
import { SessionFooter } from "./SessionFooter.tsx";

/** Distance in pixels from the page bottom that still counts as "at the bottom". */
const BOTTOM_SLACK = 80;
const COMPOSER_MAX_HEIGHT = 200;
/** The session that this tab shows. A reload of the tab opens it again. */
const VIEW_KEY = "pi-ui:session";
/** The image types that Pi accepts in a prompt. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** The wait before the first reconnect. Each failed attempt doubles it, up to the maximum. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;

function readImage(file: File): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve({ type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [picking, setPicking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const running = session?.state.running ?? false;

  useEffect(() => {
    let socket: WebSocket;
    let delay = RECONNECT_MIN_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      socket = new WebSocket(`ws://${location.host}/ws`);
      socket.onopen = () => {
        // Only an open socket sends. Clicks while the socket connects go to the closed one and are dropped.
        socketRef.current = socket;
        delay = RECONNECT_MIN_MS;
        setConnected(true);
        send({ type: "list_folders", path: "" });
        const view = sessionStorage.getItem(VIEW_KEY);
        if (view) {
          const { cwd, file } = JSON.parse(view) as { cwd: string; file: string };
          send({ type: "start", cwd, file });
        }
      };
      socket.onclose = () => {
        setConnected(false);
        setSession(null);
        setProjects([]);
        setStatuses({});
        setLoading(false);
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
      socket.onmessage = (message) => {
        const data = JSON.parse(message.data) as ServerMessage;
        switch (data.type) {
          case "snapshot":
            setSession(data.session);
            setErrors([]);
            setLoading(false);
            if (data.session) {
              setPicking(false);
              sessionStorage.setItem(VIEW_KEY, JSON.stringify({ cwd: data.session.cwd, file: data.session.file }));
            } else {
              sessionStorage.removeItem(VIEW_KEY);
            }
            break;
          case "starting":
            setLoading(true);
            break;
          case "projects":
            setProjects(data.projects);
            break;
          case "status":
            setStatuses(data.sessions);
            break;
          case "folders":
            setListing(data.listing);
            // An empty input asked for the home folder. Show its path there.
            setCwd((current) => current || data.listing.path);
            break;
          case "event":
            setSession((current) =>
              current?.file === data.file ? { ...current, state: applyEvent(current.state, data.event) } : current,
            );
            break;
          case "info":
            setSession((current) => (current?.file === data.file ? { ...current, info: data.info } : current));
            break;
          case "restore":
            setText((current) => [data.text, current].filter((part) => part.trim()).join("\n\n"));
            break;
          case "error":
            setErrors((current) => [...current, data.message]);
            setLoading(false);
            break;
        }
      };
    }

    connect();
    return () => {
      clearTimeout(timer);
      socket.onclose = null;
      socket.close();
    };
  }, []);

  useEffect(() => {
    const onScroll = () => setAtBottom(isAtBottom());
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Esc stops the run, as in the TUI. A menu that closes on Esc handles the key first and prevents the default.
  const runningFile = running ? session?.file : undefined;
  useEffect(() => {
    if (!runningFile) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) send({ type: "abort", file: runningFile });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runningFile]);

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

  function submit(streamingBehavior: StreamingBehavior) {
    if (!session || (!text.trim() && !images.length)) return;
    send({ type: "prompt", file: session.file, text, images, streamingBehavior });
    setText("");
    setImages([]);
  }

  // Pasted images become attachments. A paste without images inserts its text as usual.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) => IMAGE_TYPES.has(file.type));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(readImage)).then((added) => setImages((current) => [...current, ...added]));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(event.altKey ? "followUp" : "steer");
    }
  }

  const showChat = session && !picking && !loading;
  const messages = session?.state.messages ?? [];
  const streaming = session?.state.streaming ?? null;
  const queued = session
    ? [
        ...session.state.steering.map((text) => ({ kind: "Steering", text })),
        ...session.state.followUp.map((text) => ({ kind: "Follow-up", text })),
      ]
    : [];
  // One list, so a streamed message keeps its element when it completes.
  const items = streaming ? [...messages, streaming] : messages;
  const results: ToolResults = new Map();
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  const view = (message: AgentMessage, index: number) => (
    <MessageView key={index} message={message} results={results} running={running} streaming={message === streaming} />
  );
  // Each user message starts a turn. A done turn shows its steps in one collapsed group, then the final answer.
  // The keys stay the item indexes, so the final answer keeps its element when the turn collapses.
  const thread: ReactNode[] = [];
  for (let start = 0, end = 0; start < items.length; start = end) {
    end = start + 1;
    while (end < items.length && items[end].role !== "user") end++;
    const turn = items.slice(start, end);
    const first = turn[0].role === "user" ? 1 : 0;
    const last = turn.findLastIndex((message) => message.role === "assistant");
    const final = turn[last];
    if (
      !(running && end === items.length) &&
      last > first &&
      final.role === "assistant" &&
      final.stopReason === "stop" &&
      final.content.some((block) => block.type === "text" && block.text.trim())
    ) {
      const steps = turn.slice(first, last);
      const tools = steps.flatMap((message) =>
        message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
      ).length;
      thread.push(
        ...turn.slice(0, first).map((message, index) => view(message, start + index)),
        <WorkGroup
          key={`work-${start}`}
          duration={final.timestamp + (final.durationMs ?? 0) - turn[0].timestamp}
          tools={tools}
        >
          {steps.map((message, index) => view(message, start + first + index))}
        </WorkGroup>,
        ...turn.slice(last).map((message, index) => view(message, start + last + index)),
      );
    } else {
      thread.push(...turn.map((message, index) => view(message, start + index)));
    }
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
              {project.path !== session?.cwd && !project.sessions.some((item) => statuses[item.file] === "running") && (
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
                const status = statuses[item.file];
                return (
                  <li key={item.file} className={active ? "session-row active" : "session-row"}>
                    <button
                      className="session-open"
                      onClick={() => (active ? setPicking(false) : start(project.path, item.file))}
                      title={item.title}
                    >
                      <span
                        className={
                          status === "running" ? "session-title shimmer" : status ? "session-title" : "session-title cold"
                        }
                      >
                        {item.title}
                      </span>
                    </button>
                    <span className="session-status">
                      {status !== "running" && (
                        <>
                          <button
                            className="row-action"
                            onClick={() => send({ type: "remove_session", file: item.file })}
                            title="Remove session"
                          >
                            <X size={14} />
                          </button>
                          {item.unread && <span className="unread-dot" />}
                        </>
                      )}
                    </span>
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
              Not connected. Reconnecting… If the server is not running, run <code>npm run dev:server</code>.
            </Banner>
          </div>
        )}

        {loading ? (
          <Skeleton />
        ) : showChat ? (
          <>
            <main className="thread">
              <div className="column">
                {thread}
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
                {queued.length > 0 && (
                  <ul className="queue">
                    {queued.map((item, index) => (
                      <li key={index}>
                        <span className="queue-kind">{item.kind}</span>
                        <span className="queue-text">{item.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="composer">
                  {images.length > 0 && (
                    <div className="attachments">
                      {images.map((image, index) => (
                        <div key={index} className="attachment">
                          <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                          <button
                            className="attachment-remove"
                            onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                            title="Remove image"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    placeholder="Message Pi…"
                    rows={1}
                    autoFocus
                  />
                  <button
                    className="send"
                    onClick={() => submit("steer")}
                    disabled={!text.trim() && !images.length}
                    title="Send"
                  >
                    <ArrowUp size={18} />
                  </button>
                </div>
                <SessionFooter
                  info={session.info}
                  disabled={running}
                  onSetModel={(model) =>
                    send({ type: "set_model", file: session.file, provider: model.provider, modelId: model.id })
                  }
                  onSetThinkingLevel={(level) => send({ type: "set_thinking_level", file: session.file, level })}
                />
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
