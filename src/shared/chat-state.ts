import type { AgentMessage, AssistantMessage, JsonAgentSessionEvent } from "./pi-rpc.ts";

export type { AgentMessage, AssistantMessage } from "./pi-rpc.ts";
type AssistantBlock = AssistantMessage["content"][number];
type StreamUpdate = Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

/** Conversation state rebuilt from Pi events. The server and the browser use the same reducer. */
export type ChatState = {
  /** Completed messages, in order. */
  messages: AgentMessage[];
  /** The assistant message that is streaming now. */
  streaming: AssistantMessage | null;
  /** True from agent_start until agent_settled. */
  running: boolean;
  /** Messages that wait for delivery during a run. */
  steering: readonly string[];
  followUp: readonly string[];
};

export const emptyChatState: ChatState = { messages: [], streaming: null, running: false, steering: [], followUp: [] };

export function applyEvent(state: ChatState, event: JsonAgentSessionEvent): ChatState {
  switch (event.type) {
    case "agent_start":
      return { ...state, running: true };
    case "agent_settled":
      return { ...state, running: false };
    case "queue_update":
      return { ...state, steering: event.steering, followUp: event.followUp };
    case "message_start":
      return event.message.role === "assistant" ? { ...state, streaming: event.message } : state;
    case "message_update": {
      if (!state.streaming) return state;
      const streaming = applyUpdate(state.streaming, event.assistantMessageEvent);
      return streaming === state.streaming ? state : { ...state, streaming };
    }
    case "message_end":
      // The completed message replaces the streamed copy.
      return {
        ...state,
        messages: [...state.messages, event.message],
        streaming: event.message.role === "assistant" ? null : state.streaming,
      };
    default:
      return state;
  }
}

/** Rebuild one content block from a delta-only wire update. See docs/json.md. */
function applyUpdate(message: AssistantMessage, update: StreamUpdate): AssistantMessage {
  const set = (index: number, block: AssistantBlock): AssistantMessage => {
    const content = [...message.content];
    content[index] = block;
    return { ...message, content };
  };
  const current = "contentIndex" in update ? message.content[update.contentIndex] : undefined;
  switch (update.type) {
    case "text_start":
      return set(update.contentIndex, { type: "text", text: "" });
    case "text_delta":
      return current?.type === "text"
        ? set(update.contentIndex, { ...current, text: current.text + update.delta })
        : message;
    case "text_end":
      return set(update.contentIndex, { type: "text", text: update.content });
    case "thinking_start":
      return set(update.contentIndex, { type: "thinking", thinking: "" });
    case "thinking_delta":
      return current?.type === "thinking"
        ? set(update.contentIndex, { ...current, thinking: current.thinking + update.delta })
        : message;
    case "thinking_end":
      return set(update.contentIndex, { type: "thinking", thinking: update.content });
    case "toolcall_start":
      return set(update.contentIndex, { type: "toolCall", id: update.id, name: update.toolName, arguments: {} });
    case "toolcall_end":
      return set(update.contentIndex, update.toolCall);
    default:
      // toolcall_delta has partial JSON only. The complete call arrives with toolcall_end.
      return message;
  }
}
