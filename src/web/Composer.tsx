import { X } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ClientMessage, PromptImage, StreamingBehavior } from "../shared/protocol.ts";
import type { ComposerDraft } from "./composerDraft.ts";
import { MicButton } from "./MicButton.tsx";
import { SendButton } from "./SendButton.tsx";

const COMPOSER_MAX_HEIGHT = 200;
/** The image types that Pi accepts in a prompt. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** True on a touch screen. Enter then adds a new line, and no field takes the focus by itself. */
export const TOUCH = matchMedia("(hover: none), (any-pointer: coarse)").matches;

export function scrollToBottom(behavior: ScrollBehavior): void {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
}

function readImage(file: File): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve({ type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: file.type });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

type ComposerProps = {
  draft: ComposerDraft;
  connected: boolean;
  running: boolean;
  sessionFile: string;
  atBottom: boolean;
  socketRef: RefObject<WebSocket | null>;
  send: (message: ClientMessage) => void;
  onError: (message: string) => void;
};

export function Composer({ draft, connected, running, sessionFile, atBottom, socketRef, send, onError }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { text, images, transcribing } = useSyncExternalStore(draft.subscribe, draft.get);
  const { setText, setImages } = draft;

  // The keyboard of the composer shrinks the page. A reader at the bottom stays at the bottom, above the composer.
  useEffect(() => {
    if (!atBottom) return;
    const onResize = () => {
      if (document.activeElement === textareaRef.current) scrollToBottom("instant");
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [atBottom]);

  // Grow the composer with its text, up to a limit. Only a change of the text, or a new composer, changes its height.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [text]);

  function submit(streamingBehavior: StreamingBehavior) {
    // Offline, the text stays in the composer.
    if (!connected || (!text.trim() && !images.length)) return;
    send({ type: "prompt", file: sessionFile, text, images, streamingBehavior });
    setText("");
    setImages([]);
  }

  // Pasted images become attachments. A paste without images inserts its text as usual.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) => IMAGE_TYPES.has(file.type));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(readImage)).then((added) => setImages((current) => [...current, ...added], sessionFile));
  }

  // On a touch screen, Enter adds a new line, and the send button sends.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !TOUCH) {
      event.preventDefault();
      submit(event.altKey ? "followUp" : "steer");
    }
  }

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="attachments">
          {images.map((image, index) => (
            <div key={index} className="attachment">
              <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
              <button
                className="attachment-remove"
                onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                title="Remove image"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder="Message Pi…"
        rows={1}
        autoFocus={!TOUCH}
      />
      <MicButton
        disabled={!connected}
        transcribing={transcribing}
        onRecord={(audio, mimeType) => {
          // `send` drops a message without an open socket. The recording can end after the socket closed.
          if (!socketRef.current) {
            onError("Not connected. The recording is lost.");
            return;
          }
          draft.waitTranscript(sessionFile);
          send({ type: "transcribe", audio, mimeType });
        }}
        onError={onError}
      />
      <SendButton
        running={connected && running}
        ready={connected && Boolean(text.trim() || images.length)}
        onSend={() => submit("steer")}
        onStop={() => send({ type: "abort", file: sessionFile })}
      />
    </div>
  );
}
