import type { PromptImage } from "../shared/protocol.ts";

/** What the composer holds. */
export type Draft = { text: string; images: PromptImage[]; transcribing: boolean };

/** A new value, or a function of the current value, as with the setter of `useState`. */
type Update<T> = T | ((current: T) => T);

/**
 * The draft of the composer, outside React state. The composer unmounts while the page loads a session or shows
 * another page, but the draft stays. A keystroke renders only the composer, which subscribes to the draft.
 */
export function createDraft() {
  let draft: Draft = { text: "", images: [], transcribing: false };
  const listeners = new Set<() => void>();

  function change<K extends keyof Draft>(key: K, update: Update<Draft[K]>) {
    const value = typeof update === "function" ? (update as (current: Draft[K]) => Draft[K])(draft[key]) : update;
    if (Object.is(value, draft[key])) return;
    draft = { ...draft, [key]: value };
    for (const listener of listeners) listener();
  }

  return {
    get: () => draft,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setText: (update: Update<string>) => change("text", update),
    setImages: (update: Update<PromptImage[]>) => change("images", update),
    setTranscribing: (update: Update<boolean>) => change("transcribing", update),
  };
}

export type ComposerDraft = ReturnType<typeof createDraft>;
