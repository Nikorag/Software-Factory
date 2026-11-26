import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FAILURE_DEFAULTS, FAILURE_NOTES } from "@/lib/describe";
import { atField, type StageIssue } from "@/lib/draft";
import type { FailureAction, FailureKind, FailureRule, WorkflowsMeta } from "@/lib/workflows";
import { Issues, NumField, Pick, Row } from "./fields";

const KIND: Record<FailureKind, string> = { findings: "reports findings to fix", error: "fails with an error", timeout: "times out", gate: "finishes but its gate fails", any: "fails in any way" };
const ACTION: Record<FailureAction, string> = { retry: "retry the stage", goto: "go to another stage", skip: "skip the stage", block: "block until a person answers", fail: "fail the job", manual: "ask a person (needs attention)" };

/** Failure rules, in order: the first rule matching the kind of failure that can still act decides. Shows what applies when none matches. */
export function FailureRulesEditor({ rules, onChange, meta, selfId, others, required, locked, issues }: { rules: FailureRule[]; onChange: (r: FailureRule[]) => void; meta: WorkflowsMeta; selfId: string; others: { id: string; name: string }[]; required: boolean; locked: boolean; issues: StageIssue[] }) {
  const set = (i: number, patch: Partial<FailureRule>) => onChange(rules.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const actions = meta.failureActions.filter((a) => !(a === "skip" && (required || locked)));
  const covered = new Set(rules.map((r) => r.on));
  const uncovered = meta.failureKinds.filter((k) => k !== "any" && !covered.has(k) && !covered.has("any"));
  const max = meta.limits.maxFailureRules ?? 10;
  return (
    <div className="grid gap-3">
      {rules.length === 0 ? <p className="text-sm text-muted-foreground">No rules: the defaults below apply to every failure.</p> : null}
      {rules.map((r, i) => (
        <div key={i} className="grid gap-1.5 rounded-md border p-2.5">
          <Row>
            <span className="text-sm text-muted-foreground">{i + 1}. When the stage</span>
            <Pick label={`rule ${i + 1}: kind`} value={r.on} onChange={(v) => v && set(i, { on: v as FailureKind })} options={meta.failureKinds.map((k) => ({ value: k, label: KIND[k] ?? k }))} className="w-60" />
            <span className="text-sm text-muted-foreground">then</span>
            <Pick label={`rule ${i + 1}: action`} value={r.action} onChange={(v) => { if (!v) return; const a = v as FailureAction; const { target: _t, maxCycles: _m, ...rest } = r; void _t; void _m; onChange(rules.map((x, k) => (k === i ? { ...rest, action: a, ...(a === "goto" ? { target: others[0]?.id } : {}) } : x))); }} options={actions.map((a) => ({ value: a, label: ACTION[a] ?? a }))} className="w-60" />
            <Button type="button" variant="ghost" size="sm" aria-label={`remove rule ${i + 1}`} onClick={() => onChange(rules.filter((_, k) => k !== i))}><X /></Button>
          </Row>
          {r.action === "goto" ? (
            <Row className="pl-4">
              <span className="text-sm text-muted-foreground">send the job to</span>
              <Pick label={`rule ${i + 1}: target stage`} value={r.target} onChange={(v) => set(i, { target: v })} options={others.filter((o) => o.id !== selfId).map((o) => ({ value: o.id, label: `${o.name} (${o.id})` }))} className="w-72" />
              <span className="text-sm text-muted-foreground">at most</span>
              <NumField label={`rule ${i + 1}: max fix cycles`} value={r.maxCycles} min={1} max={meta.limits.maxFixCycles ?? 10} optional className="w-20" onChange={(n) => set(i, { maxCycles: n })} />
              <span className="text-xs text-muted-foreground">fix cycles (empty: the project's limit, never above {meta.limits.maxFixCycles ?? 10})</span>
            </Row>
          ) : null}
          <Issues issues={atField(issues, `onFailure.${i}`)} />
        </div>
      ))}
      <div><Button type="button" variant="outline" size="sm" disabled={rules.length >= max} onClick={() => onChange([...rules, { on: "error", action: "retry" }])}><Plus />Add rule</Button></div>
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground" aria-label="failure defaults">
        <div className="font-semibold uppercase tracking-wider">When no rule matches</div>
        {uncovered.length ? <ul className="mt-1 grid gap-0.5">{uncovered.map((k) => <li key={k}>The stage {KIND[k]}: {FAILURE_DEFAULTS[k]}.</li>)}</ul> : <p className="mt-1">Every kind of failure has a rule.</p>}
        <ul className="mt-2 grid gap-0.5">{FAILURE_NOTES.map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
    </div>
  );
}
