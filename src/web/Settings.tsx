import { ArrowLeft, Mic } from "lucide-react";
import { useEffect, useState } from "react";
import { Menu } from "./Menu.tsx";
import { MICROPHONE_KEY, type Microphone, savedMicrophone } from "./MicButton.tsx";

/**
 * The microphone of voice input. The choice belongs to this browser, so a run does not block it. The browser gives the
 * names of its microphones only after the page has permission for a microphone. When the menu opens without names, it
 * opens a microphone for a moment to get the permission. A page load never asks. When the permission fails, the list
 * shows only the saved choice.
 */
function MicrophoneMenu() {
  const [saved, setSaved] = useState(savedMicrophone);
  /** The microphones with a label. */
  const [devices, setDevices] = useState<Microphone[]>([]);
  const microphones = devices.length ? devices : saved ? [saved] : [];

  async function refresh() {
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(
      all
        // Chrome adds the virtual devices "default" and "communications": copies of other devices in the list.
        .filter(
          (device) =>
            device.kind === "audioinput" &&
            device.label &&
            device.deviceId !== "default" &&
            device.deviceId !== "communications",
        )
        .map(({ deviceId, label }) => ({ deviceId, label })),
    );
    return all;
  }

  async function open() {
    const all = await refresh();
    if (all.some((device) => device.kind === "audioinput" && device.label)) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      return;
    }
    await refresh();
  }

  useEffect(() => {
    void refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, []);

  return (
    <Menu
      icon={<Mic size={14} />}
      label={saved?.label ?? "System default"}
      title="Microphone"
      // The label is the stable name of a device, so it is the key.
      items={[{ key: "", label: "System default" }, ...microphones.map(({ label }) => ({ key: label, label }))]}
      selected={saved?.label ?? ""}
      disabled={false}
      onOpen={() => void open()}
      onSelect={(key) => {
        const microphone = microphones.find((item) => item.label === key);
        if (microphone) localStorage.setItem(MICROPHONE_KEY, JSON.stringify(microphone));
        else localStorage.removeItem(MICROPHONE_KEY);
        setSaved(microphone);
      }}
    />
  );
}

/** The settings page. The browser keeps the settings, so a run does not block them. */
export function Settings({ onBack }: { onBack?: () => void }) {
  return (
    <main className="settings">
      <div className="settings-inner">
        <h1>Settings</h1>
        <section className="settings-section">
          <h2>Voice input</h2>
          <div className="settings-row">
            <span>Microphone</span>
            <MicrophoneMenu />
          </div>
        </section>
        {onBack && (
          <button className="link" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to session
          </button>
        )}
      </div>
    </main>
  );
}
