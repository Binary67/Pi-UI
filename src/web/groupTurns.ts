import type { AgentMessage, AssistantMessage } from "../shared/chat-state.ts";

/**
 * The steps of a collapsed turn. `first` and `last` are indexes in the messages of the turn: the steps are the messages
 * from `first` up to, but not including, `last`. `duration` is absent while the answer streams.
 */
type Work = {
  first: number;
  last: number;
  tools: number;
  duration?: number;
  /** True when the answer has thinking. It shows in the group, and only its text shows below. */
  thinking: boolean;
  /** True when a later turn of the same exchange exists. All messages after the first message collapse. */
  earlier: boolean;
};

/** One turn: its messages, the index of its first message in the item list, and `work` when its steps collapse. */
export type Turn = { start: number; messages: AgentMessage[]; work?: Work };

/** A user message or a task update for the orchestrator starts a turn. */
function startsTurn(message: AgentMessage): boolean {
  return message.role === "user" || (message.role === "custom" && message.customType === "task_update");
}

function countTools(messages: AgentMessage[]): number {
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall") : [],
  ).length;
}

/**
 * A user message or a task update starts a turn. A turn before a task update of the same exchange collapses fully. The
 * last turn of an exchange collapses its steps as soon as its answer has text.
 */
export function groupTurns(items: AgentMessage[], streaming: AssistantMessage | null): Turn[] {
  const turns: Turn[] = [];
  for (let start = 0, end = 0; start < items.length; start = end) {
    end = start + 1;
    while (end < items.length && !startsTurn(items[end])) end++;
    const turn = items.slice(start, end);
    const first = startsTurn(turn[0]) ? 1 : 0;
    const last = turn.findLastIndex((message) => message.role === "assistant");
    if (last < 0) {
      turns.push({ start, messages: turn });
      continue;
    }
    const final = turn[last] as AssistantMessage;
    const duration = final === streaming ? undefined : final.timestamp + (final.durationMs ?? 0) - turn[0].timestamp;
    if (end < items.length && items[end].role !== "user") {
      turns.push({
        start,
        messages: turn,
        work: { first, last: turn.length, tools: countTools(turn.slice(first)), duration, thinking: false, earlier: true },
      });
      continue;
    }
    const answer =
      final.content.some((block) => block.type === "text" && block.text.trim()) &&
      !final.content.some((block) => block.type === "toolCall") &&
      (final === streaming || final.stopReason === "stop");
    const thinking = final.content.some((block) => block.type === "thinking" && block.thinking.trim());
    if (answer && (last > first || thinking)) {
      turns.push({
        start,
        messages: turn,
        work: { first, last, tools: countTools(turn.slice(first, last)), duration, thinking, earlier: false },
      });
    } else {
      turns.push({ start, messages: turn });
    }
  }
  return turns;
}
