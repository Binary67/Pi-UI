import type { PromptImage } from "../shared/protocol.ts";

/** What the composer holds. */
export type Draft = { text: string; images: PromptImage[]; transcribing: boolean };

/** A new value, or a function of the current value, as with the setter of `useState`. */
type Update<T> = T | ((current: T) => T);

/** The draft of a session without an entry. */
const EMPTY: Draft = { text: "", images: [], transcribing: false };

/**
 * The drafts of the composer, one for each session file, outside React state. The composer unmounts while the page
 * loads a session or shows another page, but the drafts stay. A keystroke renders only the composer, which subscribes
 * to the draft of the current session. The drafts live in memory only. A setter changes the draft of the current
 * session, or the draft of the session in `file`.
 */
export function createDraft() {
  const drafts = new Map<string, Draft>();
  let current = "";
  /** The content of a fork. The first snapshot of another session than `from` takes it. */
  let fork: { from: string; text: string; images: PromptImage[] } | null = null;
  /** The files of the recordings that wait for a transcript, oldest first. */
  let waiting: string[] = [];
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function change<K extends keyof Draft>(key: K, update: Update<Draft[K]>, file = current) {
    const draft = drafts.get(file) ?? EMPTY;
    const value = typeof update === "function" ? (update as (current: Draft[K]) => Draft[K])(draft[key]) : update;
    if (Object.is(value, draft[key])) return;
    drafts.set(file, { ...draft, [key]: value });
    if (file === current) notify();
  }

  return {
    get: () => drafts.get(current) ?? EMPTY,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Show the draft of the session in `file`. A held fork content replaces the draft of the new session. */
    open(file: string) {
      current = file;
      if (fork && file !== fork.from) {
        change("text", fork.text);
        change("images", fork.images);
        fork = null;
      }
      notify();
    },
    /** Hold the content of a fork of the session in `from` until the snapshot of the new session arrives. */
    holdFork(from: string, text: string, images: PromptImage[]) {
      fork = { from, text, images };
    },
    /** Drop the held fork content, when the fork does not open. */
    dropFork() {
      fork = null;
    },
    /** Mark the session in `file` as waiting for the transcript of a recording. */
    waitTranscript(file: string) {
      waiting.push(file);
      change("transcribing", true, file);
    },
    /** The file of the oldest recording that waits for a transcript. Its flag clears. */
    takeTranscript() {
      const file = waiting.shift();
      if (file !== undefined) change("transcribing", false, file);
      return file;
    },
    /** Clear all waits, when the transcripts are lost. */
    dropTranscripts() {
      const files = waiting;
      waiting = [];
      for (const file of files) change("transcribing", false, file);
    },
    setText: (update: Update<string>, file?: string) => change("text", update, file),
    setImages: (update: Update<PromptImage[]>, file?: string) => change("images", update, file),
  };
}

export type ComposerDraft = ReturnType<typeof createDraft>;
