import { ArrowLeft, Brain, Cpu, Mic } from "lucide-react";
import { useEffect, useState } from "react";
import type { ClientMessage, ModelChoice, ModelRef, ThinkingLevel } from "../shared/protocol.ts";
import { Menu } from "./Menu.tsx";
import { MICROPHONE_KEY, type Microphone, savedMicrophone } from "./MicButton.tsx";
import { levelName, modelKey } from "./SessionFooter.tsx";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

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
    // The browser has no `mediaDevices` on a page that is not secure.
    if (!navigator.mediaDevices) return;
    const update = () => void refresh().catch(() => {});
    update();
    navigator.mediaDevices.addEventListener("devicechange", update);
    return () => navigator.mediaDevices.removeEventListener("devicechange", update);
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
      onOpen={() => void open().catch(() => {})}
      onSelect={(key) => {
        const microphone = microphones.find((item) => item.label === key);
        if (microphone) localStorage.setItem(MICROPHONE_KEY, JSON.stringify(microphone));
        else localStorage.removeItem(MICROPHONE_KEY);
        setSaved(microphone);
      }}
    />
  );
}

/**
 * The model and thinking level of new subagents. The server keeps them. Pi-UI knows the models only after the server
 * has started a Pi process, so the model list can be empty. Then the menu lists only the saved choice.
 */
function SubagentMenus({ choice, models, send }: { choice: ModelChoice; models: ModelRef[]; send: (message: ClientMessage) => void }) {
  const { model, thinkingLevel } = choice;
  const listed = models.length ? models : model ? [model] : [];
  // The menu needs the models of each provider next to each other.
  const providers = [...new Set(listed.map((item) => item.provider))];
  const items = providers.flatMap((provider) =>
    listed.filter((item) => item.provider === provider).map((item) => ({ key: modelKey(item), label: item.id, group: provider })),
  );
  return (
    <>
      <div className="settings-row">
        <span>Model</span>
        <Menu
          icon={<Cpu size={14} />}
          label={model?.id ?? "Pi default"}
          title="Subagent model"
          items={items}
          selected={model ? modelKey(model) : ""}
          disabled={false}
          searchPlaceholder="Search models"
          onSelect={(key) => {
            const chosen = listed.find((item) => modelKey(item) === key)!;
            send({ type: "set_subagent_model", provider: chosen.provider, modelId: chosen.id });
          }}
        />
      </div>
      <div className="settings-row">
        <span>Thinking level</span>
        <Menu
          icon={<Brain size={14} />}
          label={thinkingLevel ? levelName(thinkingLevel) : "Pi default"}
          title="Subagent thinking level"
          items={LEVELS.map((level) => ({ key: level, label: levelName(level) }))}
          selected={thinkingLevel ?? ""}
          disabled={false}
          onSelect={(key) => send({ type: "set_subagent_thinking_level", level: key as ThinkingLevel })}
        />
      </div>
      {!models.length && <p className="settings-note">Open a session to load the models.</p>}
    </>
  );
}

/**
 * The settings page. The browser keeps the microphone choice, so a run does not block it. The server keeps the subagent
 * settings.
 */
export function Settings({
  subagent,
  send,
  onBack,
}: {
  subagent: { choice: ModelChoice; models: ModelRef[] } | null;
  send: (message: ClientMessage) => void;
  onBack?: () => void;
}) {
  useEffect(() => { send({ type: "get_subagent" }); }, []);
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
        <section className="settings-section">
          <h2>Subagents</h2>
          <SubagentMenus choice={subagent?.choice ?? {}} models={subagent?.models ?? []} send={send} />
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
