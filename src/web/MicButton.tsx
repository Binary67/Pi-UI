import { LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type MicButtonProps = {
  /** True when the page is not connected. It blocks only a new recording: a tap always stops a recording. */
  disabled: boolean;
  /** True while the page waits for the transcript of a recording. */
  transcribing: boolean;
  /** Gets the recording as base64 data without a `data:` URL prefix, and its MIME type. */
  onRecord: (audio: string, mimeType: string) => void;
  onError: (message: string) => void;
};

/**
 * The voice input button of the composer. A tap starts a recording, and a second tap stops it and gives it to
 * `onRecord`. The microphone is on only during a recording. An unmount, such as a session switch, drops the recording.
 */
export function MicButton({ disabled, transcribing, onRecord, onError }: MicButtonProps) {
  const recorderRef = useRef<MediaRecorder>(undefined);
  /** False after an unmount. A recording then stops, and `onRecord` does not get it. */
  const mountedRef = useRef(false);
  /** True from the tap that starts a recording until the recording stops. */
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recorderRef.current?.stop();
    };
  }, []);

  async function start() {
    setRecording(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setRecording(false);
      return onError(error instanceof Error ? error.message : String(error));
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      recorderRef.current = undefined;
      setRecording(false);
      // The microphone turns off.
      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (!mountedRef.current || !blob.size) return;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result as string;
        onRecord(url.slice(url.indexOf(",") + 1), recorder.mimeType);
      };
      reader.readAsDataURL(blob);
    };
    recorderRef.current = recorder;
    recorder.start();
    // The component unmounted while the browser opened the microphone.
    if (!mountedRef.current) recorder.stop();
  }

  return (
    <button
      className={recording ? "mic recording" : "mic"}
      // A tap while the browser opens the microphone does nothing.
      onClick={() => (recording ? recorderRef.current?.stop() : void start())}
      // The composer keeps the focus, so the phone keyboard stays open.
      onMouseDown={(event) => event.preventDefault()}
      disabled={(disabled && !recording) || transcribing}
      title={transcribing ? "Transcribing…" : recording ? "Stop recording" : "Voice input"}
    >
      {transcribing ? (
        <LoaderCircle size={18} className="spin" />
      ) : recording ? (
        <Square size={14} fill="currentColor" />
      ) : (
        <Mic size={18} />
      )}
    </button>
  );
}
