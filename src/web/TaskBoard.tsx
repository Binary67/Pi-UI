import { Workflow, X } from "lucide-react";
import type { TaskStatus, TaskSummary } from "../shared/protocol.ts";

export const TASK_LABELS: Record<TaskStatus, string> = {
  running: "Running",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};
// The done tasks first, then the tasks that are running or in review. The sort is stable, so each group keeps the start
// order.
const ORDER: Record<TaskStatus, number> = { done: 0, cancelled: 0, running: 1, review: 1 };

type TaskBoardProps = {
  tasks: TaskSummary[];
  /** The session file that the page shows. */
  active: string;
  /** True when the board shows as a drawer, on a medium or narrow screen. */
  open: boolean;
  onOpen: (file: string) => void;
  onClose: () => void;
  /** Show the orchestrator. Absent when the page shows it. */
  onOrchestrator?: () => void;
};

/** The tasks of the orchestrator of a project, in one column. A click on a task opens its subagent session. */
export function TaskBoard({ tasks, active, open, onOpen, onClose, onOrchestrator }: TaskBoardProps) {
  return (
    <aside className={open ? "board open" : "board"}>
      <div className="board-heading">
        <span className="board-name">Tasks</span>
        {onOrchestrator && (
          <button className="board-link" onClick={onOrchestrator}>
            <Workflow size={14} />
            Orchestrator
          </button>
        )}
        <button className="icon-button board-close" onClick={onClose} title="Close tasks">
          <X size={16} />
        </button>
      </div>
      {tasks.length ? (
        <ol className="cards">
          {tasks
            .toSorted((a, b) => ORDER[a.status] - ORDER[b.status])
            .map((task) => (
              <li key={task.id}>
                <button
                  className={`card ${task.status}${task.file === active ? " active" : ""}`}
                  disabled={!task.file}
                  onClick={() => onOpen(task.file!)}
                >
                  <span className="card-head">
                    <span className="card-title">{task.title}</span>
                    <span className={`badge ${task.status}`}>{TASK_LABELS[task.status]}</span>
                  </span>
                  {task.status === "running" && task.activity && (
                    <span className="card-activity shimmer">{task.activity}</span>
                  )}
                  {task.note && <span className="card-note">{task.note}</span>}
                </button>
              </li>
            ))}
        </ol>
      ) : (
        <p className="board-empty">The orchestrator adds tasks here after you approve a plan.</p>
      )}
    </aside>
  );
}
