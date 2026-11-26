import { Lock, Plus, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_ROLES, CHECK_COMMANDS, PHASES, REVIEW_ROLES, SEVERITIES, atField, changeType, defaultPromptOf, defaultRouteOf, issuesForStage } from "@/lib/draft";
import { COMPLETE, type Condition, type Issue, type StageDef, type StageType, type WorkflowDef, type WorkflowsMeta } from "@/lib/workflows";
import { BUILTIN_HELP } from "@/lib/builtin-stages";
import { ConditionEditor } from "./ConditionEditor";
import { FailureRulesEditor } from "./FailureRulesEditor";
import { Chip, Field, Issues, Mono, NumField, Pick, Row } from "./fields";
import { GateEditor } from "./GateEditor";
import { PromptEditor } from "./PromptEditor";

const DEFAULT_COND: Condition = { field: "job.remediationAttempts", op: "gt", value: 0 };
const Toggle = ({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) => (
  <div className="flex items-start gap-3"><Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled ?? false} className="mt-0.5" /><div className="grid gap-0.5"><label htmlFor={id} className="text-sm font-medium">{label}</label>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div></div>
);

/** Every setting of one stage, in tabs. `locked` is the reason a mandatory safety stage cannot be weakened (disabled, optional, conditional, skipped). */
const Body = ({ ro, className, children }: { ro: boolean; className?: string; children: React.ReactNode }) => <fieldset disabled={ro} className={`grid min-w-0 gap-4 border-0 p-0 ${className ?? ""}`}>{children}</fieldset>;

