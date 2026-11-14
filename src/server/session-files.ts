import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "../shared/pi-rpc.ts";

type SessionHeader = { type: "session"; version: 3; id: string; timestamp: string; cwd: string; parentSession?: string };
type SessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: AgentMessage;
  name?: string;
  targetId?: string;
  label?: string;
  firstKeptEntryId?: string;
  [key: string]: unknown;
};

async function readSession(file: string): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
  const records = (await readFile(file, "utf8")).split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      // Like Pi, skip malformed lines, including a record that is still being written.
      return [];
    }
  });
  const [header, ...entries] = records as [SessionHeader, ...SessionEntry[]];
  if (header?.type !== "session") throw new Error(`Invalid session file: ${file}`);
  return { header, entries };
}

function sessionName(entries: SessionEntry[]): string | undefined {
  return entries.findLast((entry) => entry.type === "session_info")?.name?.trim() || undefined;
}

function messageText(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
}

type SessionListing = { path: string; title: string; modified: number };

// The listing of each file, by path. A file is read again only after its modification time or size changes.
const listings = new Map<string, { mtimeMs: number; size: number; listing: SessionListing }>();

/** Only inspect files already kept by the UI, without scanning Pi's installation or session directories. */
export async function listSessions(files: string[]): Promise<SessionListing[]> {
  const sessions = await Promise.all(
    files.map(async (path) => {
      try {
        const { mtimeMs, size } = await stat(path);
        const cached = listings.get(path);
        if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.listing;
        const { header, entries } = await readSession(path);
        let firstMessage = "";
        let modified = 0;
        for (const entry of entries) {
          const message = entry.type === "message" ? entry.message : undefined;
          if (message?.role !== "user" && message?.role !== "assistant") continue;
          modified = Math.max(modified, message.timestamp);
          if (!firstMessage && message.role === "user") firstMessage = messageText(message);
        }
        const listing = {
          path,
          title: sessionName(entries) ?? (firstMessage || "(no messages)"),
          modified: modified || Date.parse(header.timestamp),
        };
        listings.set(path, { mtimeMs, size, listing });
        return listing;
      } catch {
        // Pi's session list also leaves out missing or unreadable files.
        return null;
      }
    }),
  );
  return sessions.filter((session) => session !== null).sort((a, b) => b.modified - a.modified);
}

/** Create a separate fork before a user message. Never write to the source, which may still be running. */
export async function forkSession(file: string, timestamp: number): Promise<string | undefined> {
  const { header, entries } = await readSession(file);
  const target = entries.find(
    (entry) => entry.type === "message" && entry.message?.role === "user" && entry.message.timestamp === timestamp,
  );
  if (!target) throw new Error("The message is not in the session file.");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  for (let id = target.parentId; id; ) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Session entry not found: ${id}`);
    branch.push(entry);
    id = entry.parentId;
  }
  branch.reverse();
  const prompts = branch.filter((entry) => entry.type === "message" && entry.message?.role === "user");
  if (!prompts.length) return undefined;
  const title = sessionName(entries) ?? prompts.map((entry) => messageText(entry.message!)).find(Boolean);

  // Labels are metadata on any branch. Resolve their latest values, then recreate those for retained entries.
  const labels = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (entry.type !== "label") continue;
    if (entry.label) labels.set(entry.targetId!, entry);
    else labels.delete(entry.targetId!);
  }
  const kept: SessionEntry[] = [];
  const pendingLabels: string[] = [];
  const replacementByLabelId = new Map<string, string>();
  let parentId: string | null = null;
  for (const entry of branch) {
    if (entry.type === "label") {
      pendingLabels.push(entry.id);
      continue;
    }
    for (const id of pendingLabels) replacementByLabelId.set(id, entry.id);
    pendingLabels.length = 0;
    kept.push(
      entry.type === "compaction"
        ? { ...entry, parentId, firstKeptEntryId: replacementByLabelId.get(entry.firstKeptEntryId!) ?? entry.firstKeptEntryId }
        : { ...entry, parentId },
    );
    parentId = entry.id;
  }
  const keptIds = new Set(kept.map((entry) => entry.id));
  for (const [targetId, label] of labels) {
    if (!keptIds.has(targetId)) continue;
    const entry = { ...label, id: randomUUID(), parentId };
    kept.push(entry);
    parentId = entry.id;
  }

  const id = randomUUID();
  const created = new Date().toISOString();
  const forked = join(dirname(file), `${created.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const forkHeader: SessionHeader = { type: "session", version: 3, id, timestamp: created, cwd: header.cwd, parentSession: file };
  kept.push({
    type: "session_info",
    id: randomUUID(),
    parentId,
    timestamp: created,
    name: (title ? `Fork: ${title}` : "Fork").replace(/[\r\n]+/g, " ").trim(),
  });
  await writeFile(forked, [forkHeader, ...kept].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
  return forked;
}
