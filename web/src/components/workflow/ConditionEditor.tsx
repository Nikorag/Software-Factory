import { Input } from "@/components/ui/input";
import { joinField, JOB_FIELDS, parseField, parseValue, type FieldKind } from "@/lib/draft";
import { CONDITION_OPS, type Condition, type ConditionOp } from "@/lib/workflows";
import { Pick, Row } from "./fields";

const KINDS: { value: FieldKind; label: string }[] = [{ value: "job", label: "a fact about the job" }, { value: "output", label: "this stage's output" }, { value: "outputs", label: "another stage's output" }];

/** Builds `field op value` from the closed vocabulary the backend accepts: job facts, this stage's output, or an earlier stage's output. */
export function ConditionEditor({ value, onChange, stageIds, label }: { value: Condition; onChange: (c: Condition) => void; stageIds: string[]; label: string }) {
  const f = parseField(value.field);
  const set = (p: Partial<typeof f>) => onChange({ ...value, field: joinField({ ...f, ...p }) });
  const op = CONDITION_OPS.find((o) => o.op === value.op);
  return (
    <Row>
      <Pick label={`${label}: reads`} value={f.kind} onChange={(v) => v && set({ kind: v as FieldKind, ...(v === "outputs" && !f.stage ? { stage: stageIds[0] ?? "" } : {}) })} options={KINDS} className="w-48" />
      {f.kind === "job" ? <Pick label={`${label}: job fact`} value={f.job} onChange={(v) => v && set({ job: v })} options={JOB_FIELDS.map((j) => ({ value: j, label: j }))} className="w-48" /> : null}
      {f.kind === "outputs" ? <Pick label={`${label}: stage`} value={f.stage || undefined} onChange={(v) => v && set({ stage: v })} options={stageIds.map((s) => ({ value: s, label: s }))} className="w-48" /> : null}
      {f.kind !== "job" ? <Input aria-label={`${label}: output field`} className="w-40 font-mono text-xs" value={f.path} placeholder="field.path" onChange={(e) => set({ path: e.target.value.replace(/[^A-Za-z0-9_.]/g, "") })} /> : null}
      <Pick label={`${label}: operator`} value={value.op} onChange={(v) => { if (!v) return; const o = CONDITION_OPS.find((x) => x.op === v)!; onChange({ field: value.field, op: v as ConditionOp, ...(o.needsValue ? { value: value.value ?? "" } : {}) }); }} options={CONDITION_OPS.map((o) => ({ value: o.op, label: o.label }))} className="w-44" />
      {op?.needsValue ? <Input aria-label={`${label}: value`} className="w-32" value={value.value === undefined ? "" : String(value.value)} placeholder="value" onChange={(e) => onChange({ ...value, value: parseValue(e.target.value) })} /> : null}
    </Row>
  );
}
