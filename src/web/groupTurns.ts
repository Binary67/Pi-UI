import type { AgentMessage } from "../shared/chat-state.ts";

/** The steps of a done turn. `first` and `last` are indexes in the messages of the turn. */
type Work = { first: number; last: number; tools: number; duration: number };

/** One turn: its messages, the index of its first message in the item list, and `work` when its steps collapse. */
export type Turn = { start: number; messages: AgentMessage[]; work?: Work };

/** A user message or a task update for the orchestrator starts a turn. */
function startsTurn(message: AgentMessage): boolean {
  return message.role === "user" || (message.role === "custom" && message.customType === "task_update");
}

/** Each user message starts a turn. A done turn shows its steps in one collapsed group, then the final answer. */
export function groupTurns(items: AgentMessage[], running: boolean): Turn[] {
  const turns: Turn[] = [];
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
      turns.push({
        start,
        messages: turn,
        work: { first, last, tools, duration: final.timestamp + (final.durationMs ?? 0) - turn[0].timestamp },
      });
    } else {
      turns.push({ start, messages: turn });
    }
  }
  return turns;
}
