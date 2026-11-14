import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageDay } from "../shared/protocol.ts";

const DAYS = 30;

type UsageMessage = {
  key: string;
  timestamp: number;
  role: "assistant" | "user";
  cost: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  durationMs: number;
};

// The messages of each file, by path. A file is read again only after its modification time or size changes.
const files = new Map<string, { mtimeMs: number; size: number; messages: UsageMessage[] }>();

/** Read the assistant and user messages of a session file. Like Pi, skip malformed lines. */
async function readMessages(file: string): Promise<UsageMessage[]> {
  const messages: UsageMessage[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" && message?.role !== "user") continue;
    if (typeof message.timestamp !== "number") continue;
    const usage = message.usage;
    messages.push({
      key: `${entry.id}:${message.timestamp}`,
      timestamp: message.timestamp,
      role: message.role,
      cost: Number(usage?.cost?.total) || 0,
      input: Number(usage?.input) || 0,
      cacheRead: Number(usage?.cacheRead) || 0,
      cacheWrite: Number(usage?.cacheWrite) || 0,
      output: Number(usage?.output) || 0,
      durationMs: Number(message.durationMs) || 0,
    });
  }
  return messages;
}

/** The local date of `date`, as `YYYY-MM-DD`. */
function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Sum the usage of all session files in `dir` (`<dir>/<subfolder>/*.jsonl`) per local day. The result has the 30 days
 * up to the day of `now`, oldest first. A message that is in more than one file (a fork) counts once.
 */
export async function readUsage(dir: string, now: Date): Promise<UsageDay[]> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS - 1));
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const days: UsageDay[] = Array.from({ length: DAYS }, (_, index) => ({
    date: localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)),
    cost: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    durationMs: 0,
    assistantMessages: 0,
    userMessages: 0,
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));

  const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const paths = (
    await Promise.all(
      folders
        .filter((folder) => folder.isDirectory())
        .map(async (folder) => {
          const names = await readdir(join(dir, folder.name)).catch(() => []);
          return names.filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, folder.name, name));
        }),
    )
  ).flat();
  const lists = await Promise.all(
    paths.map(async (path) => {
      try {
        const { mtimeMs, size } = await stat(path);
        if (mtimeMs < start.getTime()) return [];
        const cached = files.get(path);
        if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.messages;
        const messages = await readMessages(path);
        files.set(path, { mtimeMs, size, messages });
        return messages;
      } catch {
        // Like the session list, leave out missing or unreadable files.
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  for (const message of lists.flat()) {
    if (message.timestamp < start.getTime() || message.timestamp >= end.getTime() || seen.has(message.key)) continue;
    seen.add(message.key);
    const day = byDate.get(localDate(new Date(message.timestamp)))!;
    if (message.role === "user") {
      day.userMessages++;
      continue;
    }
    day.assistantMessages++;
    day.cost += message.cost;
    day.input += message.input;
    day.cacheRead += message.cacheRead;
    day.cacheWrite += message.cacheWrite;
    day.output += message.output;
    day.durationMs += message.durationMs;
  }
  return days;
}
