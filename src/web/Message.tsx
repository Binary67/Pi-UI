import {
  Brain,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  LoaderCircle,
  type LucideIcon,
  Minus,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { AgentMessage, AssistantMessage } from "../shared/chat-state.ts";

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
      <BrainCircuit size={16} className="pulse" />
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

function CopyButton({ getText, label }: { getText: () => string; label?: string }) {
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

function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  );
}

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

function summarize(args: Record<string, unknown>): string {
  const value =
    SUMMARY_KEYS.map((key) => args[key]).find((item) => typeof item === "string") ??
    Object.values(args).find((item) => typeof item === "string");
  return typeof value === "string" ? value : "";
}

function ToolCard({ call, result, running }: { call: ToolCall; result?: ToolResult; running: boolean }) {
  const [open, setOpen] = useState(false);
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
          <div className="tool-label">Arguments</div>
          <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
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

type MessageViewProps = {
  message: AgentMessage;
  results: ToolResults;
  /** True while the session runs. */
  running: boolean;
  /** True when this message is still streaming. */
  streaming: boolean;
};

export function MessageView({ message, results, running, streaming }: MessageViewProps) {
  if (message.role === "user") {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return <div className="message user">{text}</div>;
  }
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
      {!streaming && text.trim() && (
        <div className="message-actions">
          <CopyButton getText={() => text} label="Copy" />
        </div>
      )}
    </div>
  );
}
