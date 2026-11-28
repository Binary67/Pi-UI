import type { PromptImage } from "../shared/protocol.ts";

/** What the composer holds. */
type Submission = { id: string; text: string; images: PromptImage[]; error?: string };
export type Draft = {
  text: string;
  images: PromptImage[];
  submission?: Submission;
  recordings: string[];
  recordingError?: string;
};

/** A new value, or a function of the current value, as with the setter of `useState`. */
type Update<T> = T | ((current: T) => T);

/** The draft of a session without an entry. */
const EMPTY: Draft = { text: "", images: [], recordings: [] };

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
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) listener();
  }

  function patch(file: string, fields: Partial<Draft>) {
    drafts.set(file, { ...(drafts.get(file) ?? EMPTY), ...fields });
    if (file === current) notify();
  }

  function change<K extends keyof Draft>(key: K, update: Update<Draft[K]>, file = current) {
    const draft = drafts.get(file) ?? EMPTY;
    const value = typeof update === "function" ? (update as (current: Draft[K]) => Draft[K])(draft[key]) : update;
    if (Object.is(value, draft[key])) return;
    patch(file, { [key]: value });
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
    submit(file: string): Submission | undefined {
      const draft = drafts.get(file) ?? EMPTY;
      if (draft.submission || (!draft.text.trim() && !draft.images.length)) return;
      const submission = { id: crypto.randomUUID(), text: draft.text, images: draft.images };
      patch(file, { submission, text: "", images: [] });
      return submission;
    },
    finishPrompt(file: string, id: string, error?: string) {
      const pending = drafts.get(file)?.submission;
      if (pending?.id === id) patch(file, { submission: error === undefined ? undefined : { ...pending, error } });
    },
    restorePrompt(file: string) {
      const draft = drafts.get(file);
      const sent = draft?.submission;
      if (!draft || !sent) return;
      patch(file, {
        text: [sent.text, draft.text].filter(Boolean).join("\n\n"),
        images: [...sent.images, ...draft.images],
        submission: undefined,
      });
    },
    waitTranscript(file: string): string {
      const id = crypto.randomUUID();
      const recordings = drafts.get(file)?.recordings ?? [];
      patch(file, { recordings: [...recordings, id], recordingError: undefined });
      return id;
    },
    finishTranscript(file: string, id: string, result: { text: string } | { error: string }) {
      const draft = drafts.get(file);
      if (!draft?.recordings.includes(id)) return;
      const recordings = draft.recordings.filter((item) => item !== id);
      if ("error" in result) patch(file, { recordings, recordingError: result.error });
      else patch(file, { recordings, text: [draft.text, result.text].filter((part) => part.trim()).join(" ") });
    },
    disconnected() {
      for (const [file, draft] of drafts) {
        if (draft.submission && draft.submission.error === undefined) {
          patch(file, { submission: { ...draft.submission, error: "Delivery was not confirmed. Check the chat before resending." } });
        }
        if (draft.recordings.length) patch(file, { recordings: [], recordingError: "Disconnected before the transcript arrived." });
      }
    },
    setText: (update: Update<string>, file?: string) => change("text", update, file),
    setImages: (update: Update<PromptImage[]>, file?: string) => change("images", update, file),
  };
}

export type ComposerDraft = ReturnType<typeof createDraft>;
