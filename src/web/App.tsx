import {
  ArrowDown,
  ArrowLeft,
  Bot,
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderPlus,
  LayoutDashboard,
  ListTodo,
  Menu,
  Pi,
  Puzzle,
  Settings as SettingsIcon,
  SquarePen,
  Workflow,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type AgentMessage, applyEvent } from "../shared/chat-state.ts";
import type {
  BranchInfo,
  ClientMessage,
  FolderListing,
  Project,
  PromptImage,
  ServerMessage,
  SessionSnapshot,
  SessionSummary,
  SessionStatus,
  StreamingBehavior,
  TaskSummary,
  UsageDay,
} from "../shared/protocol.ts";
import { Dashboard } from "./Dashboard.tsx";
import { Banner, MessageView, Skeleton, type ToolResults, WorkGroup, Working } from "./Message.tsx";
import { MicButton } from "./MicButton.tsx";
import { Remote } from "./Remote.tsx";
import { SendButton } from "./SendButton.tsx";
import { SessionFooter } from "./SessionFooter.tsx";
import { Settings } from "./Settings.tsx";
import { TaskBoard } from "./TaskBoard.tsx";

/** Distance in pixels from the page bottom that still counts as "at the bottom". */
const BOTTOM_SLACK = 80;
const COMPOSER_MAX_HEIGHT = 200;
/** The session that this browser shows. A reconnect or a reload opens it again. */
const VIEW_KEY = "pi-ui:session";
/** The image types that Pi accepts in a prompt. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** The wait before the first reconnect. Each failed attempt doubles it, up to the maximum. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
/** The time between two pings. A socket that receives no message within PONG_TIMEOUT_MS of a ping is dead. */
const PING_MS = 15000;
const PONG_TIMEOUT_MS = 5000;
/** True on a touch screen. Enter then adds a new line, and no field takes the focus by itself. */
const TOUCH = matchMedia("(hover: none), (any-pointer: coarse)").matches;

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

/** A user message or a task update for the orchestrator starts a turn. */
function startsTurn(message: AgentMessage): boolean {
  return message.role === "user" || (message.role === "custom" && message.customType === "task_update");
}

function titleClass(status: SessionStatus | undefined): string {
  return status === "running" ? "session-title shimmer" : status ? "session-title" : "session-title cold";
}

