import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/ModelPicker";
import { api, send } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { GhAccounts } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { DEFAULT_PROMPT_ROUTE, TASKS, type GlobalSettings } from "@/lib/tasks";

/** A number box you can clear and retype: it only commits a value once something valid is typed, clamps to the range, and restores on blur if left empty. */
function NumberField({ id, value, min, max, onChange }: { id: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  return (
    <Input id={id} type="number" inputMode="numeric" min={min} max={max} className="w-28" value={text}
      onChange={(e) => { const raw = e.target.value; if (raw === "") return setText(""); const n = Math.min(max, Math.max(min, Math.trunc(Number(raw)))); if (Number.isNaN(n)) return; setText(String(n)); onChange(n); }}
      onBlur={() => setText(String(value))} />
  );
}

/** Factory-wide defaults. Any project can override each of these in its own editor. Applies immediately, no restart. */
export function WorkflowSettings({ value, onSaved }: { value: GlobalSettings | null; onSaved: () => void }) {
  const [g, setG] = useState<GlobalSettings | null>(value);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { data: gh } = usePoll(() => api<GhAccounts>("/api/setup/github"), 60000);
  useEffect(() => { if (value) setG(value); }, [value]);
  if (!g || !value) return null;
  const dirty = JSON.stringify(g) !== JSON.stringify(value);
  const save = async () => { setErr(null); const r = await send("PUT", "/api/settings/global", g); if (r.ok) { setSaved(true); onSaved(); } else setErr(r.error); };
  return (
    <div className="grid gap-4">
      <Card><CardHeader><CardTitle className="text-sm">Ticket pickup</CardTitle><CardDescription>How tickets get started.</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Ticket pickup">
            {([["automatic", "Automatic", "Tickets labelled factory:enabled in the pickup status are started on their own."], ["manual", "Manual", "Nothing starts by itself. You pick tickets on the Board."]] as const).map(([v, label, hint]) => (
              <button key={v} type="button" role="radio" aria-checked={(g.pickupMode ?? "automatic") === v} onClick={() => { setSaved(false); setG({ ...g, pickupMode: v }); }}
                className={`grid max-w-sm flex-1 gap-0.5 rounded-md border p-3 max-md:max-w-none max-md:basis-full text-left text-sm transition-colors hover:bg-accent ${(g.pickupMode ?? "automatic") === v ? "border-foreground bg-accent" : ""}`}><b>{label}</b><span className="text-xs text-muted-foreground">{hint}</span></button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">A project can override this in its own settings. In either mode you can start any ticket yourself from the Board (it needs no label or status), and a project must be fully onboarded first.</p>
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Planning</CardTitle><CardDescription>How a ticket becomes an implementation. Chosen per profile.</CardDescription></CardHeader>
        <CardContent className="grid gap-2">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Planning mode">
            {([["haiku_prompt", "Haiku prompt", "Claude Haiku reads the ticket and the repository and writes one concise prompt for the implementer. Fast, no spec files. The default."], ["speckit", "Spec Kit", "The full Spec Kit flow: specify, clarify, plan, tasks, independent spec review and validation, and a completeness check after implementing. Needs .specify/ in each repository."]] as const).map(([v, label, hint]) => (
              <button key={v} type="button" role="radio" aria-checked={(g.planningMode ?? "haiku_prompt") === v} onClick={() => { setSaved(false); setG({ ...g, planningMode: v }); }}
                className={`grid max-w-sm flex-1 gap-0.5 rounded-md border p-3 max-md:max-w-none max-md:basis-full text-left text-sm transition-colors hover:bg-accent ${(g.planningMode ?? "haiku_prompt") === v ? "border-foreground bg-accent" : ""}`}><b>{label}</b><span className="text-xs text-muted-foreground">{hint}</span></button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Takes effect at each job's next stage. Also set as <code>workflow.planning_mode</code> in this profile's factory.yaml.</p>
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">GitHub account</CardTitle><CardDescription>The <code>gh</code> login this profile uses to clone, push branches and open pull requests. A project can name a different one. Your machine's own active gh login is never switched.</CardDescription></CardHeader>
        <CardContent className="grid gap-1.5">
          <Select value={g.githubAccount || "__none"} onValueChange={(v) => { setSaved(false); setG({ ...g, githubAccount: v === "__none" ? "" : v }); }}>
            <SelectTrigger className="w-72" aria-label="GitHub account"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="__none">gh's active login (don't pin)</SelectItem>{(gh?.accounts ?? []).map((a) => <SelectItem key={a.login} value={a.login}>{a.login}{a.active ? " (active)" : ""}</SelectItem>)}</SelectContent></Select>
          {gh && gh.accounts.length === 0 ? <p className="text-xs text-loop">gh has no logins yet: run <code>gh auth login</code>.</p> : <p className="text-xs text-muted-foreground">Logged in on this machine: {(gh?.accounts ?? []).map((a) => a.login).join(", ") || "…"}. Add another with <code>gh auth login</code>.</p>}
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Limits</CardTitle><CardDescription>Defaults for every project.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="wf-conc">Concurrent jobs</Label>
            <NumberField id="wf-conc" min={1} max={8} value={g.maxConcurrentJobs} onChange={(n) => { setSaved(false); setG({ ...g, maxConcurrentJobs: n }); }} />
            <p className="text-xs text-muted-foreground">Tickets worked on at once, across all projects (1–8). Each Claude run uses real memory and subscription usage. A single project still runs one job at a time unless you raise it in that project's overrides. Each job has its own worktree, but tickets in one repository often touch the same files and would raise conflicting pull requests.</p></div>
          <div className="grid gap-1.5"><Label htmlFor="wf-passes">Implementation passes</Label>
            <NumberField id="wf-passes" min={1} max={10} value={g.maxImplementationPasses ?? 3} onChange={(n) => { setSaved(false); setG({ ...g, maxImplementationPasses: n }); }} />
            <p className="text-xs text-muted-foreground">How many times the factory may implement, then check the result against the spec and add tasks for any gaps, before it stops for you (1–10, default 3). Raise it for large tickets. This is separate from the fix cycle limit, which counts review and CI fixes.</p></div>
          <div className="grid gap-1.5"><Label htmlFor="wf-fix">Fix cycle limit</Label>
            <NumberField id="wf-fix" min={0} max={10} value={g.maxRemediationAttempts} onChange={(n) => { setSaved(false); setG({ ...g, maxRemediationAttempts: n }); }} />
            <p className="text-xs text-muted-foreground">How many times reviews and failing checks may send work back for fixes before the job stops for you (0–10). Shared by spec fixes, review fixes and CI fixes.</p></div>
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Models</CardTitle><CardDescription>Which model does each part of the workflow. <b>default</b> lets Claude Code choose; an alias tracks that family's latest; a full id pins one. Keep Independent review different from the model that wrote the work.</CardDescription></CardHeader>
        <CardContent className="grid gap-4">
          {TASKS.map((t) => (
            <div key={t.id} className="grid gap-1.5 border-b pb-4 last:border-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-3"><b className="text-sm">{t.label}</b><span className="text-xs text-muted-foreground">{t.steps}</span></div>
              <ModelPicker label={t.label} allowLocal={t.local} value={g.routes[t.id] ?? DEFAULT_PROMPT_ROUTE} onChange={(v) => { setSaved(false); setG({ ...g, routes: { ...g.routes, [t.id]: v } }); }} />
            </div>
          ))}
          {g.routes.independent_review.model === g.routes.specification.model && g.routes.independent_review.provider === g.routes.specification.provider
            ? <Alert><AlertDescription>Independent review uses the same model as Specification, so it is partly marking its own work. Pick a different one for a genuinely independent review.</AlertDescription></Alert> : null}
        </CardContent></Card>
      <div className="flex flex-wrap items-center gap-3 max-md:sticky max-md:bottom-0 max-md:z-10 max-md:-mx-4 max-md:gap-2 max-md:border-t max-md:border-line max-md:bg-background/95 max-md:px-4 max-md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)] max-md:pt-3 max-md:backdrop-blur">
        {err ? <p role="alert" className="flex-1 text-sm text-destructive">{err}</p> : <p className="flex-1 text-sm text-muted-foreground max-md:basis-full max-md:empty:hidden">{saved && !dirty ? "Saved. Applied immediately; running jobs pick it up at their next step." : dirty ? "Unsaved changes" : ""}</p>}
        <Button variant="outline" className="max-md:flex-1" disabled={!dirty} onClick={() => setG(value)}>Revert</Button><Button className="max-md:flex-[2]" disabled={!dirty} onClick={() => void save()}>Save settings</Button>
      </div>
    </div>
  );
}
