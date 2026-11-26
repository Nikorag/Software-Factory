import { useState } from "react";
import { ArrowDown, ArrowUp, Lock, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { availableHandlers, issueCounts, lockedHandlers } from "@/lib/draft";
import type { Issue, StageType, WorkflowDef, WorkflowsMeta } from "@/lib/workflows";
import { Pick, Row } from "./fields";
import { cn } from "@/lib/utils";

/** The ordered stage list: select, reorder, remove, and add (a built-in stage not yet used, or a new custom one). */
export function StageList({ def, meta, issues, selected, onSelect, onAdd, onRemove, onMove, readOnly }: {
  def: WorkflowDef; meta: WorkflowsMeta; issues: Issue[]; selected: string | null; onSelect: (id: string) => void;
  onAdd: (type: StageType, opts: { name?: string; handler?: string }) => void; onRemove: (id: string) => void; onMove: (id: string, dir: -1 | 1) => void; readOnly: boolean;
}) {
  const [type, setType] = useState<StageType>("agent");
  const [handler, setHandler] = useState<string | undefined>();
  const [name, setName] = useState("");
  const counts = issueCounts(issues, def.stages.length), locked = lockedHandlers(def, meta);
  const free = availableHandlers(meta, def);
  const max = meta.limits.maxStages ?? 40;
  const chosen = handler ?? free[0]?.handler;
  const canAdd = !readOnly && def.stages.length < max && (type !== "factory" || Boolean(chosen));
  return (
    <div className="grid gap-3">
      <ol className="grid gap-1" aria-label="Stages">
        {def.stages.map((s, i) => {
          const lock = s.type === "factory" ? locked.get(s.handler ?? s.id) : undefined;
          return (
            <li key={s.id} className={cn("flex items-center gap-1 rounded-md border pr-1 transition-colors", selected === s.id && "border-foreground bg-accent")}>
              <button type="button" aria-current={selected === s.id ? "true" : undefined} onClick={() => onSelect(s.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-sm">
                <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1"><span className={cn("block truncate font-medium", !s.enabled && "text-muted-foreground line-through")}>{s.name}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">{s.id} · {s.type}{s.required ? "" : " · optional"}{s.runIf ? " · conditional" : ""}</span></span>
                {lock ? <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="locked safety stage" /> : null}
                {!s.enabled ? <Badge variant="outline">off</Badge> : null}
                {counts[i]!.errors ? <Badge variant="outline" className="border-destructive/50 text-destructive" aria-label={`${counts[i]!.errors} errors`}>{counts[i]!.errors}</Badge> : counts[i]!.warnings ? <Badge variant="outline" className="border-loop/50 text-loop" aria-label={`${counts[i]!.warnings} warnings`}>{counts[i]!.warnings}</Badge> : null}
              </button>
              {!readOnly ? (<>
                <Button type="button" variant="ghost" size="icon" className="size-7" disabled={i === 0} aria-label={`move ${s.name} up`} onClick={() => onMove(s.id, -1)}><ArrowUp /></Button>
                <Button type="button" variant="ghost" size="icon" className="size-7" disabled={i === def.stages.length - 1} aria-label={`move ${s.name} down`} onClick={() => onMove(s.id, 1)}><ArrowDown /></Button>
                <Button type="button" variant="ghost" size="icon" className="size-7" disabled={Boolean(lock)} title={lock ? `Locked: ${lock}` : undefined} aria-label={`remove ${s.name}`} onClick={() => onRemove(s.id)}><Trash2 /></Button>
              </>) : null}
            </li>
          );
        })}
      </ol>
      {!readOnly ? (
        <div className="grid gap-2 rounded-md border bg-muted/20 p-3" aria-label="Add a stage">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Add a stage {selected ? "after the selected one" : "at the end"}</div>
          <Row>
            <Pick label="new stage type" value={type} onChange={(v) => v && setType(v as StageType)} options={meta.stageTypes.map((t) => ({ value: t.type, label: t.label }))} className="w-44" />
            {type === "factory"
              ? <Pick label="built-in stage" value={chosen} onChange={setHandler} options={free.map((h) => ({ value: h.handler, label: h.name }))} className="w-56" disabled={!free.length} />
              : <Input aria-label="new stage name" className="w-48" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />}
            <Button type="button" size="sm" disabled={!canAdd} onClick={() => { onAdd(type, type === "factory" ? { handler: chosen } : { name }); setName(""); setHandler(undefined); }}><Plus />Add</Button>
          </Row>
          <p className="text-xs text-muted-foreground">{meta.stageTypes.find((t) => t.type === type)?.description}{type === "factory" && !free.length ? " Every built-in stage is already in this workflow." : ""} {def.stages.length} of {max} stages.</p>
        </div>
      ) : null}
    </div>
  );
}
