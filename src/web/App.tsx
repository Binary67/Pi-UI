import { ArrowDown, ArrowLeft, CornerLeftUp, Folder, ListTodo, Menu, SquarePen, Workflow } from "lucide-react";
import { type ChangeEvent, type FormEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { AgentMessage } from "../shared/chat-state.ts";
import type { Project, PromptImage, SessionSnapshot, UsageDay } from "../shared/protocol.ts";
import { Composer, TOUCH, scrollToBottom } from "./Composer.tsx";
import { createDraft } from "./composerDraft.ts";
import { Dashboard } from "./Dashboard.tsx";
import { groupTurns } from "./groupTurns.ts";
import { Banner, MessageView, Skeleton, type ToolResults, WorkGroup, Working } from "./Message.tsx";
import { SessionFooter } from "./SessionFooter.tsx";
import { Settings } from "./Settings.tsx";
import { folderName, Sidebar } from "./Sidebar.tsx";
import { TaskBoard } from "./TaskBoard.tsx";
import { useServerConnection, VIEW_KEY } from "./useServerConnection.ts";

/** Distance in pixels from the page bottom that still counts as "at the bottom". */
const BOTTOM_SLACK = 80;
function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function isAtBottom(): boolean {
  const root = document.documentElement;
  return root.scrollHeight - root.scrollTop - root.clientHeight < BOTTOM_SLACK;
}

export function App() {
  const [draft] = useState(createDraft);
  const [cwd, setCwd] = useState("");
  /** The paths of the projects that show their sessions. All projects start collapsed. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The session files of the orchestrators that show their task sessions. All orchestrators start folded. */
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  /** True when the sidebar shows as a drawer over the page, on a narrow screen. */
  const [drawer, setDrawer] = useState(false);
  /** True when the task board shows as a drawer, on a medium or narrow screen. */
  const [board, setBoard] = useState(false);
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  /** The start screen shows to choose a folder for a new session. */
  const [picking, setPicking] = useState(false);
  /** The settings page or the dashboard shows. It replaces the chat and the start screen. */
  const [page, setPage] = useState<"settings" | "dashboard" | null>(null);
  /** The usage of the last 30 days. Null while the page waits for the server. */
  const [usage, setUsage] = useState<UsageDay[] | null>(null);
  // A saved session opens at once. The skeleton shows until it opens, so the welcome screen does not flash.
  const [loading, setLoading] = useState(() => localStorage.getItem(VIEW_KEY) !== null);
  const [errors, setErrors] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const running = session?.state.running ?? false;
  const showChat = session && !picking && page === null && !loading;

  const { send, socketRef, connected, remoteUrl, listing, projects, statuses, tasks, branchState, subagent } =
    useServerConnection({ draft, setSession, setLoading, setErrors, setPicking, setCwd, setUsage });

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

  // Follow new content only when the reader is already at the bottom. The scroll comes before the paint, so the new
  // content does not show first at the old position. It comes after the composer height, which changes the page height.
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom("instant");
  }, [session, errors, atBottom]);

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
      confirm("Tasks of the orchestrator are still running or in review. Their unfinished work will be lost. Continue?")
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

  // As with the TUI `/fork`, the text and images of the message replace the composer content.
  const sessionFile = session?.file;
  const fork = useCallback(
    (timestamp: number, forkText: string, forkImages: PromptImage[]) => {
      if (!sessionFile) return;
      send({ type: "fork", file: sessionFile, timestamp });
      // The new session opens with the content. The draft of this session stays.
      draft.holdFork(sessionFile, forkText, forkImages);
    },
    [sessionFile],
  );

  const messages = session?.state.messages ?? [];
  const streaming = session?.state.streaming ?? null;
  const queued = session
    ? [
        ...session.state.steering.map((text) => ({ kind: "Steering", text })),
        ...session.state.followUp.map((text) => ({ kind: "Follow-up", text })),
      ]
    : [];
  // One list, so a streamed message keeps its element when it completes.
  const items = useMemo(() => (streaming ? [...messages, streaming] : messages), [messages, streaming]);
  const turns = useMemo(() => groupTurns(items, running), [items, running]);
  // The messages array changes only on `message_end`, so the map stays the same while streaming.
  const sessionMessages = session?.state.messages;
  const results = useMemo(() => {
    const map: ToolResults = new Map();
    for (const message of sessionMessages ?? []) {
      if (message.role === "toolResult") map.set(message.toolCallId, message);
    }
    return map;
  }, [sessionMessages]);
  // The orchestrator that the page shows, or the orchestrator of the subagent session that the page shows.
  const orchestrator =
    session &&
    projects
      .find((project) => project.path === session.cwd)
      ?.orchestrators.find(
        (item) => item.file === session.file || tasks[item.file]?.some((task) => task.file === session.file),
      );
  const taskSession =
    session && Object.values(tasks).some((list) => list.some((task) => task.file === session.file));
  // The server rejects a fork of an orchestrator or a task session.
  const canFork = session && orchestrator?.file !== session.file && !taskSession;
  const view = (message: AgentMessage, index: number) => (
    <MessageView
      key={index}
      message={message}
      results={results}
      running={running}
      streaming={message === streaming}
      onFork={canFork ? fork : undefined}
    />
  );
  // The keys stay the item indexes, so the final answer keeps its element when the turn collapses.
  const thread: ReactNode[] = [];
  for (const { start, messages: turn, work } of turns) {
    if (work) {
      const { first, last, tools, duration } = work;
      thread.push(
        ...turn.slice(0, first).map((message, index) => view(message, start + index)),
        <WorkGroup key={`work-${start}`} duration={duration} tools={tools}>
          {turn.slice(first, last).map((message, index) => view(message, start + first + index))}
        </WorkGroup>,
        ...turn.slice(last).map((message, index) => view(message, start + last + index)),
      );
    } else {
      thread.push(...turn.map((message, index) => view(message, start + index)));
    }
  }

  const orchestratorTasks = (orchestrator && tasks[orchestrator.file]) || [];
  // The task board shows with the orchestrator, and with the subagent sessions of its tasks.
  const showBoard = showChat && orchestrator;

  const branch = session && branchState?.file === session.file ? branchState.branch : null;
  // The texts are the same as the texts of the server.
  const sessionProject = session && projects.find((item) => item.path === session.cwd);
  let branchBlock: string | null = null;
  if (session) {
    if (taskSession) {
      branchBlock = "A task session cannot switch the branch.";
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

  return (
    <div className="app">
      <Sidebar
        drawer={drawer}
        remoteUrl={remoteUrl}
        projects={projects}
        tasks={tasks}
        statuses={statuses}
        expanded={expanded}
        unfolded={unfolded}
        sessionFile={session?.file}
        sessionCwd={session?.cwd}
        send={send}
        onDashboard={openDashboard}
        onSettings={openSettings}
        onPick={pick}
        onStart={start}
        onStartOrchestrator={startOrchestrator}
        onOpenSession={openSession}
        onToggleProject={toggleProject}
        onToggleOrchestrator={toggleOrchestrator}
        onRemoveProject={removeProject}
        onRemoveOrchestrator={removeOrchestrator}
      />
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
              <span>{sessionProject?.name ?? folderName(session.cwd)}</span>
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
          <Settings subagent={subagent} send={send} onBack={session ? () => setPage(null) : undefined} />
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
                <Composer
                  draft={draft}
                  connected={connected}
                  running={running}
                  sessionFile={session.file}
                  atBottom={atBottom}
                  socketRef={socketRef}
                  send={send}
                  onError={(message) => setErrors((current) => [...current, message])}
                />
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
                  placeholder="~/Projects/my-app"
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
