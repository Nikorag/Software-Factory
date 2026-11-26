import { useEffect, useState } from "react";
import { AlertTriangle, XCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Issue } from "@/lib/workflows";
import { cn } from "@/lib/utils";

/** A labelled field with an optional hint and the validation issues that belong to it, shown right under the control. */
export function Field({ label, hint, issues = [], htmlFor, className, children }: { label: string; hint?: React.ReactNode; issues?: Issue[]; htmlFor?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <Issues issues={issues} />
    </div>
  );
}

export function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="grid gap-0.5" aria-label="problems">
      {issues.map((i, k) => (
        <li key={k} role={i.severity === "error" ? "alert" : "status"} className={cn("flex items-start gap-1.5 text-xs", i.severity === "error" ? "text-destructive" : "text-loop")}>
          {i.severity === "error" ? <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}<span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** A number box you can clear and retype: it commits only valid numbers (clamped to the range) and restores on blur. `optional` lets it be empty (undefined). */
export function NumField({ id, value, min, max, onChange, optional, className, label }: { id?: string; value: number | undefined; min: number; max: number; onChange: (n: number | undefined) => void; optional?: boolean; className?: string; label?: string }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => { setText(value === undefined ? "" : String(value)); }, [value]);
  return (
    <Input id={id} aria-label={label} type="number" min={min} max={max} className={cn("w-28", className)} value={text}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") { setText(""); if (optional) onChange(undefined); return; }
        const n = Math.min(max, Math.max(min, Math.trunc(Number(raw))));
        if (Number.isNaN(n)) return;
        setText(String(n)); onChange(n);
      }}
      onBlur={() => setText(value === undefined ? "" : String(value))} />
  );
}

const NONE = "__none";
/** A Select over plain options. `empty` adds a first option for "no value" (shown as that label). */
export function Pick({ value, onChange, options, empty, label, className, disabled }: { value: string | undefined; onChange: (v: string | undefined) => void; options: { value: string; label: string }[]; empty?: string; label: string; className?: string; disabled?: boolean }) {
  return (
    <Select value={value ?? (empty !== undefined ? NONE : "")} onValueChange={(v) => onChange(v === NONE ? undefined : v)} disabled={disabled}>
      <SelectTrigger className={cn("w-56", className)} aria-label={label}><SelectValue placeholder="choose…" /></SelectTrigger>
      <SelectContent>
        {empty !== undefined ? <SelectItem value={NONE}>{empty}</SelectItem> : null}
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** A toggle chip: for picking several values from a short list. */
export function Chip({ on, onClick, children, disabled, title }: { on: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button type="button" aria-pressed={on} disabled={disabled} title={title} onClick={onClick}
      className={cn("rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50", on ? "border-foreground bg-accent font-medium" : "text-muted-foreground")}>{children}</button>
  );
}

export const Row = ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
export const Mono = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{children}</code>;
