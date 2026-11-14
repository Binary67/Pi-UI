import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePen,
  FileText,
  FolderOpen,
  GitFork,
  Globe,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  Minus,
  Pencil,
  Search,
  Share,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { memo, type ReactNode, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { AgentMessage, AssistantMessage } from "../shared/chat-state.ts";
import type { CustomMessage } from "../shared/pi-rpc.ts";
import type { PromptImage, TaskSummary } from "../shared/protocol.ts";
import { ImageViewer } from "./ImageViewer.tsx";
import { TASK_LABELS } from "./TaskBoard.tsx";

type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;
/** Tool results by `toolCallId`. */
export type ToolResults = Map<string, ToolResult>;

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  read: FileText,
  edit: FilePen,
  write: FilePen,
  grep: Search,
  find: Search,
  ls: FolderOpen,
  web_search: Globe,
  fetch_content: Globe,
};
const SUMMARY_KEYS = ["command", "path", "pattern", "url", "query"];
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: ({ node, children }) => {
    const code = node?.children[0];
    const className = code?.type === "element" ? String(code.properties.className ?? "") : "";
    return <CodeBlock language={/language-([\w-]+)/.exec(className)?.[1]}>{children}</CodeBlock>;
  },
};

export function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="banner">
      <CircleAlert size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Working() {
  return (
    <div className="working">
      <LoaderCircle size={16} className="spin" />
      <span className="shimmer">Working…</span>
    </div>
  );
}

const SKELETON_LINES = ["100%", "90%", "60%"];

/** A grey outline of the chat screen, shown while a new Pi process starts. */
export function Skeleton() {
  return (
    <>
      <main className="thread" aria-busy="true" aria-label="Loading session">
        <div className="column">
          <div className="skeleton skeleton-bubble" />
          {SKELETON_LINES.map((width) => (
            <div key={width} className="skeleton skeleton-line" style={{ width }} />
          ))}
        </div>
      </main>
      <div className="dock">
        <div className="column">
          <div className="skeleton skeleton-composer" />
        </div>
      </div>
    </>
  );
}

export function CopyButton({ getText, label }: { getText: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(getText());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button className="ghost-button" onClick={copy} title="Copy">
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {label && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}

function CodeBlock({ language, children }: { language?: string; children: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language ?? "text"}</span>
        <CopyButton getText={() => preRef.current?.textContent ?? ""} label="Copy" />
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

/** Memoized, so a streamed update does not parse and highlight the unchanged messages again. */
const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
});

function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking">
      <button className="disclosure" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} className="chevron" />
        <Brain size={14} className={active ? "pulse" : undefined} />
        <span className={active ? "shimmer" : undefined}>{active ? "Thinking…" : "Thought"}</span>
      </button>
      {open && <div className="thinking-text">{text.trim()}</div>}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** The steps of a done turn, collapsed into one row above the final answer. */
export function WorkGroup({ duration, tools, children }: { duration: number; tools: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="disclosure" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} className="chevron" />
        <span>
          Worked for {formatDuration(duration)} · {tools} {tools === 1 ? "tool" : "tools"}
        </span>
      </button>
      {open && <div className="work-steps">{children}</div>}
    </div>
  );
}

function summarize(args: Record<string, unknown>): string {
  const value =
    SUMMARY_KEYS.map((key) => args[key]).find((item) => typeof item === "string") ??
    Object.values(args).find((item) => typeof item === "string");
  return typeof value === "string" ? value : "";
}

/**
 * Pi's display diff. Each line is a sign (`+`, `-`, or space), a padded line number, and the text. A line in another
 * format shows as plain text.
 */
function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split("\n").map((line, index) => {
        const [, sign = "", number = "", text = line] = /^([+\- ])( *\d*) (.*)$/s.exec(line) ?? [];
        return (
          <div key={index} className={`diff-line${sign === "+" ? " add" : sign === "-" ? " del" : ""}`}>
            <span className="diff-num">{number}</span>
            <span className="diff-sign">{sign}</span>
            <span>{text}</span>
          </div>
        );
      })}
    </pre>
  );
}

