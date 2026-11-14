import { Brain, Cpu, GitBranch } from "lucide-react";
import type { BranchInfo, ModelRef, SessionInfo, ThinkingLevel } from "../shared/protocol.ts";
import { Menu } from "./Menu.tsx";

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
  /** The git branch of the session. Null when it is not known yet, or when the folder is not in a git repository. */
  branch: BranchInfo | null;
  /** Why the branch cannot change now. Null when it can change. */
  branchBlock: string | null;
  /** Read the branch again. */
  onListBranches: () => void;
  onSwitchBranch: (branch: string, create: boolean) => void;
};

/** The row below the composer: model, thinking, and branch pickers on the left, usage on the right. */
export function SessionFooter({
  info,
  disabled,
  onSetModel,
  onSetThinkingLevel,
  branch,
  branchBlock,
  onListBranches,
  onSwitchBranch,
}: SessionFooterProps) {
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
      {branch && (
        <Menu
          className="branch-menu"
          icon={<GitBranch size={14} />}
          label={branch.current}
          title={branchBlock ?? "Branch"}
          items={branch.branches.map((name) => ({ key: name, label: name }))}
          selected={branch.detached ? "" : branch.current}
          disabled={branchBlock !== null}
          searchPlaceholder="Search or create branch"
          onOpen={onListBranches}
          create={{ label: (name) => `Create branch "${name}"`, onCreate: (name) => onSwitchBranch(name, true) }}
          onSelect={(name) => onSwitchBranch(name, false)}
        />
      )}
      <Usage stats={info.stats} />
    </div>
  );
}
