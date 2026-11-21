// The Azure OpenAI deployment for voice input, from `.env`: its full Target URI and its API key. Only the server uses
// the key, so remote devices never see it.
const TRANSCRIBE_URL = process.env.PI_UI_TRANSCRIBE_URL;
const TRANSCRIBE_KEY = process.env.PI_UI_TRANSCRIBE_KEY;

// A transcription that takes longer than this fails, so the composer does not wait for ever.
const TRANSCRIBE_TIMEOUT_MS = 60 * 1000;
// The recording types that `transcribe` accepts, without parameters such as `;codecs=opus`.
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4"]);

/** The text of a voice recording: base64 `audio` of the type `mimeType`. The Azure deployment makes the transcript. */
export async function transcribe(audio: string, mimeType: string): Promise<string> {
  if (!TRANSCRIBE_URL || !TRANSCRIBE_KEY) {
    throw new Error("For voice input, set PI_UI_TRANSCRIBE_URL and PI_UI_TRANSCRIBE_KEY in .env and restart the servers.");
  }
  // Azure checks that the extension of the file name matches the type: `audio/webm;codecs=opus` is `audio.webm`.
  const type = mimeType.split(";")[0];
  if (!AUDIO_TYPES.has(type)) throw new Error(`The recording type ${type} is not supported. Use webm, ogg, or mp4 audio.`);
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(audio, "base64")], { type }), `audio.${type.split("/")[1]}`);
  // Voice input is English only.
  form.append("language", "en");
  try {
    const response = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      headers: { "api-key": TRANSCRIBE_KEY },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Transcription failed with status ${response.status}: ${await response.text()}`);
    const { text } = (await response.json()) as { text: string };
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`Transcription took longer than ${TRANSCRIBE_TIMEOUT_MS / 1000} s. Try again.`);
    }
    throw error;
  }
}
