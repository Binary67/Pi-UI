import { ArrowUp, Square } from "lucide-react";
import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";

/** The time in milliseconds that a press must last to stop the run. The ring takes the same time to fill. */
const HOLD_MS = 1000;
/** The time in milliseconds that the "Hold to stop" hint shows. */
const HINT_MS = 1500;

type SendButtonProps = {
  /** True while a run is in progress. A hold then stops the run. */
  running: boolean;
  /** True when the composer has text or images to send. */
  ready: boolean;
  onSend: () => void;
  onStop: () => void;
};

/**
 * The button of the composer. A tap sends, which steers during a run. During a run, a hold of `HOLD_MS` stops the
 * run and keeps the composer text. A ring around the button fills while the hold lasts.
 */
export function SendButton({ running, ready, onSend, onStop }: SendButtonProps) {
  const holdRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hintRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** True after a hold stopped the run, so the click of the release does not also send. */
  const stoppedRef = useRef(false);
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState(false);

  function cancel() {
    clearTimeout(holdRef.current);
    setHolding(false);
  }

  // An unmount must not leave a timer that stops the run or sets state.
  useEffect(
    () => () => {
      clearTimeout(holdRef.current);
      clearTimeout(hintRef.current);
    },
    [],
  );

  // A run that ends during a hold cancels the hold.
  useEffect(() => {
    if (!running) cancel();
  }, [running]);

  function onPointerDown(event: PointerEvent<HTMLButtonElement>) {
    stoppedRef.current = false;
    if (!running || event.button !== 0) return;
    // A touch keeps its pointer on the button. Release it, so a finger that moves off the button cancels the hold.
    event.currentTarget.releasePointerCapture(event.pointerId);
    setHolding(true);
    holdRef.current = setTimeout(() => {
      stoppedRef.current = true;
      setHolding(false);
      onStop();
    }, HOLD_MS);
  }

  function onClick() {
    if (stoppedRef.current) {
      stoppedRef.current = false;
      return;
    }
    if (ready) return onSend();
    clearTimeout(hintRef.current);
    setHint(true);
    hintRef.current = setTimeout(() => setHint(false), HINT_MS);
  }

  return (
    <button
      className={holding ? "send holding" : "send"}
      style={{ "--hold": `${HOLD_MS}ms` } as CSSProperties}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      // The composer keeps the focus, so the phone keyboard stays open.
      onMouseDown={(event) => event.preventDefault()}
      // A long press on Android opens a context menu.
      onContextMenu={(event) => event.preventDefault()}
      disabled={!running && !ready}
      title={running ? (ready ? "Send · Hold to stop" : "Hold to stop") : "Send"}
    >
      {running && !ready ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} />}
      <svg className="send-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx={50} cy={50} r={47} pathLength={100} transform="rotate(-90 50 50)" />
      </svg>
      {hint && (
        <span className="send-hint" role="status">
          Hold to stop
        </span>
      )}
    </button>
  );
}
