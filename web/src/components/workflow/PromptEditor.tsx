import { useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TICKET_SCOPED } from "@/lib/draft";
import type { WorkflowsMeta } from "@/lib/workflows";
import { Issues, Mono } from "./fields";
import type { Issue } from "@/lib/workflows";

/**
 * The prompt of an agent/review stage (the whole template, with the type's default shown and restorable) or the extra instructions of a
 * factory stage. The documented variables are listed; a click inserts one at the cursor.
 */
export function PromptEditor({ mode, value, onChange, defaultPrompt, meta, otherStageIds, issues }: { mode: "template" | "instructions"; value: string; onChange: (v: string) => void; defaultPrompt: string | null; meta: WorkflowsMeta; otherStageIds: string[]; issues: Issue[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [showDefault, setShowDefault] = useState(false);
  const limit = meta.limits.maxPromptChars ?? 20000;
  const vars = meta.promptVariables.filter((v) => mode === "template" || !TICKET_SCOPED.test(v.name));
  const insert = (name: string) => {
    const token = `{{${name.includes("<") ? name.replace("<STAGE_ID>", otherStageIds[0] ?? "STAGE_ID") : name}}}`;
    const el = ref.current, a = el?.selectionStart ?? value.length, b = el?.selectionEnd ?? value.length;
    onChange(`${value.slice(0, a)}${token}${value.slice(b)}`);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + token.length, a + token.length); });
  };
  return (
    <div className="grid gap-2">
      <Textarea ref={ref} aria-label={mode === "template" ? "Prompt template" : "Extra instructions"} rows={mode === "template" ? 14 : 6} className="font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={mode === "template" ? "The whole prompt the agent receives" : "Added to what this built-in stage already tells its agents"} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className={value.length > limit ? "text-destructive" : ""}>{value.length} / {limit} characters</span>
        {mode === "template" && defaultPrompt !== null ? (<>
          <Button type="button" variant="outline" size="sm" disabled={value === defaultPrompt} onClick={() => onChange(defaultPrompt)}><RotateCcw />Restore default</Button>
          <Button type="button" variant="ghost" size="sm" aria-expanded={showDefault} onClick={() => setShowDefault((s) => !s)}>{showDefault ? "Hide" : "Show"} the default prompt</Button>
        </>) : null}
      </div>
      {showDefault && defaultPrompt !== null ? <pre aria-label="default prompt" className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">{defaultPrompt}</pre> : null}
      <Issues issues={issues} />
      <div className="grid gap-1" aria-label="prompt variables">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Variables: click to insert at the cursor</div>
        <div className="flex flex-wrap gap-1.5">{vars.map((v) => <button key={v.name} type="button" title={v.description} onClick={() => insert(v.name)} className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] hover:bg-accent">{`{{${v.name}}}`}</button>)}</div>
        <p className="text-xs text-muted-foreground">Only <Mono>{"{{name}}"}</Mono> placeholders: no logic or code. Text from tickets or findings is inserted as-is and never expanded again. {mode === "instructions" ? "Ticket, repo and spec variables are not available here (the stage's own prompt already carries them)." : ""}</p>
      </div>
    </div>
  );
}
