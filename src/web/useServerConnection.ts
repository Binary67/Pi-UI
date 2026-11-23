import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { applyEvent } from "../shared/chat-state.ts";
import type {
  BranchInfo,
  ClientMessage,
  FolderListing,
  ModelChoice,
  ModelRef,
  Project,
  ServerMessage,
  SessionSnapshot,
  SessionStatus,
  TaskSummary,
  UsageDay,
} from "../shared/protocol.ts";
import type { ComposerDraft } from "./composerDraft.ts";

/** The session that this browser shows. A reconnect or a reload opens it again. */
export const VIEW_KEY = "pi-ui:session";
/** The wait before the first reconnect. Each failed attempt doubles it, up to the maximum. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
/** The time between two pings. A socket that receives no message within PONG_TIMEOUT_MS of a ping is dead. */
const PING_MS = 15000;
const PONG_TIMEOUT_MS = 5000;

/**
 * The state that `App` also changes. The hook gets it as setters, which never change, so the socket handlers
 * never see an old value. The state that only the socket changes belongs to the hook.
 */
type Shared = {
  draft: ComposerDraft;
  setSession: Dispatch<SetStateAction<SessionSnapshot | null>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setErrors: Dispatch<SetStateAction<string[]>>;
  setPicking: Dispatch<SetStateAction<boolean>>;
  setCwd: Dispatch<SetStateAction<string>>;
  setUsage: Dispatch<SetStateAction<UsageDay[] | null>>;
};

/** The socket to the server, with its reconnect, and the data that the server sends. */
export function useServerConnection({ draft, setSession, setLoading, setErrors, setPicking, setCwd, setUsage }: Shared) {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  /** The tasks of each orchestrator, by the session file of the orchestrator. */
  const [tasks, setTasks] = useState<Record<string, TaskSummary[]>>({});
  /** The last `branch` message. It counts only while the page shows the session of its file. */
  const [branchState, setBranchState] = useState<{ file: string; branch: BranchInfo | null } | null>(null);
  /** The last `subagent` message: the subagent choice and the model list. */
  const [subagent, setSubagent] = useState<{ choice: ModelChoice; models: ModelRef[] } | null>(null);

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
          try {
            const { cwd, file } = JSON.parse(view) as { cwd: string; file: string };
            send({ type: "start", cwd, file });
          } catch {
            // A corrupt saved view must not stop the ping timer.
            localStorage.removeItem(VIEW_KEY);
          }
        }
        pingTimer = setInterval(ping, PING_MS);
      };
      socket.onclose = reconnect;
      socket.onmessage = (message) => {
        // Each message shows that the socket is alive, also a large one that arrives after the ping.
        clearTimeout(pongTimer);
        pongTimer = undefined;
        let data: ServerMessage;
        try {
          data = JSON.parse(message.data) as ServerMessage;
        } catch {
          return;
        }
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
              draft.open(data.session.file);
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
          case "subagent":
            setSubagent({ choice: data.choice, models: data.models });
            break;
          case "branch":
            setBranchState({ file: data.file, branch: data.branch });
            break;
          case "restore":
            draft.setText((current) => [data.text, current].filter((part) => part.trim()).join("\n\n"), data.file);
            break;
          case "transcript":
            {
              // The transcript has no file. It belongs to the session that sent the oldest recording.
              const file = draft.takeTranscript();
              if (file !== undefined) draft.setText((current) => [current, data.text].filter((part) => part.trim()).join(" "), file);
            }
            break;
          case "usage":
            setUsage(data.days);
            break;
          case "error":
            setErrors((current) => [...current, data.message]);
            setLoading(false);
            draft.dropTranscripts();
            // A failed fork opens no session. Its content must not go to a later session.
            draft.dropFork();
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
      draft.dropTranscripts();
      draft.dropFork();
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

  function send(message: ClientMessage) {
    socketRef.current?.send(JSON.stringify(message));
  }

  return { send, socketRef, connected, remoteUrl, listing, projects, statuses, tasks, branchState, subagent };
}
