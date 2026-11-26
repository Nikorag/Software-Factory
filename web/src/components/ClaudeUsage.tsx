import { TONE } from "@/lib/projects";
import type { ClaudeUsage, LimitWindow } from "@/lib/types";

const pct = (w: LimitWindow) => Math.round(w.utilization * 100);
const tone = (w: LimitWindow) => (w.utilization >= 0.9 ? TONE.fail : w.utilization >= 0.75 ? TONE.wait : TONE.ok);
/** "in 3h 20m" / "in 2d 4h" for a reset time. */
export function resetsIn(at: number | null, now = Date.now()): string {
  if (at === null) return "";
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m < 60) return `in ${m}m`;
  if (m < 2880) return `in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `in ${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };

function Bar({ label, w }: { label: string; w: LimitWindow | null }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-sm"><span>{label}</span><span className="tabular-nums">{w ? `${pct(w)}% used` : "no reading"}{w?.resetsAt ? <span className="text-xs text-muted-foreground"> · resets {resetsIn(w.resetsAt)}</span> : null}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w ? pct(w) : 0}>
        {w ? <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct(w))}%`, background: tone(w) }} /> : null}
      </div>
    </div>
  );
}

/** Claude plan limits as last reported by Claude Code during a factory run. A reading, so it shows how old it is. */
export function ClaudeUsagePanel({ usage }: { usage?: ClaudeUsage }) {
  const l = usage?.limits;
  if (!usage) return <p className="text-sm text-muted-foreground">No usage data yet.</p>;
  return (
    <div className="grid gap-3">
      {l ? (<><Bar label="Session (5 hours)" w={l.fiveHour} /><Bar label="Weekly (7 days)" w={l.sevenDay} />
        <p className="text-xs text-muted-foreground">Reported by Claude Code {ago(l.capturedAt)}. It updates each time an agent runs.</p></>)
        : <p className="text-sm text-muted-foreground">No limit reading yet. It appears after the first agent run.</p>}
      <p className="text-xs text-muted-foreground">Estimated list-price cost of agent runs: ${usage.estimatedListCostUsd.last24h.toFixed(2)} in the last 24h, ${usage.estimatedListCostUsd.last7d.toFixed(2)} in the last 7 days. This is not a charge: subscription use is not billed per token.</p>
    </div>
  );
}

/** Always-visible version for the status bar: two small bars (session, weekly) with their percentages. Hover for reset times. */
export function ClaudeUsageChip({ usage }: { usage?: ClaudeUsage }) {
  const l = usage?.limits;
  if (!l || (!l.fiveHour && !l.sevenDay)) return <span className="inline-flex items-center gap-1.5" title="Claude limits appear after the first agent run">Claude limits: waiting for a run</span>;
  const mini = (label: string, w: LimitWindow | null) => w && (
    <span className="inline-flex items-center gap-1.5" title={`${label}: ${pct(w)}% used${w.resetsAt ? `, resets ${resetsIn(w.resetsAt)}` : ""}`}>
      {label}
      <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-muted" aria-hidden><span className="block h-full rounded-full" style={{ width: `${Math.min(100, pct(w))}%`, background: tone(w) }} /></span>
      <span className="tabular-nums" style={w.utilization >= 0.9 ? { color: TONE.fail } : undefined}>{pct(w)}%</span>
    </span>
  );
  return <span className="inline-flex items-center gap-3" aria-label="Claude plan usage">{mini("Session", l.fiveHour)}{mini("Week", l.sevenDay)}</span>;
}
