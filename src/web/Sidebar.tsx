import {
  Bot,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  LayoutDashboard,
  Pi,
  Puzzle,
  Settings as SettingsIcon,
  SquarePen,
  Workflow,
  X,
} from "lucide-react";
import { Fragment } from "react";
import type {
  ClientMessage,
  Project,
  SessionStatus,
  SessionSummary,
  TaskSummary,
} from "../shared/protocol.ts";
import { Remote } from "./Remote.tsx";

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function titleClass(status: SessionStatus | undefined): string {
  return status === "running" ? "session-title shimmer" : status ? "session-title" : "session-title cold";
}

type SidebarProps = {
  /** True when the sidebar shows as a drawer over the page, on a narrow screen. */
  drawer: boolean;
  remoteUrl: string | null;
  projects: Project[];
  /** The tasks of each orchestrator, by the session file of the orchestrator. */
  tasks: Record<string, TaskSummary[]>;
  statuses: Record<string, SessionStatus>;
  /** The paths of the projects that show their sessions. */
  expanded: Set<string>;
  /** The session files of the orchestrators that show their task sessions. */
  unfolded: Set<string>;
  /** The session that the page shows. */
  sessionFile: string | undefined;
  sessionCwd: string | undefined;
  send: (message: ClientMessage) => void;
  onDashboard: () => void;
  onSettings: () => void;
  onPick: () => void;
  onStart: (path: string, file?: string) => void;
  onStartOrchestrator: (path: string) => void;
  onOpenSession: (path: string, file: string) => void;
  onToggleProject: (path: string) => void;
  onToggleOrchestrator: (file: string) => void;
  onRemoveProject: (project: Project) => void;
  onRemoveOrchestrator: (file: string) => void;
};

export function Sidebar({
  drawer,
  remoteUrl,
  projects,
  tasks,
  statuses,
  expanded,
  unfolded,
  sessionFile,
  sessionCwd,
  send,
  onDashboard,
  onSettings,
  onPick,
  onStart,
  onStartOrchestrator,
  onOpenSession,
  onToggleProject,
  onToggleOrchestrator,
  onRemoveProject,
  onRemoveOrchestrator,
}: SidebarProps) {
  /** The row of a session in the sidebar, for a normal session and for a task session of an orchestrator. */
  function sessionRow(project: Project, item: SessionSummary) {
    const status = statuses[item.file];
    // The X of a task session is hidden while its task is running or in review.
    const activeTask = Object.values(tasks).some((list) =>
      list.some((task) => task.file === item.file && (task.status === "running" || task.status === "review")),
    );
    return (
      <li key={item.file} className={item.file === sessionFile ? "session-row active" : "session-row"}>
        <button className="session-open" onClick={() => onOpenSession(project.path, item.file)} title={item.title}>
          <span className={titleClass(status)}>{item.title}</span>
        </button>
        <span className="session-status">
          {status !== "running" && (
            <>
              {!activeTask && (
                <button
                  className="row-action"
                  onClick={() => send({ type: "remove_session", file: item.file })}
                  title="Remove session"
                >
                  <X size={14} />
                </button>
              )}
              {item.unread && <span className="unread-dot" />}
            </>
          )}
        </span>
      </li>
    );
  }

  return (
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
        <button className="nav-item" onClick={onDashboard}>
          <LayoutDashboard size={16} />
          Dashboard
        </button>
        <div className="sidebar-heading">
          <span className="project-name">Projects</span>
          <button className="row-action" onClick={onPick} title="Add project">
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
                <button className="project-toggle" onClick={() => onToggleProject(project.path)}>
                  {expanded.has(project.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span className="project-name">{folderName(project.path)}</span>
                </button>
                {project.path !== sessionCwd &&
                  !project.sessions.some((item) => statuses[item.file] === "running") &&
                  !project.orchestrators.some((item) => statuses[item.file] === "running") && (
                    <button className="row-action" onClick={() => onRemoveProject(project)} title="Remove project">
                      <X size={14} />
                    </button>
                  )}
                <button
                  className="row-action new-orchestrator"
                  onClick={() => onStartOrchestrator(project.path)}
                  title="New orchestrator"
                >
                  <Workflow size={14} />
                </button>
                <button className="row-action new-session" onClick={() => onStart(project.path)} title="New session">
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
                    const open = unfolded.has(item.file) || children.some((child) => child.file === sessionFile);
                    return (
                      <Fragment key={item.file}>
                        <li className={item.file === sessionFile ? "session-row active" : "session-row"}>
                          {children.length > 0 ? (
                            <button
                              className="session-toggle"
                              onClick={() => onToggleOrchestrator(item.file)}
                              title={open ? "Fold tasks" : "Unfold tasks"}
                            >
                              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          ) : (
                            <span className="session-toggle" />
                          )}
                          <button
                            className="session-open"
                            onClick={() => onOpenSession(project.path, item.file)}
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
                                  onClick={() => onRemoveOrchestrator(item.file)}
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
      <button className="nav-item" onClick={onSettings}>
        <SettingsIcon size={16} />
        Settings
      </button>
    </aside>
  );
}