function ToolCard({ call, result, running }: { call: ToolCall; result?: ToolResult; running: boolean }) {
  const [open, setOpen] = useState(false);
  const diff = result?.details?.diff;
  const Icon = TOOL_ICONS[call.name] ?? Wrench;
  const status = result ? (result.isError ? "error" : "done") : running ? "running" : "stopped";
  return (
    <div className="tool-card">
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon size={16} className="tool-icon" />
        <span className="tool-name">{call.name}</span>
        <span className="tool-summary">{summarize(call.arguments)}</span>
        <span className={`tool-status ${status}`}>
          {status === "running" && <LoaderCircle size={16} className="spin" />}
          {status === "done" && <Check size={16} />}
          {status === "error" && <X size={16} />}
          {status === "stopped" && <Minus size={16} />}
        </span>
        <ChevronRight size={14} className="chevron" />
      </button>
      {open && (
        <div className="tool-body">
          {diff ? (
            <>
              <div className="tool-label">Diff</div>
              <DiffView diff={diff} />
            </>
          ) : (
            <>
              <div className="tool-label">Arguments</div>
              <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
            </>
          )}
          {result && (
            <>
              <div className="tool-label">{result.isError ? "Error" : "Output"}</div>
              <pre className={result.isError ? "error" : undefined}>
                {result.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n")}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The copy button of a message action row. The CSS shows the `aria-label` of an action button as its tooltip. */
function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button className="action-button" onClick={copy} aria-label={copied ? "Copied" : "Copy"}>
      {copied ? <Check size={18} /> : <Copy size={18} />}
    </button>
  );
}

/** The image thumbnails of a user message. A click opens the image at full size. */
function UserImages({ images }: { images: PromptImage[] }) {
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <>
      <div className="user-images">
        {images.map((image, index) => (
          <button key={index} onClick={() => setViewing(index)} aria-label="View image">
            <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
          </button>
        ))}
      </div>
      {viewing !== null && <ImageViewer images={images} start={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

/** A task update in the orchestrator chat: one row with the task and its status. A click shows the full update. */
function TaskUpdate({ message }: { message: CustomMessage }) {
  const [open, setOpen] = useState(false);
  const { id, title, status } = message.details as Pick<TaskSummary, "id" | "title" | "status">;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return (
    <div className="task-update">
      <button className="disclosure" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} className="chevron" />
        <ListChecks size={14} />
        <span>
          Task {id} · {title}
        </span>
        <span className={`badge ${status}`}>{TASK_LABELS[status]}</span>
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  );
}

type MessageViewProps = {
  message: AgentMessage;
  results: ToolResults;
  /** True while the session runs. */
  running: boolean;
  /** True when this message is still streaming. */
  streaming: boolean;
  /** Fork the session before a user message. Gets the timestamp, text, and images of the message. Absent when the session cannot be forked. */
  onFork?: (timestamp: number, text: string, images: PromptImage[]) => void;
};

export const MessageView = memo(function MessageView({
  message,
  results,
  running,
  streaming,
  onFork,
}: MessageViewProps) {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const images =
      typeof message.content === "string"
        ? []
        : message.content.flatMap((block) => (block.type === "image" ? [block] : []));
    return (
      <div className="message user">
        {images.length > 0 && <UserImages images={images} />}
        {text && <div className="user-text">{text}</div>}
        <div className="message-actions">
          {text && <CopyAction text={text} />}
          {onFork && (
            <button
              className="action-button"
              onClick={() => onFork(message.timestamp, text, images)}
              aria-label="Fork from here"
            >
              <GitFork size={18} />
            </button>
          )}
          <button className="action-button" aria-label="Share · Soon" disabled>
            <Share size={18} />
          </button>
          <button className="action-button" aria-label="Edit message · Soon" disabled>
            <Pencil size={18} />
          </button>
        </div>
      </div>
    );
  }
  if (message.role === "custom") return message.customType === "task_update" ? <TaskUpdate message={message} /> : null;
  if (message.role !== "assistant") return null;

  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
  return (
    <div className="message assistant">
      {message.content.map((block, index) => {
        if (block.type === "text") return block.text.trim() && <MarkdownText key={index} text={block.text} />;
        if (block.type === "thinking") {
          const active = streaming && index === message.content.length - 1;
          return (block.thinking.trim() || active) && <ThinkingBlock key={index} text={block.thinking} active={active} />;
        }
        return <ToolCard key={index} call={block} result={results.get(block.id)} running={running} />;
      })}
      {message.errorMessage && <Banner>{message.errorMessage}</Banner>}
      {!streaming && message.stopReason !== "toolUse" && text.trim() && (
        <div className="message-actions">
          <CopyAction text={text} />
        </div>
      )}
    </div>
  );
});
