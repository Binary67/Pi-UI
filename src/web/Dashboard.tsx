import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import type { UsageDay } from "../shared/protocol.ts";
import { formatTokens } from "./SessionFooter.tsx";

/** A metric of the cards and the chart. */
type Metric = "cost" | "input" | "output" | "time" | "messages";

const METRICS: { key: Metric; label: string; chart: string }[] = [
  { key: "cost", label: "Cost", chart: "Cost per day" },
  { key: "input", label: "Input", chart: "Input per day" },
  { key: "output", label: "Output", chart: "Output per day" },
  { key: "time", label: "Model time", chart: "Model time per day" },
  { key: "messages", label: "Messages", chart: "Messages per day" },
];

/** The value of `metric` for one day, or for a sum of days. */
function value(day: UsageDay, metric: Metric): number {
  switch (metric) {
    case "cost":
      return day.cost;
    case "input":
      return day.input + day.cacheRead + day.cacheWrite;
    case "output":
      return day.output;
    case "time":
      return day.durationMs;
    case "messages":
      return day.userMessages + day.assistantMessages;
  }
}

/** A dollar amount with `digits` decimals. */
function formatCost(cost: number, digits: number): string {
  return `$${cost.toFixed(digits)}`;
}

/** A duration as `45s`, `12m`, or `3h 17m`. */
function formatDuration(ms: number): string {
  if (ms > 0 && ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A local date `YYYY-MM-DD` as a short date, for example "Nov 14". */
function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** The sums of all fields of `days`. */
function total(days: UsageDay[]): UsageDay {
  const sum = {
    date: "",
    cost: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    durationMs: 0,
    assistantMessages: 0,
    userMessages: 0,
  };
  for (const day of days) {
    sum.cost += day.cost;
    sum.input += day.input;
    sum.cacheRead += day.cacheRead;
    sum.cacheWrite += day.cacheWrite;
    sum.output += day.output;
    sum.durationMs += day.durationMs;
    sum.assistantMessages += day.assistantMessages;
    sum.userMessages += day.userMessages;
  }
  return sum;
}

/** The big number and the subline of the card of `metric`. */
function summary(
  sum: UsageDay,
  metric: Metric,
): { main: string; sub?: string } {
  switch (metric) {
    case "cost":
      return { main: formatCost(sum.cost, 2) };
    case "input": {
      const all = value(sum, "input");
      const cached = Math.round((100 * (sum.cacheRead + sum.cacheWrite)) / all);
      return {
        main: formatTokens(all),
        sub: all > 0 ? `${cached}% cache` : undefined,
      };
    }
    case "output":
      return { main: formatTokens(sum.output) };
    case "time":
      return { main: formatDuration(sum.durationMs) };
    case "messages":
      return {
        main: formatTokens(value(sum, "messages")),
        sub: `${formatTokens(sum.userMessages)} user · ${formatTokens(sum.assistantMessages)} assistant`,
      };
  }
}

function Row({ label, text }: { label: string; text: string }) {
  return (
    <div className="usage-row">
      <span>{label}</span>
      <span>{text}</span>
    </div>
  );
}

/** The dashboard page: the usage of the last 30 days in cards and a chart. `days` is null while the page waits. */
export function Dashboard({
  days,
  onBack,
}: {
  days: UsageDay[] | null;
  onBack?: () => void;
}) {
  const [metric, setMetric] = useState<Metric>("cost");
  const sum = days && total(days);
  const max = days ? Math.max(...days.map((day) => value(day, metric))) : 0;
  return (
    <main className="settings dashboard">
      <div className="settings-inner dashboard-inner">
        <div>
          <h1>Dashboard</h1>
          <p className="dashboard-subtitle">Last 30 days · all Pi sessions</p>
        </div>
        {days && sum ? (
          <>
            <div className="dashboard-cards">
              {METRICS.map(({ key, label }) => {
                const { main, sub } = summary(sum, key);
                return (
                  <button
                    key={key}
                    className={
                      key === metric ? "metric-card active" : "metric-card"
                    }
                    aria-pressed={key === metric}
                    onClick={() => setMetric(key)}
                  >
                    <span className="metric-label">{label}</span>
                    <span className="metric-value">{main}</span>
                    {sub && <span className="metric-sub">{sub}</span>}
                  </button>
                );
              })}
            </div>
            <section className="dashboard-chart">
              <h2>{METRICS.find((item) => item.key === metric)!.chart}</h2>
              <div className="dashboard-bars">
                {days.map((day, index) => {
                  const amount = value(day, metric);
                  return (
                    <div
                      key={day.date}
                      className={
                        index < days.length / 2
                          ? "dashboard-bar left"
                          : "dashboard-bar right"
                      }
                      tabIndex={0}
                    >
                      <div
                        className={
                          amount > 0 ? "dashboard-fill" : "dashboard-fill empty"
                        }
                        style={{
                          height:
                            amount > 0 ? `${(100 * amount) / max}%` : undefined,
                        }}
                      />
                      <div className="dashboard-card" role="tooltip">
                        <div className="dashboard-card-date">
                          {formatDate(day.date)}
                        </div>
                        <Row label="Cost" text={formatCost(day.cost, 3)} />
                        <Row label="Input" text={formatTokens(day.input)} />
                        <Row
                          label="Cache read"
                          text={formatTokens(day.cacheRead)}
                        />
                        <Row
                          label="Cache write"
                          text={formatTokens(day.cacheWrite)}
                        />
                        <Row label="Output" text={formatTokens(day.output)} />
                        <Row
                          label="Model time"
                          text={formatDuration(day.durationMs)}
                        />
                        <Row
                          label="User messages"
                          text={formatTokens(day.userMessages)}
                        />
                        <Row
                          label="Assistant messages"
                          text={formatTokens(day.assistantMessages)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="dashboard-axis">
                <span>{formatDate(days[0].date)}</span>
                <span>
                  {formatDate(days[Math.floor(days.length / 2)].date)}
                </span>
                <span>Today</span>
              </div>
            </section>
          </>
        ) : (
          <>
            <div className="dashboard-cards">
              {METRICS.map(({ key }) => (
                <span key={key} className="skeleton metric-skeleton" />
              ))}
            </div>
            <span className="skeleton chart-skeleton" />
          </>
        )}
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
