import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GATE_LABELS, SEVERITIES, gateSize, gateTypesFor, newGate, updateGateAt } from "@/lib/draft";
import { describeGate } from "@/lib/describe";
import type { Gate, StageType, WorkflowsMeta } from "@/lib/workflows";
import { ConditionEditor } from "./ConditionEditor";
import { Chip, Pick, Row } from "./fields";

interface Ctx { meta: WorkflowsMeta; stageType: StageType; stageIds: string[] }

function Leaf({ g, onChange, ctx, label }: { g: Gate; onChange: (g: Gate) => void; ctx: Ctx; label: string }) {
  switch (g.type) {
    case "no_blocking_findings": {
      const on = g.severities ?? [];
      return (
        <Row>
          <span className="text-xs text-muted-foreground">blocking severities (none ticked: critical, blocker, major):</span>
          {SEVERITIES.map((s) => <Chip key={s} on={on.includes(s)} onClick={() => { const next = on.includes(s) ? on.filter((x) => x !== s) : [...on, s]; onChange({ type: g.type, ...(next.length ? { severities: next } : {}) }); }}>{s}</Chip>)}
        </Row>
      );
    }
    case "artifact_exists": return <Input aria-label={`${label}: file path`} className="max-w-sm font-mono text-xs" placeholder="path/inside/the/worktree.md" value={g.path} onChange={(e) => onChange({ ...g, path: e.target.value })} />;
    case "fields_present": return <Input aria-label={`${label}: fields`} className="max-w-sm font-mono text-xs" placeholder="comma separated, e.g. text, summary" value={g.fields.join(", ")} onChange={(e) => onChange({ ...g, fields: e.target.value.split(",").map((x) => x.trim().replace(/[^A-Za-z0-9_.]/g, "")).filter(Boolean) })} />;
    case "condition": return <ConditionEditor label={label} value={g.condition} onChange={(condition) => onChange({ ...g, condition })} stageIds={ctx.stageIds} />;
    default: return null;
  }
}

function Node({ g, path, root, setRoot, ctx, depth }: { g: Gate; path: number[]; root: Gate; setRoot: (g: Gate) => void; ctx: Ctx; depth: number }) {
  const label = `gate ${path.length ? path.map((p) => p + 1).join(".") : "root"}`;
  const size = gateSize(root), room = size.nodes < (ctx.meta.limits.maxGateNodes ?? 30);
  const types = gateTypesFor(ctx.stageType, ctx.meta.gateTypes);
  const canNest = depth < (ctx.meta.limits.maxGateDepth ?? 5);
  const replace = (next: Gate | null) => setRoot(updateGateAt(root, path, next));
  const isGroup = g.type === "all" || g.type === "any";
  return (
    <div className={depth ? "grid gap-2 rounded-md border bg-muted/20 p-2.5" : "grid gap-2"}>
      <Row>
        <Pick label={`${label}: type`} value={g.type} onChange={(t) => t && replace(isGroup && (t === "all" || t === "any") ? { ...g, type: t } as Gate : newGate(t))} options={types.filter((t) => t !== "all" && t !== "any" ? true : canNest || depth === 0).map((t) => ({ value: t, label: GATE_LABELS[t] ?? t }))} className="w-56" />
        {path.length ? <Button type="button" variant="ghost" size="sm" aria-label={`remove ${label}`} onClick={() => replace(null)}><X /></Button> : null}
      </Row>
      {isGroup ? (
        <div className="grid gap-2 border-l-2 pl-3">
          {g.of.map((c, i) => <Node key={i} g={c} path={[...path, i]} root={root} setRoot={setRoot} ctx={ctx} depth={depth + 1} />)}
          <Row>
            <Button type="button" variant="outline" size="sm" disabled={!room} onClick={() => replace({ ...g, of: [...g.of, { type: "result_ok" }] })}><Plus />Add condition</Button>
            <Button type="button" variant="outline" size="sm" disabled={!room || !canNest || depth + 1 >= (ctx.meta.limits.maxGateDepth ?? 5)} onClick={() => replace({ ...g, of: [...g.of, newGate("any")] })}><Plus />Add nested group</Button>
          </Row>
        </div>
      ) : <Leaf g={g} onChange={(n) => replace(n)} ctx={ctx} label={label} />}
    </div>
  );
}

/** The success gate builder: all/any groups of conditions, plus a plain-language reading of what it means. */
export function GateEditor({ gate, onChange, meta, stageType, stageIds }: { gate: Gate; onChange: (g: Gate) => void; meta: WorkflowsMeta; stageType: StageType; stageIds: string[] }) {
  const ctx: Ctx = { meta, stageType, stageIds };
  const size = gateSize(gate);
  return (
    <div className="grid gap-3">
      <Node g={gate} path={[]} root={gate} setRoot={onChange} ctx={ctx} depth={0} />
      <div className="rounded-md border bg-muted/30 p-3 text-sm" aria-label="what must be true before the next stage runs">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">What must be true before the next stage runs</div>
        <p className="mt-1 whitespace-pre-line">{describeGate(gate).join("\n")}</p>
        <p className="mt-1 text-xs text-muted-foreground">A gate is checked only after the stage itself succeeded: it can make a stage stricter but never lets a failed one through. {size.nodes} of {meta.limits.maxGateNodes ?? 30} conditions, {size.depth} of {meta.limits.maxGateDepth ?? 5} levels.</p>
      </div>
    </div>
  );
}