export function StagePanel({ stage, index, def, meta, issues, onChange, locked, readOnly = false }: { readOnly?: boolean; stage: StageDef; index: number; def: WorkflowDef; meta: WorkflowsMeta; issues: Issue[]; onChange: (fn: (s: StageDef) => StageDef) => void; locked?: string | undefined }) {
  const mine = issuesForStage(issues, index);
  const at = (f: string) => atField(mine, f);
  const set = (patch: Partial<StageDef>) => onChange((s) => ({ ...s, ...patch }));
  const others = def.stages.filter((s) => s.id !== stage.id);
  const typeMeta = meta.stageTypes.find((t) => t.type === stage.type);
  const isFactory = stage.type === "factory";
  const cfg = stage.config as Record<string, unknown>;
  const setCfg = (patch: Record<string, unknown>) => onChange((s) => ({ ...s, config: { ...s.config, ...patch } }));
  const route = defaultRouteOf(stage, meta);
  const help = BUILTIN_HELP[stage.handler ?? stage.id];
  const nextOptions = [{ value: COMPLETE, label: "Complete the job" }, ...others.map((o) => ({ value: o.id, label: `${o.name} (${o.id})` }))];
  const stageIds = def.stages.map((s) => s.id);
  const hasPrompt = stage.type === "agent" || stage.type === "review";
  const badge = (n: number) => (n ? <span className="ml-1 rounded-full bg-destructive px-1.5 text-[10px] text-white">{n}</span> : null);
  const errs = (...fields: string[]) => mine.filter((i) => i.severity === "error" && fields.some((f) => i.field === f || i.field.startsWith(`${f}.`))).length;

  return (
    <div className="grid gap-4" aria-label={`Settings of ${stage.name}`}>
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{stage.name}</h3><Badge variant="secondary">{typeMeta?.label ?? stage.type}</Badge><Mono>{stage.id}</Mono>{locked ? <Badge variant="outline" className="gap-1"><Lock className="size-3" />safety stage</Badge> : null}</div>
        {typeMeta ? <p className="text-xs text-muted-foreground">{typeMeta.description}</p> : null}
      </div>
      {locked ? <Alert><Lock /><AlertDescription>This is a mandatory safety stage: {locked}. It cannot be removed, disabled, made optional or conditional, or skipped on failure. Its order, limits, prompt additions, model and failure routing can still be tuned.</AlertDescription></Alert> : null}
      {mine.length ? <div className="rounded-md border p-2.5"><Issues issues={mine} /></div> : null}

      <Tabs defaultValue="general" key={stage.id}>
        <TabsList className="flex h-auto flex-wrap">
          <TabsTrigger value="general">General{badge(errs("name", "description", "type", "handler", "enabled", "required", "next", "runIf", "config", "id", "mutating"))}</TabsTrigger>
          {isFactory || hasPrompt ? <TabsTrigger value="prompt">Prompt{badge(errs("prompt"))}</TabsTrigger> : null}
          <TabsTrigger value="limits">Model &amp; limits{badge(errs("model", "timeoutSeconds", "retry"))}</TabsTrigger>
          <TabsTrigger value="gate">Gate &amp; failures{badge(errs("successGate", "onFailure"))}</TabsTrigger>
          <TabsTrigger value="wiring">Inputs &amp; budget{badge(errs("requires", "outputs", "budget"))}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="pt-2"><Body ro={readOnly} className="gap-4">
          <Field label="Name" htmlFor="st-name" issues={at("name")}><Input id="st-name" value={stage.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Description" htmlFor="st-desc" hint="Shown in the flow chart's step details." issues={at("description")}><Textarea id="st-desc" rows={2} value={stage.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          <Field label="Type" issues={at("type")} hint={isFactory ? `A built-in stage (${stage.handler}): its behaviour is fixed in code.` : "Changing the type resets the settings that belong to it (prompt, gate, type options)."}>
            <Pick label="Stage type" value={stage.type} disabled={isFactory} onChange={(v) => v && onChange((s) => changeType(meta, s, v as StageType))} options={meta.stageTypes.filter((t) => isFactory ? t.type === "factory" : t.type !== "factory").map((t) => ({ value: t.type, label: t.label }))} />
          </Field>
          {isFactory && help ? <p className="text-xs text-muted-foreground">{help.what}</p> : null}
          {stage.type === "agent" ? <Field label="Agent role" hint="Every role is read-only: a workflow cannot give an agent write access." issues={at("config.role")}><Pick label="Agent role" value={String(cfg.role ?? "")} onChange={(v) => v && setCfg({ role: v })} options={AGENT_ROLES.map((r) => ({ value: r, label: r }))} /></Field> : null}
          {stage.type === "review" ? (<>
            <Field label="Reviewer role" issues={at("config.role")}><Pick label="Reviewer role" value={String(cfg.role ?? "")} onChange={(v) => v && setCfg({ role: v })} options={REVIEW_ROLES.map((r) => ({ value: r, label: r }))} /></Field>
            <Field label="Blocking severities" hint="Findings at these severities send the job to a failure route. A critical finding always stops the job for a person." issues={at("config.blocking")}>
              <Row>{SEVERITIES.map((sv) => { const on = ((cfg.blocking as string[] | undefined) ?? []).includes(sv); return <Chip key={sv} on={on} onClick={() => setCfg({ blocking: on ? ((cfg.blocking as string[]) ?? []).filter((x) => x !== sv) : [...((cfg.blocking as string[]) ?? []), sv] })}>{sv}</Chip>; })}</Row>
            </Field>
          </>) : null}
          {stage.type === "check" ? <Field label="Command" hint="The command text comes from the project's own settings, never from the workflow." issues={at("config.command")}><Pick label="Check command" value={String(cfg.command ?? "test")} onChange={(v) => v && setCfg({ command: v })} options={CHECK_COMMANDS.map((c) => ({ value: c, label: c }))} /></Field> : null}
          {stage.type === "conditional" ? (
            <Field label="Condition" hint="Routes the job to one stage or another. Does no work of its own." issues={[...at("config.condition"), ...at("config.then"), ...at("config.else")]}>
              <ConditionEditor label="Condition" value={(cfg.condition as Condition | undefined) ?? DEFAULT_COND} onChange={(c) => setCfg({ condition: c })} stageIds={stageIds} />
              <Row><span className="text-sm text-muted-foreground">If it holds, go to</span><Pick label="then stage" value={String(cfg.then ?? COMPLETE)} onChange={(v) => v && setCfg({ then: v })} options={nextOptions} className="w-64" /></Row>
              <Row><span className="text-sm text-muted-foreground">Otherwise, go to</span><Pick label="else stage" value={String(cfg.else ?? COMPLETE)} onChange={(v) => v && setCfg({ else: v })} options={nextOptions} className="w-64" /></Row>
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle id="st-enabled" label="Enabled" hint="A disabled stage is passed over: the job never enters it." checked={stage.enabled} disabled={Boolean(locked)} onChange={(v) => set({ enabled: v })} />
            <Toggle id="st-required" label="Required" hint="A required stage cannot be disabled, made conditional or skipped by a failure rule." checked={stage.required} disabled={Boolean(locked)} onChange={(v) => set({ required: v })} />
            {!isFactory && stage.type !== "conditional" ? <Toggle id="st-mutating" label="Has side effects" hint="Changes the repository, tracker or host: skipped in a dry run, and only after the safety stages." checked={Boolean(stage.mutating)} onChange={(v) => set({ mutating: v })} /> : null}
          </div>
          {issues && at("enabled").length === 0 && at("required").length === 0 ? null : <Issues issues={[...at("enabled"), ...at("required")]} />}
          {stage.type !== "conditional" ? (
            <Field label="After success, go to" hint="Default: the next enabled stage in the list order." issues={at("next")}>
              <Pick label="Next stage" value={stage.next} empty="Next in order" onChange={(v) => set({ next: v })} options={nextOptions} className="w-72" />
            </Field>
          ) : null}
          <Field label="Run only if" hint="Otherwise the stage is skipped (and recorded as skipped). Needs the stage to be optional." issues={at("runIf")}>
            {stage.runIf ? (<>
              <ConditionEditor label="Run if" value={stage.runIf} onChange={(c) => set({ runIf: c })} stageIds={stageIds} />
              <div><Button type="button" variant="ghost" size="sm" disabled={Boolean(locked)} onClick={() => onChange((s) => { const { runIf: _r, ...rest } = s; void _r; return rest; })}><X />Always run</Button></div>
            </>) : <div><Button type="button" variant="outline" size="sm" disabled={Boolean(locked)} onClick={() => set({ runIf: { ...DEFAULT_COND }, required: false })}><Plus />Add a condition</Button></div>}
          </Field>
        </Body></TabsContent>

        {isFactory || hasPrompt ? (
          <TabsContent value="prompt" className="pt-2"><Body ro={readOnly}>
            {hasPrompt
              ? <PromptEditor mode="template" value={stage.prompt?.template ?? ""} onChange={(v) => set({ prompt: { ...stage.prompt, template: v } })} defaultPrompt={defaultPromptOf(meta, stage.type)} meta={meta} otherStageIds={others.map((o) => o.id)} issues={at("prompt")} />
              : <PromptEditor mode="instructions" value={stage.prompt?.instructions ?? ""} onChange={(v) => onChange((s) => { const { prompt: _p, ...rest } = s; void _p; return v ? { ...rest, prompt: { instructions: v } } : rest; })} defaultPrompt={null} meta={meta} otherStageIds={others.map((o) => o.id)} issues={at("prompt")} />}
          </Body></TabsContent>
        ) : null}

        <TabsContent value="limits" className="pt-2"><Body ro={readOnly} className="gap-4">
          {typeMeta?.usesModel ? (
            <Field label="Model" hint={route ? <>Default for this stage: the <Mono>{route.task}</Mono> route, {route.provider} / <Mono>{route.model}</Mono>. Leave both empty to use it.</> : "Leave both empty to use the configured route. The project's own model settings still apply underneath."} issues={at("model")}>
              <Row>
                <Pick label="Provider" value={stage.model?.provider} empty="Default provider" onChange={(v) => onChange((s) => { const m = { ...s.model, provider: v as "local" | "anthropic" | undefined }; if (!m.provider) delete m.provider; const { model: _m, ...rest } = s; void _m; return Object.keys(m).length ? { ...rest, model: m } : rest; })} options={meta.models.providers.map((p) => ({ value: p, label: p === "anthropic" ? "Claude (anthropic)" : p }))} className="w-52" />
                <Input aria-label="Model id" className="w-64 font-mono text-xs" value={stage.model?.model ?? ""} placeholder={route ? route.model : "model id or alias"} onChange={(e) => onChange((s) => { const m = { ...s.model, model: e.target.value.trim() || undefined }; if (!m.model) delete m.model; const { model: _m, ...rest } = s; void _m; return Object.keys(m).length ? { ...rest, model: m } : rest; })} />
              </Row>
            </Field>
          ) : <p className="text-sm text-muted-foreground">This stage type does not use a model.</p>}
          <Field label="Timeout" hint={`Seconds this stage may run (1 to ${meta.limits.maxStageTimeoutSeconds ?? 86400}).`} issues={at("timeoutSeconds")}><NumField label="Timeout seconds" value={stage.timeoutSeconds} min={1} max={meta.limits.maxStageTimeoutSeconds ?? 86400} onChange={(n) => n !== undefined && set({ timeoutSeconds: n })} className="w-36" /></Field>
          <Field label="Retries" hint={`How many times a failed attempt is retried before the failure rules below decide (0 to ${meta.limits.maxRetries ?? 10}).`} issues={at("retry")}>
            <Row>
              <NumField label="Max retries" value={stage.retry.max} min={0} max={meta.limits.maxRetries ?? 10} onChange={(n) => n !== undefined && set({ retry: { ...stage.retry, max: n } })} className="w-20" /><span className="text-sm text-muted-foreground">retries, waiting</span>
              <NumField label="Retry delay seconds" value={stage.retry.delaySeconds} optional min={0} max={meta.limits.maxRetryDelaySeconds ?? 3600} onChange={(n) => set({ retry: { max: stage.retry.max, backoff: stage.retry.backoff, ...(n !== undefined ? { delaySeconds: n } : {}) } })} className="w-24" /><span className="text-sm text-muted-foreground">seconds (empty: the engine's default)</span>
            </Row>
            <Toggle id="st-backoff" label="Back off" hint="Double the delay on every consecutive failure." checked={stage.retry.backoff} onChange={(v) => set({ retry: { ...stage.retry, backoff: v } })} />
          </Field>
        </Body></TabsContent>

        <TabsContent value="gate" className="pt-2"><Body ro={readOnly} className="gap-6">
          <section className="grid gap-2"><h4 className="text-sm font-semibold">Success gate</h4>
            <GateEditor gate={stage.successGate} onChange={(g) => set({ successGate: g })} meta={meta} stageType={stage.type} stageIds={stageIds} /><Issues issues={at("successGate")} /></section>
          <section className="grid gap-2"><h4 className="text-sm font-semibold">Failure rules</h4>
            <FailureRulesEditor rules={stage.onFailure} onChange={(r) => set({ onFailure: r })} meta={meta} selfId={stage.id} others={others.map((o) => ({ id: o.id, name: o.name }))} required={stage.required} locked={Boolean(locked)} issues={mine} /></section>
        </Body></TabsContent>

        <TabsContent value="wiring" className="pt-2"><Body ro={readOnly} className="gap-4">
          <Field label="Needs the output of" hint="The job is blocked (not run) if any of these stages has not succeeded in this job." issues={at("requires")}>
            {others.length ? <Row>{others.map((o) => <Chip key={o.id} on={stage.requires.includes(o.id)} onClick={() => set({ requires: stage.requires.includes(o.id) ? stage.requires.filter((r) => r !== o.id) : [...stage.requires, o.id] })} title={o.id}>{o.name}</Chip>)}</Row> : <p className="text-xs text-muted-foreground">No other stages.</p>}
          </Field>
          <Field label="Outputs" hint="The named values this stage produces, for the people reading the workflow. Later stages read them as {{outputs.STAGE_ID.name}}." issues={at("outputs")}>
            {stage.outputs.map((o, i) => (
              <Row key={i}>
                <Input aria-label={`output ${i + 1} name`} className="w-40 font-mono text-xs" value={o.name} placeholder="name" onChange={(e) => set({ outputs: stage.outputs.map((x, k) => (k === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x)) })} />
                <Input aria-label={`output ${i + 1} description`} className="w-72" value={o.description} placeholder="what it holds" onChange={(e) => set({ outputs: stage.outputs.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)) })} />
                <Button type="button" variant="ghost" size="sm" aria-label={`remove output ${i + 1}`} onClick={() => set({ outputs: stage.outputs.filter((_, k) => k !== i) })}><X /></Button>
              </Row>
            ))}
            <div><Button type="button" variant="outline" size="sm" disabled={stage.outputs.length >= 20} onClick={() => set({ outputs: [...stage.outputs, { name: "", description: "" }] })}><Plus />Add output</Button></div>
          </Field>
          <Field label="Fix-cycle budget" hint="A failure route out of this stage spends the budget of this phase. Entering the stage can start a fresh budget." issues={at("budget")}>
            <Row>
              <Pick label="Budget phase" value={stage.budget?.phase} empty="Default (code)" onChange={(v) => onChange((s) => { if (!v) { const { budget: _b, ...rest } = s; void _b; return rest; } return { ...s, budget: { resetOnEntry: false, ...s.budget, phase: v as (typeof PHASES)[number] } }; })} options={PHASES.map((p) => ({ value: p, label: p }))} className="w-44" />
              {stage.budget ? <Toggle id="st-reset" label="Fresh budget on entry" checked={stage.budget.resetOnEntry} onChange={(v) => set({ budget: { phase: stage.budget!.phase, resetOnEntry: v } })} /> : null}
            </Row>
          </Field>
        </Body></TabsContent>
      </Tabs>
    </div>
  );
}
