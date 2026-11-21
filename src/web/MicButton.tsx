import { LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Waveform } from "./Waveform.tsx";

/** The `localStorage` key of the microphone that voice input uses in this browser. No key means the system default. */
export const MICROPHONE_KEY = "pi-ui:microphone";

/** A microphone that the user chose. The device ID can change between browser launches, but the label stays. */
export type Microphone = { deviceId: string; label: string };

const SILENCE =
  "The microphone gives no sound. Choose another microphone in Settings, or see Voice input in the README.";
const NOT_CONNECTED = "The selected microphone is not connected. Choose another microphone in Settings.";

/** The microphone that the user chose, or undefined for the system default. */
export function savedMicrophone(): Microphone | undefined {
  const value = localStorage.getItem(MICROPHONE_KEY);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Microphone;
  } catch {
    return undefined;
  }
}

/**
 * Open the microphone that the user chose. When its device ID changed, its label finds it again. Echo cancellation is
 * off: with it, Safari joins the microphone and the sound output into one voice-processing unit, and a Bluetooth
 * microphone then gives silence while the output is on a different Bluetooth device.
 */
async function openMicrophone(): Promise<MediaStream> {
  // The browser has no `mediaDevices` on a page that is not secure.
  if (!navigator.mediaDevices) throw new Error("Voice input needs HTTPS or localhost.");
  const saved = savedMicrophone();
  if (!saved) return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false } });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, deviceId: saved.deviceId },
  });
  if (stream.getAudioTracks()[0].label === saved.label) return stream;
  // The page has a microphone now, so the browser gives the labels of the devices.
  const found = (await navigator.mediaDevices.enumerateDevices()).find(
    (device) => device.kind === "audioinput" && device.label === saved.label,
  );
  for (const track of stream.getTracks()) track.stop();
  if (!found) throw new Error(NOT_CONNECTED);
  const exact = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, deviceId: { exact: found.deviceId } },
  });
  localStorage.setItem(MICROPHONE_KEY, JSON.stringify({ deviceId: found.deviceId, label: saved.label }));
  return exact;
}

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
 * The voice input button of the composer, with the live level of the recording on its left. A tap starts a recording,
 * and a second tap stops it and gives it to `onRecord`. A recording with only silence gives an error instead. The
 * microphone is on only during a recording. An unmount, such as a session switch, drops the recording.
 */
export function MicButton({ disabled, transcribing, onRecord, onError }: MicButtonProps) {
  const recorderRef = useRef<MediaRecorder>(undefined);
  /** False after an unmount. A recording then stops, and `onRecord` does not get it. */
  const mountedRef = useRef(false);
  /** True when a sample of the recording was not exactly 0. */
  const soundRef = useRef(false);
  /** True from the tap that starts a recording until the recorder starts. */
  const [opening, setOpening] = useState(false);
  /** The level and the microphone name of the recording, from the start of the recorder until it stops. */
  const [recording, setRecording] = useState<{ analyser: AnalyserNode; label: string }>();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recorderRef.current?.stop();
    };
  }, []);

  async function start() {
    // Safari runs an audio context only when the tap creates it, so it comes before the first `await`.
    const audio = new AudioContext();
    setOpening(true);
    soundRef.current = false;
    let stream: MediaStream;
    try {
      stream = await openMicrophone();
    } catch (error) {
      setOpening(false);
      void audio.close();
      return onError(error instanceof Error ? error.message : String(error));
    }
    try {
      const analyser = audio.createAnalyser();
      audio.createMediaStreamSource(stream).connect(analyser);
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstart = () => {
        setOpening(false);
        setRecording({ analyser, label: stream.getAudioTracks()[0].label });
      };
      recorder.onstop = () => {
        recorderRef.current = undefined;
        setRecording(undefined);
        // The microphone turns off.
        for (const track of stream.getTracks()) track.stop();
        void audio.close();
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!mountedRef.current) return;
        // The browser gives silence when it has no access to the microphone.
        if (!soundRef.current) return onError(SILENCE);
        if (!blob.size) return;
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
    } catch (error) {
      // The setup failed after the stream opened, so turn the microphone off.
      for (const track of stream.getTracks()) track.stop();
      void audio.close();
      setOpening(false);
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      {recording && (
        <Waveform analyser={recording.analyser} label={recording.label} onSound={() => (soundRef.current = true)} />
      )}
      <button
        className={recording ? "mic recording" : "mic"}
        onClick={() => {
          if (recording) recorderRef.current?.stop();
          // A tap while the browser opens the microphone does nothing.
          else if (!opening) void start();
        }}
        // The composer keeps the focus, so the phone keyboard stays open.
        onMouseDown={(event) => event.preventDefault()}
        disabled={(disabled && !recording && !opening) || transcribing}
        title={
          transcribing
            ? "Transcribing…"
            : opening
              ? "Opening the microphone…"
              : recording
                ? "Stop recording"
                : "Voice input"
        }
      >
        {transcribing || opening ? (
          <LoaderCircle size={18} className="spin" />
        ) : recording ? (
          <Square size={14} fill="currentColor" />
        ) : (
          <Mic size={18} />
        )}
      </button>
    </>
  );
}