export function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [connected, setConnected] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  /** The paths of the projects that show their sessions. All projects start collapsed. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The session files of the orchestrators that show their task sessions. All orchestrators start folded. */
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  /** True when the sidebar shows as a drawer over the page, on a narrow screen. */
  const [drawer, setDrawer] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  /** The tasks of each orchestrator, by the session file of the orchestrator. */
  const [tasks, setTasks] = useState<Record<string, TaskSummary[]>>({});
  /** True when the task board shows as a drawer, on a medium or narrow screen. */
  const [board, setBoard] = useState(false);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  /** The last `branch` message. It counts only while the page shows the session of its file. */
  const [branchState, setBranchState] = useState<{ file: string; branch: BranchInfo | null } | null>(null);
  /** The start screen shows to choose a folder for a new session. */
  const [picking, setPicking] = useState(false);
  /** The settings page or the dashboard shows. It replaces the chat and the start screen. */
  const [page, setPage] = useState<"settings" | "dashboard" | null>(null);
  /** The usage of the last 30 days. Null while the page waits for the server. */
  const [usage, setUsage] = useState<UsageDay[] | null>(null);
  // A saved session opens at once. The skeleton shows until it opens, so the welcome screen does not flash.
  const [loading, setLoading] = useState(() => localStorage.getItem(VIEW_KEY) !== null);
  const [errors, setErrors] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  /** True while the page waits for the transcript of a voice recording. */
  const [transcribing, setTranscribing] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const running = session?.state.running ?? false;
  const showChat = session && !picking && page === null && !loading;

  useEffect(() => {
    let socket: WebSocket;
    let delay = RECONNECT_MIN_MS;
    /** The next reconnect. Undefined while a socket connects or is open. */
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    /** The wait for an answer to the last ping. */
    let pongTimer: ReturnType<typeof setTimeout> | undefined;
    /** The event messages that wait for the next animation frame, and the scheduled frame. */
    let queue: Extract<ServerMessage, { type: "event" }>[] = [];
    let frame: number | undefined;

    /** Apply the queued events in one state update. */
    function flush() {
      frame = undefined;
      const events = queue;
      queue = [];
      setSession((current) => {
        if (!current) return current;
        let state = current.state;
        for (const { file, event } of events) if (file === current.file) state = applyEvent(state, event);
        return state === current.state ? current : { ...current, state };
      });
    }

    /** Drop the queued events and the scheduled frame. */
    function dropQueue() {
      queue = [];
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    }

    function connect() {
      timer = undefined;
      // An HTTPS page, such as the tailnet URL, must use a secure socket.
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      socket.onopen = () => {
        // Only an open socket sends. Clicks while the socket connects are dropped.
        socketRef.current = socket;
        delay = RECONNECT_MIN_MS;
        setConnected(true);
        send({ type: "list_folders", path: "" });
        const view = localStorage.getItem(VIEW_KEY);
        if (view) {
          const { cwd, file } = JSON.parse(view) as { cwd: string; file: string };
          send({ type: "start", cwd, file });
        }
        pingTimer = setInterval(ping, PING_MS);
      };
      socket.onclose = reconnect;
      socket.onmessage = (message) => {
        // Each message shows that the socket is alive, also a large one that arrives after the ping.
        clearTimeout(pongTimer);
        pongTimer = undefined;
        const data = JSON.parse(message.data) as ServerMessage;
        switch (data.type) {
          case "remote":
            setRemoteUrl(data.url);
            break;
          case "snapshot":
            // The snapshot has the queued events already.
            dropQueue();
            setSession(data.session);
            setErrors([]);
            setLoading(false);
            if (data.session) {
              setPicking(false);
              localStorage.setItem(VIEW_KEY, JSON.stringify({ cwd: data.session.cwd, file: data.session.file }));
            } else {
              localStorage.removeItem(VIEW_KEY);
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
          case "tasks":
            setTasks(data.tasks);
            break;
          case "folders":
            setListing(data.listing);
            // An empty input asked for the home folder. Show its path there.
            setCwd((current) => current || data.listing.path);
            break;
          case "event":
            queue.push(data);
            frame ??= requestAnimationFrame(flush);
            break;
          case "info":
            setSession((current) => (current?.file === data.file ? { ...current, info: data.info } : current));
            break;
          case "branch":
            setBranchState({ file: data.file, branch: data.branch });
            break;
          case "restore":
            setText((current) => [data.text, current].filter((part) => part.trim()).join("\n\n"));
            break;
          case "transcript":
            setText((current) => [current, data.text].filter((part) => part.trim()).join(" "));
            setTranscribing(false);
            break;
          case "usage":
            setUsage(data.days);
            break;
          case "error":
            setErrors((current) => [...current, data.message]);
            setLoading(false);
            setTranscribing(false);
            break;
        }
      };
    }

    /** Ask the server for a pong. A dead socket can still show as open, so only the answer shows that it is alive. */
    function ping() {
      if (pongTimer) return;
      socket.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
      pongTimer = setTimeout(reconnect, PONG_TIMEOUT_MS);
    }

    /** Drop the socket and connect again after the delay. The page shows its last data until the new socket opens. */
    function reconnect() {
      // A dead socket can send its close event much later. It must not start a second reconnect then.
      socket.onopen = socket.onclose = socket.onmessage = null;
      socket.close();
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      pongTimer = undefined;
      dropQueue();
      socketRef.current = null;
      setConnected(false);
      setLoading(false);
      // The transcript of a recording is lost with the socket.
      setTranscribing(false);
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }

    // A phone can drop the socket while the page is hidden, and the timers of a hidden page wait. When the page shows
    // again or the network comes back, check an open socket now, and connect now instead of after the delay.
    function resume() {
      if (document.hidden) return;
      if (socket.readyState === WebSocket.OPEN) return ping();
      if (timer === undefined) return;
      clearTimeout(timer);
      delay = RECONNECT_MIN_MS;
      connect();
    }

    connect();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", resume);
      clearTimeout(timer);
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      dropQueue();
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

  // The keyboard of the composer shrinks the page. A reader at the bottom stays at the bottom, above the composer.
  useEffect(() => {
    if (!atBottom) return;
    const onResize = () => {
      if (document.activeElement === textareaRef.current) scrollToBottom("instant");
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [atBottom]);

  // Grow the composer with its text, up to a limit. Only a change of the text, or a new composer, changes its height.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [text, showChat]);

  // Follow new content only when the reader is already at the bottom. The scroll comes before the paint, so the new
  // content does not show first at the old position. It comes after the composer height, which changes the page height.
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom("instant");
  }, [session, errors, atBottom]);

  function send(message: ClientMessage) {
    socketRef.current?.send(JSON.stringify(message));
  }

  function start(path: string, file?: string) {
    setErrors([]);
    setPage(null);
    setDrawer(false);
    send({ type: "start", cwd: path.trim(), file });
  }

  /**
   * Show the empty orchestrator of the project in `path`, or a new one when it has none. The other orchestrators of
   * the project stay.
   */
  function startOrchestrator(path: string) {
    setErrors([]);
    setPage(null);
    setDrawer(false);
    setBoard(false);
    send({ type: "orchestrator", cwd: path.trim() });
  }

  /**
   * True when the orchestrators in `files` have no running task and no task in review, or the user agrees to lose their
   * work.
   */
  function confirmDrop(files: string[]): boolean {
    const active = files.some((file) =>
      (tasks[file] ?? []).some((task) => task.status === "running" || task.status === "review"),
    );
    return (
      !active ||
      confirm("Tasks of the orchestrator are still running or in review. Their unmerged work will be lost. Continue?")
    );
  }

  /** Remove the orchestrator in `file`. It and the sessions of its tasks leave the sidebar. */
  function removeOrchestrator(file: string) {
    if (confirmDrop([file])) send({ type: "remove_session", file });
  }

  function removeProject(project: Project) {
    if (!confirmDrop(project.orchestrators.map((item) => item.file))) return;
    send({ type: "remove_project", path: project.path });
  }

  /** Show the session in `file`, or go back to it when the page already shows it. */
  function openSession(path: string, file: string) {
    setBoard(false);
    if (file !== session?.file) return start(path, file);
    setPicking(false);
    setPage(null);
    setDrawer(false);
  }

  function pick() {
    setCwd("");
    setPicking(true);
    setPage(null);
    setDrawer(false);
    send({ type: "list_folders", path: "" });
  }

  function openSettings() {
    setPage("settings");
    setPicking(false);
    setDrawer(false);
    setBoard(false);
  }

  function openDashboard() {
    setPage("dashboard");
    setUsage(null);
    setPicking(false);
    setDrawer(false);
    setBoard(false);
    send({ type: "get_usage" });
  }

  function toggleProject(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  function toggleOrchestrator(file: string) {
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(file)) next.add(file);
      return next;
    });
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
    // Offline, the text stays in the composer.
    if (!connected || !session || (!text.trim() && !images.length)) return;
    send({ type: "prompt", file: session.file, text, images, streamingBehavior });
    setText("");
    setImages([]);
  }

  // As with the TUI `/fork`, the text and images of the message replace the composer content.
  const sessionFile = session?.file;
  const fork = useCallback(
    (timestamp: number, forkText: string, forkImages: PromptImage[]) => {
      if (!sessionFile) return;
      send({ type: "fork", file: sessionFile, timestamp });
      setText(forkText);
      setImages(forkImages);
    },
    [sessionFile],
  );

  // Pasted images become attachments. A paste without images inserts its text as usual.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) => IMAGE_TYPES.has(file.type));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(readImage)).then((added) => setImages((current) => [...current, ...added]));
  }

  // On a touch screen, Enter adds a new line, and the send button sends.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !TOUCH) {
      event.preventDefault();
      submit(event.altKey ? "followUp" : "steer");
    }
  }

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
  // The messages array changes only on `message_end`, so the map stays the same while streaming.
  const sessionMessages = session?.state.messages;
  const results = useMemo(() => {
    const map: ToolResults = new Map();
    for (const message of sessionMessages ?? []) {
      if (message.role === "toolResult") map.set(message.toolCallId, message);
    }
    return map;
  }, [sessionMessages]);
  const view = (message: AgentMessage, index: number) => (
    <MessageView
      key={index}
      message={message}
      results={results}
      running={running}
      streaming={message === streaming}
      onFork={fork}
    />
  );
  // Each user message starts a turn. A done turn shows its steps in one collapsed group, then the final answer.
  // The keys stay the item indexes, so the final answer keeps its element when the turn collapses.
  const thread: ReactNode[] = [];
  for (let start = 0, end = 0; start < items.length; start = end) {
    end = start + 1;
    while (end < items.length && !startsTurn(items[end])) end++;
    const turn = items.slice(start, end);
    const first = startsTurn(turn[0]) ? 1 : 0;
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

  // The orchestrator that the page shows, or the orchestrator of the subagent session that the page shows.
  const orchestrator =
    session &&
    projects
      .find((project) => project.path === session.cwd)
      ?.orchestrators.find(
        (item) => item.file === session.file || tasks[item.file]?.some((task) => task.file === session.file),
      );
  const orchestratorTasks = (orchestrator && tasks[orchestrator.file]) || [];
  // The task board shows with the orchestrator, and with the subagent sessions of its tasks.
  const showBoard = showChat && orchestrator;

  const branch = session && branchState?.file === session.file ? branchState.branch : null;
  // The texts are the same as the texts of the server.
  const sessionProject = session && projects.find((item) => item.path === session.cwd);
  let branchBlock: string | null = null;
  if (session) {
    if (Object.values(tasks).some((list) => list.some((task) => task.file === session.file))) {
      branchBlock = "A task session stays on its task branch.";
    } else if (
      sessionProject &&
      [...sessionProject.sessions, ...sessionProject.orchestrators].some((item) => statuses[item.file] === "running")
    ) {
      branchBlock = "A session of this project is running. Wait until it ends.";
    } else if (
      sessionProject?.orchestrators.some((item) =>
        (tasks[item.file] ?? []).some((task) => task.status === "running" || task.status === "review"),
      )
    ) {
      branchBlock = "An orchestrator of this project has tasks that are running or in review. Finish or cancel them first.";
    }
  }

  /** The row of a session in the sidebar, for a normal session and for a task session of an orchestrator. */
  function sessionRow(project: Project, item: SessionSummary) {
    const status = statuses[item.file];
    return (
      <li key={item.file} className={item.file === session?.file ? "session-row active" : "session-row"}>
        <button className="session-open" onClick={() => openSession(project.path, item.file)} title={item.title}>
          <span className={titleClass(status)}>{item.title}</span>
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
  }

  return (
    <div className="app">
      <aside className={drawer ? "sidebar open" : "sidebar"}>
        <div className="sidebar-body">
          <div className="brand">
            <span className="brand-mark">
              <Pi size={16} />
            </span>
            Pi
          </div>
          <Remote url={remoteUrl} />
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
          <button className="nav-item" onClick={openDashboard}>
            <LayoutDashboard size={16} />
            Dashboard
          </button>
          <div className="sidebar-heading">
            <span className="project-name">Projects</span>
            <button className="row-action" onClick={pick} title="Add project">
              <FolderPlus size={14} />
            </button>
          </div>
          {projects.map((project) => {
            // The session files of the tasks of all orchestrators. They show under their orchestrator.
            const taskFiles = new Set(
              project.orchestrators.flatMap((item) => (tasks[item.file] ?? []).flatMap((task) => task.file ?? [])),
            );
            return (
              <section key={project.path} className="project">
                <div className="project-row" title={project.path}>
                  <button className="project-toggle" onClick={() => toggleProject(project.path)}>
                    {expanded.has(project.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="project-name">{folderName(project.path)}</span>
                  </button>
                  {project.path !== session?.cwd &&
                    !project.sessions.some((item) => statuses[item.file] === "running") &&
                    !project.orchestrators.some((item) => statuses[item.file] === "running") && (
                      <button className="row-action" onClick={() => removeProject(project)} title="Remove project">
                        <X size={14} />
                      </button>
                    )}
                  <button
                    className="row-action new-orchestrator"
                    onClick={() => startOrchestrator(project.path)}
                    title="New orchestrator"
                  >
                    <Workflow size={14} />
                  </button>
                  <button className="row-action new-session" onClick={() => start(project.path)} title="New session">
                    <SquarePen size={14} />
                  </button>
                </div>
                {expanded.has(project.path) && (
                  <ul className="sessions">
                    {project.orchestrators.map((item) => {
                      // The task sessions of the orchestrator, in task start order. A task without a session has no row.
                      const children = (tasks[item.file] ?? []).flatMap((task) => {
                        const child = project.sessions.find((entry) => entry.file === task.file);
                        return child ? [child] : [];
                      });
                      // The orchestrator also shows its children while the page shows one of them.
                      const open = unfolded.has(item.file) || children.some((child) => child.file === session?.file);
                      return (
                        <Fragment key={item.file}>
                          <li className={item.file === session?.file ? "session-row active" : "session-row"}>
                            {children.length > 0 ? (
                              <button
                                className="session-toggle"
                                onClick={() => toggleOrchestrator(item.file)}
                                title={open ? "Fold tasks" : "Unfold tasks"}
                              >
                                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            ) : (
                              <span className="session-toggle" />
                            )}
                            <button
                              className="session-open"
                              onClick={() => openSession(project.path, item.file)}
                              title={item.title}
                            >
                              <Workflow size={14} className="session-icon" />
                              <span className={titleClass(statuses[item.file])}>{item.title}</span>
                            </button>
                            <span className="session-status">
                              {statuses[item.file] !== "running" && (
                                <>
                                  <button
                                    className="row-action"
                                    onClick={() => removeOrchestrator(item.file)}
                                    title="Remove orchestrator"
                                  >
                                    <X size={14} />
                                  </button>
                                  {item.unread && <span className="unread-dot" />}
                                </>
                              )}
                            </span>
                          </li>
                          {open && children.length > 0 && (
                            <li className="session-group">
                              <ul className="sessions">{children.map((child) => sessionRow(project, child))}</ul>
                            </li>
                          )}
                        </Fragment>
                      );
                    })}
                    {project.sessions
                      .filter((item) => !taskFiles.has(item.file))
                      .map((item) => sessionRow(project, item))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        <button className="nav-item" onClick={openSettings}>
          <SettingsIcon size={16} />
          Settings
        </button>
      </aside>
      {drawer && <div className="backdrop" onClick={() => setDrawer(false)} />}

      <div className="main">
        <header className="header">
          <button className="icon-button menu-button" onClick={() => setDrawer(true)} title="Open sidebar">
            <Menu size={18} />
          </button>
          {loading && page === null && <span className="skeleton skeleton-chip" />}
          {showChat && (
            <span className="chip" title={session.cwd}>
              <Folder size={14} />
              <span>{folderName(session.cwd)}</span>
            </span>
          )}
          <div className="header-actions">
            {showBoard && (
              <button className="icon-button board-button" onClick={() => setBoard(true)} title="Show tasks">
                <ListTodo size={18} />
              </button>
            )}
            {showChat && orchestrator?.file === session.file && (
              <button className="icon-button" onClick={() => startOrchestrator(session.cwd)} title="New orchestrator">
                <Workflow size={18} />
              </button>
            )}
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

        {page === "settings" ? (
          <Settings onBack={session ? () => setPage(null) : undefined} />
        ) : page === "dashboard" ? (
          <Dashboard days={usage} onBack={session ? () => setPage(null) : undefined} />
        ) : loading ? (
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
                    autoFocus={!TOUCH}
                  />
                  <MicButton
                    disabled={!connected}
                    transcribing={transcribing}
                    onRecord={(audio, mimeType) => {
                      // `send` drops a message without an open socket. The recording can end after the socket closed.
                      if (!socketRef.current) {
                        setErrors((current) => [...current, "Not connected. The recording is lost."]);
                        return;
                      }
                      setTranscribing(true);
                      send({ type: "transcribe", audio, mimeType });
                    }}
                    onError={(message) => setErrors((current) => [...current, message])}
                  />
                  <SendButton
                    running={connected && running}
                    ready={connected && Boolean(text.trim() || images.length)}
                    onSend={() => submit("steer")}
                    onStop={() => send({ type: "abort", file: session.file })}
                  />
                </div>
                <SessionFooter
                  info={session.info}
                  disabled={running}
                  onSetModel={(model) =>
                    send({ type: "set_model", file: session.file, provider: model.provider, modelId: model.id })
                  }
                  onSetThinkingLevel={(level) => send({ type: "set_thinking_level", file: session.file, level })}
                  branch={branch}
                  branchBlock={branchBlock}
                  onListBranches={() => send({ type: "list_branches", file: session.file })}
                  onSwitchBranch={(name, create) =>
                    send({ type: "switch_branch", file: session.file, branch: name, create })
                  }
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
                  autoFocus={!TOUCH}
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

      {showBoard && (
        <TaskBoard
          tasks={orchestratorTasks}
          active={session.file}
          open={board}
          onOpen={(file) => openSession(session.cwd, file)}
          onClose={() => setBoard(false)}
          onOrchestrator={
            orchestrator.file === session.file ? undefined : () => openSession(session.cwd, orchestrator.file)
          }
        />
      )}
      {showBoard && board && <div className="board-backdrop" onClick={() => setBoard(false)} />}
    </div>
  );
}
