import { Globe } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { CopyButton } from "./Message.tsx";

/** The Remote item of the sidebar. It opens a QR code of `url`, for a device in the tailnet. */
export function Remote({ url }: { url: string | null }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Focus the panel when it opens, so Esc reaches it. A press outside the panel closes it.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Esc closes the panel and does not stop the run.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setOpen(false);
  }

  return (
    <div className="remote" ref={rootRef}>
      <button
        className="nav-item"
        onClick={() => setOpen(!open)}
        disabled={!url}
        title={url ? "Open Pi on another device" : "Set PI_UI_REMOTE_URL in .env to turn on remote access"}
        aria-expanded={open}
      >
        <Globe size={16} />
        Remote
        {!url && <span className="soon">Off</span>}
      </button>
      {open && url && (
        <div className="remote-panel" ref={panelRef} tabIndex={-1} onKeyDown={onKeyDown}>
          <p>Scan with a device in your tailnet.</p>
          <QRCodeSVG value={url} size={176} marginSize={2} title={url} />
          <div className="remote-url">
            <span>{url}</span>
            <CopyButton getText={() => url} />
          </div>
        </div>
      )}
    </div>
  );
}
