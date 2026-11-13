/** The Pi 1.5.2 wire fields this UI consumes. Other fields pass through unchanged. */
export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: string };
type ThinkingContent = { type: "thinking"; thinking: string };
type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  timestamp: number;
  durationMs?: number;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  errorMessage?: string;
};

export type AgentMessage =
  | { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number }
  | AssistantMessage
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: (TextContent | ImageContent)[];
      /** The edit tool sets `diff`. */
      details?: { diff?: string };
      isError: boolean;
      timestamp: number;
    }
  | { role: "system" | "bashExecution" | "custom" | "branchSummary" | "compactionSummary"; timestamp: number };

type StreamUpdate =
  | { type: "text_start" | "thinking_start"; contentIndex: number }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
  | { type: "start" | "done" | "error" };

export type JsonAgentSessionEvent =
  | { type: "message_start" | "message_end"; message: AgentMessage }
  | { type: "message_update"; assistantMessageEvent: StreamUpdate }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | {
      type:
        | "agent_start"
        | "agent_end"
        | "agent_settled"
        | "turn_start"
        | "turn_end"
        | "tool_execution_start"
        | "tool_execution_update"
        | "tool_execution_end"
        | "entry_appended"
        | "session_info_changed"
        | "thinking_level_changed"
        | "compaction_start"
        | "compaction_end"
        | "auto_retry_start"
        | "auto_retry_end"
        | "summarization_retry_scheduled"
        | "summarization_retry_attempt_start"
        | "summarization_retry_finished"
        | "bash_execution_update"
        | "extension_error";
    };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type Model = { provider: string; id: string };

export type RpcSessionState = { model?: Model; thinkingLevel: ThinkingLevel; sessionFile?: string };
export type SessionStats = {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
};

export type RpcCommand = (
  | { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "abort" }
  | { type: "clear_queue" }
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "get_available_models" }
  | { type: "get_available_thinking_levels" }
  | { type: "get_session_stats" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_thinking_level"; level: ThinkingLevel }
) & { id?: string };

export type RpcResponse =
  | { type: "response"; id?: string; command: string; success: false; error: string }
  | ({
      type: "response";
      id?: string;
      success: true;
    } & (
      | { command: "prompt"; data: { disposition: "started" | "queued" | "handled" } }
      | { command: "abort" }
      | { command: "clear_queue"; data: { steering: string[]; followUp: string[] } }
      | { command: "get_state"; data: RpcSessionState }
      | { command: "get_messages"; data: { messages: AgentMessage[] } }
      | { command: "get_available_models"; data: { models: Model[] } }
      | { command: "get_available_thinking_levels"; data: { levels: ThinkingLevel[] } }
      | { command: "get_session_stats"; data: SessionStats }
      | { command: "set_model"; data: Model }
      | { command: "set_thinking_level" }
    ));

export type RpcExtensionUIRequest = { type: "extension_ui_request"; id: string; method: string };
export type RpcExtensionUIResponse = { type: "extension_ui_response"; id: string; cancelled: true };
