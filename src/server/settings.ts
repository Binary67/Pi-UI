import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelChoice, SessionKind } from "../shared/protocol.ts";

const FILE = join(homedir(), ".pi-ui", "settings.json");

/** The last model and thinking level of each kind of session. */
type Store = Partial<Record<SessionKind, ModelChoice>>;

const store: Store = load();

function load(): Store {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/** The remembered choice of `kind`. Empty when there is none. */
export function getChoice(kind: SessionKind): ModelChoice {
  return store[kind] ?? {};
}

// Synchronous writes with a rename, as in `projects.ts`.
export function saveChoice(kind: SessionKind, choice: ModelChoice): void {
  store[kind] = choice;
  mkdirSync(dirname(FILE), { recursive: true });
  const temporary = `${FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(temporary, FILE);
}
