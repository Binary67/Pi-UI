import { Brain, Check, ChevronDown, Cpu, Mic, Search } from "lucide-react";
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ModelRef, SessionInfo, ThinkingLevel } from "../shared/protocol.ts";
import { MICROPHONE_KEY, type Microphone, savedMicrophone } from "./MicButton.tsx";

/** Context use above these percentages shows as a warning or a danger, as in the TUI footer. */
const WARN_PERCENT = 70;
const DANGER_PERCENT = 90;

/** A token count in the TUI footer format: 950, 6.8k, 68k, 1.2M. */
function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

function levelName(level: ThinkingLevel): string {
  return level === "xhigh" ? "XHigh" : level[0].toUpperCase() + level.slice(1);
}

function modelKey(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

type MenuItem = { key: string; label: string; group?: string };

type MenuProps = {
  /** An extra class of the menu, for its styles. */
  className?: string;
  icon: ReactNode;
  /** The text on the pill. */
  label: string;
  title: string;
  /** Items of the same group must be next to each other. */
  items: MenuItem[];
  /** The key of the current item. */
  selected: string;
  disabled: boolean;
  /** When set, the menu shows a search field with this placeholder. */
  searchPlaceholder?: string;
  /** Called when the menu opens. */
  onOpen?: () => void;
  onSelect: (key: string) => void;
};

/** A ghost pill that opens a list above it, in the style of a macOS menu. */
function Menu({
  className,
  icon,
  label,
  title,
  items,
  selected,
  disabled,
  searchPlaceholder,
  onOpen,
  onSelect,
}: MenuProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  // A run that starts closes the menu.
  if (open && disabled) setOpen(false);

  // Each word of the query must occur in the group or the label.
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = items.filter((item) =>
    terms.every((term) => `${item.group ?? ""} ${item.label}`.toLowerCase().includes(term)),
  );
  const activeId = matches.length ? `${id}-${active}` : undefined;

  // Focus the menu when it opens. A press outside the menu closes it.
  useEffect(() => {
    if (!open) return;
    (searchRef.current ?? listRef.current)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  function show() {
    onOpen?.();
    setQuery("");
    setActive(Math.max(items.findIndex((item) => item.key === selected), 0));
    setOpen(true);
  }

  /** Close the menu. After a key press, the focus goes back to the pill. After a click, it does not. */
  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }

  function choose(key: string, refocus: boolean) {
    close(refocus);
    if (key !== selected) onSelect(key);
  }

  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        if (matches.length) setActive((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
        return;
      case "Enter":
        event.preventDefault();
        if (matches[active]) choose(matches[active].key, true);
        return;
      case "Escape":
      case "Tab":
        event.preventDefault();
        close(true);
        return;
    }
  }

  return (
    <div className={className ? `menu ${className}` : "menu"} ref={rootRef}>
      <button
        ref={buttonRef}
        className="pill"
        onClick={() => (open ? setOpen(false) : show())}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon}
        <span className="pill-label">{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu-panel" onKeyDown={onKeyDown}>
          {searchPlaceholder !== undefined && (
            <div className="menu-search">
              <Search size={14} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                placeholder={searchPlaceholder}
                role="combobox"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={activeId}
              />
            </div>
          )}
          <div
            ref={listRef}
            id={`${id}-list`}
            className="menu-list"
            role="listbox"
            aria-label={title}
            tabIndex={-1}
            aria-activedescendant={searchPlaceholder === undefined ? activeId : undefined}
          >
            {matches.map((item, index) => (
              <Fragment key={item.key}>
                {item.group !== undefined && item.group !== matches[index - 1]?.group && (
                  <div className="menu-group" role="presentation">
                    {item.group}
                  </div>
                )}
                <div
                  id={`${id}-${index}`}
                  className={index === active ? "menu-item active" : "menu-item"}
                  role="option"
                  aria-selected={item.key === selected}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(item.key, false)}
                >
                  <span className="menu-check">{item.key === selected && <Check size={14} />}</span>
                  {item.label}
                </div>
              </Fragment>
            ))}
            {!matches.length && <div className="menu-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

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
      className="microphone-menu"
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

/** A circle that fills to `percent`. */
function Ring({ percent }: { percent: number }) {
  return (
    <svg className="ring" width={14} height={14} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx={7} cy={7} r={5.5} className="ring-track" />
      <circle
        cx={7}
        cy={7}
        r={5.5}
        className="ring-fill"
        pathLength={100}
        strokeDasharray={100}
        strokeDashoffset={100 - percent}
        transform="rotate(-90 7 7)"
      />
    </svg>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** Context use and cost. A card with the token counts opens on hover. */
function Usage({ stats }: { stats: SessionInfo["stats"] }) {
  const context = stats.contextUsage;
  const percent = context?.percent ?? null;
  const fill = Math.min(percent ?? 0, 100);
  const tone = percent === null ? "" : percent > DANGER_PERCENT ? "danger" : percent > WARN_PERCENT ? "warn" : "";
  return (
    <div className={`usage ${tone}`} tabIndex={0}>
      {context && (
        <span className="usage-context">
          <Ring percent={fill} />
          {percent === null ? "?" : `${Math.round(percent)}%`}
        </span>
      )}
      {stats.cost > 0 && (
        <span className="usage-cost">
          {context && "· "}
          {formatCost(stats.cost)}
        </span>
      )}
      <div className="usage-card" role="tooltip">
        {context && (
          <>
            <Row
              label="Context"
              value={`${context.tokens === null ? "?" : formatTokens(context.tokens)} / ${formatTokens(context.contextWindow)}`}
            />
            <div className="usage-bar">
              <div style={{ width: `${fill}%` }} />
            </div>
          </>
        )}
        <Row label="Input" value={formatTokens(stats.tokens.input)} />
        <Row label="Output" value={formatTokens(stats.tokens.output)} />
        <Row label="Cache read" value={formatTokens(stats.tokens.cacheRead)} />
        <Row label="Cache write" value={formatTokens(stats.tokens.cacheWrite)} />
        <Row label="Cost" value={formatCost(stats.cost)} />
      </div>
    </div>
  );
}

type SessionFooterProps = {
  info: SessionInfo;
  /** True while a run is in progress. The model and thinking pickers do not change then. */
  disabled: boolean;
  onSetModel: (model: ModelRef) => void;
  onSetThinkingLevel: (level: ThinkingLevel) => void;
};

/** The row below the composer: model, thinking, and microphone pickers on the left, usage on the right. */
export function SessionFooter({ info, disabled, onSetModel, onSetThinkingLevel }: SessionFooterProps) {
  const { model, models } = info;
  // The menu needs the models of each provider next to each other.
  const providers = [...new Set(models.map((item) => item.provider))];
  const modelItems = providers.flatMap((provider) =>
    models
      .filter((item) => item.provider === provider)
      .map((item) => ({ key: modelKey(item), label: item.id, group: provider })),
  );
  return (
    <div className="session-footer">
      <Menu
        icon={<Cpu size={14} />}
        label={model?.id ?? "No model"}
        title="Model"
        items={modelItems}
        selected={model ? modelKey(model) : ""}
        disabled={disabled}
        searchPlaceholder="Search models"
        onSelect={(key) => onSetModel(models.find((item) => modelKey(item) === key)!)}
      />
      {info.thinkingLevels.length > 1 && (
        <Menu
          icon={<Brain size={14} />}
          label={levelName(info.thinkingLevel)}
          title="Thinking level"
          items={info.thinkingLevels.map((level) => ({ key: level, label: levelName(level) }))}
          selected={info.thinkingLevel}
          disabled={disabled}
          onSelect={(key) => onSetThinkingLevel(key as ThinkingLevel)}
        />
      )}
      <MicrophoneMenu />
      <Usage stats={info.stats} />
    </div>
  );
}
