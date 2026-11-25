import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { send } from "@/lib/api";
import type { Project, TeamAudit } from "@/lib/types";
import { TASKS, type GlobalSettings, type Routes, type RouteCfg, type TaskId } from "@/lib/tasks";
import { ModelPicker } from "./ModelPicker";
import { startAction, TaskOutput } from "./TaskRunner";

const CMDS = ["install", "build", "typecheck", "lint", "test"] as const;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export interface Form { conc: string; fix: string; models: Partial<Routes>; id: string; name: string; source: "github" | "path"; repo: string; path: string; account: string; branch: string; autonomy: string; team: string; lproject: string; enabled: boolean; commands: Record<string, string> }
const blank = (): Form => ({ conc: "", fix: "", models: {}, id: "", name: "", source: "github", repo: "", path: "", account: "", branch: "main", autonomy: "supervised", team: "", lproject: "", enabled: true, commands: {} });
const fromProject = (p: Project): Form => ({
  conc: p.overrides?.maxConcurrentJobs?.toString() ?? "", fix: p.overrides?.maxRemediationAttempts?.toString() ?? "", models: { ...(p.overrides?.models ?? {}) },
  id: p.id, name: p.name, source: p.managed ? "github" : "path", repo: p.githubRepo ?? "", path: p.managed ? "" : p.repository, account: p.githubAccount ?? "", branch: p.defaultBranch, autonomy: p.autonomy,
  team: p.linear?.teamKey ?? "", lproject: p.linear?.projectName ?? "", enabled: p.enabled, commands: Object.fromEntries(CMDS.map((k) => [k, p.commands[k] ?? ""])),
});
const same = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="grid gap-3"><div><h3 className="text-sm font-semibold">{title}</h3>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>{children}</section>
);

/** The whole editor for one project (or a new one). Server-side validation (duplicate repos, shared Linear targets, bad ids) is shown verbatim. */
export function ProjectEditor({ project, teams, globals, onSaved, onRemoved, onDirty }: { project: Project | null; teams: TeamAudit[]; globals?: GlobalSettings | null; onSaved: (id: string) => void; onRemoved?: () => void; onDirty?: (d: boolean) => void }) {
  const initial = useMemo(() => (project ? fromProject(project) : blank()), [project]);
  const [f, setF] = useState<Form>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  useEffect(() => { setF(initial); setErr(null); setSaved(false); }, [initial]);
  const dirty = !same(f, initial);
  useEffect(() => { onDirty?.(dirty); }, [dirty, onDirty]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setSaved(false); setF((x) => ({ ...x, [k]: v })); };
  const team = teams.find((t) => t.key === f.team);
  const id = project?.id ?? (f.id || slug(f.name));

  const save = async () => {
    setBusy(true); setErr(null);
    const commands = Object.fromEntries(CMDS.filter((k) => f.commands[k]?.trim()).map((k) => [k, f.commands[k]!.trim()]));
    const r = await send("PUT", `/api/settings/projects/${encodeURIComponent(id)}`, {
      name: f.name.trim(), defaultBranch: f.branch.trim() || "main", enabled: f.enabled, autonomy: f.autonomy, commands,
      ...(f.source === "github" ? { github: { repo: f.repo.trim(), account: f.account.trim() || undefined } } : { repository: f.path.trim(), github: { account: f.account.trim() || undefined, repo: f.repo.trim() || undefined } }),
      overrides: { maxConcurrentJobs: f.conc ? Number(f.conc) : undefined, maxRemediationAttempts: f.fix !== "" ? Number(f.fix) : undefined, models: f.models },
      ...(f.team ? { linear: { teamKey: f.team, projectName: f.lproject || undefined } } : {}),
    });
    setBusy(false);
    if (r.ok) { setSaved(true); onSaved(id); } else setErr(r.error);
  };
  const remove = async () => { const r = await send("DELETE", `/api/settings/projects/${encodeURIComponent(id)}`); if (r.ok) onRemoved?.(); else setErr(r.error); };
  const run = async (kind: string) => { setErr(null); const r = await startAction(id, kind); if (r.ok) setTask(r.data.taskId); else setErr(r.error); };
  const noTest = !f.commands.test?.trim();

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{project ? project.name : "New project"}</h2>
        {project && !project.enabled ? <Badge variant="outline">disabled</Badge> : null}
        {project?.validation ? <Badge variant="outline" className={project.validation.ok ? "border-ok/40 text-ok" : "border-destructive/40 text-destructive"}>{project.validation.ok ? "validated" : "validation failing"}</Badge> : null}
        {project ? (
          <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" size="sm"><Trash2 />Remove</Button></AlertDialogTrigger>
            <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {project.name}?</AlertDialogTitle><AlertDialogDescription>It stops picking up tickets. Existing jobs, the clone and your repository are left alone.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        ) : null}
      </div>

      <Section title="General" hint="One Linear project maps to one repository. Nothing starts until a ticket in that Linear project is labelled and moved to the pickup status.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="pe-name">Name</Label><Input id="pe-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="My App" /></div>
          <div className="grid gap-1.5"><Label htmlFor="pe-id">Id</Label><Input id="pe-id" disabled={!!project} value={project ? project.id : f.id || slug(f.name)} onChange={(e) => set("id", slug(e.target.value))} placeholder="my-app" /></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>Autonomy</Label>
            <Select value={f.autonomy} onValueChange={(v) => set("autonomy", v)}><SelectTrigger aria-label="autonomy"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="supervised">supervised</SelectItem><SelectItem value="full">full</SelectItem><SelectItem value="off">off</SelectItem></SelectContent></Select></div>
          <div className="flex items-end gap-2 pb-2"><Switch id="pe-en" checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} /><Label htmlFor="pe-en">Enabled (picks up tickets)</Label></div>
        </div>
      </Section>
      <Separator />
      <Section title="Repository">
        <Select value={f.source} onValueChange={(v) => set("source", v as Form["source"])}><SelectTrigger aria-label="repository source"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="github">GitHub: the factory keeps its own clone (recommended)</SelectItem><SelectItem value="path">An existing checkout on this machine</SelectItem></SelectContent></Select>
        {f.source === "github" ? <Input aria-label="GitHub repo" value={f.repo} onChange={(e) => set("repo", e.target.value)} placeholder="owner/name" /> : <Input aria-label="checkout path" value={f.path} onChange={(e) => set("path", e.target.value)} placeholder="~/projects/my-app" />}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="pe-acct">GitHub account (gh)</Label><Input id="pe-acct" value={f.account} onChange={(e) => set("account", e.target.value)} placeholder="optional" /></div>
          <div className="grid gap-1.5"><Label htmlFor="pe-branch">Default branch</Label><Input id="pe-branch" value={f.branch} onChange={(e) => set("branch", e.target.value)} /></div>
        </div>
      </Section>
      <Separator />
      <Section title="Linear">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="pe-team">Team key</Label>
            {teams.length ? <Select value={f.team || "__none"} onValueChange={(v) => { set("team", v === "__none" ? "" : v); set("lproject", ""); }}><SelectTrigger id="pe-team" aria-label="linear team"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="__none">(none)</SelectItem>{teams.map((t) => <SelectItem key={t.key} value={t.key}>{t.key} · {t.name}</SelectItem>)}</SelectContent></Select>
              : <Input id="pe-team" value={f.team} onChange={(e) => set("team", e.target.value.toUpperCase())} placeholder="ENG" />}</div>
          <div className="grid gap-1.5"><Label htmlFor="pe-lp">Project</Label>
            {team?.projects.length ? <Select value={f.lproject || "__all"} onValueChange={(v) => set("lproject", v === "__all" ? "" : v)}><SelectTrigger id="pe-lp" aria-label="linear project"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="__all">(whole team)</SelectItem>{team.projects.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select>
              : <Input id="pe-lp" value={f.lproject} onChange={(e) => set("lproject", e.target.value)} placeholder="optional" />}</div>
        </div>
      </Section>
      <Separator />
      <Section title="Commands" hint="Run by the factory in a throwaway worktree, sandboxed. A test command is required before it will implement anything: use the project's own CI as the guide, then press “Run checks” to prove they work.">
        <div className="grid gap-3 sm:grid-cols-2">{CMDS.map((k) => <div key={k} className="grid gap-1.5"><Label htmlFor={`pe-c-${k}`} className="capitalize">{k}</Label><Input id={`pe-c-${k}`} className="font-mono text-xs" value={f.commands[k] ?? ""} onChange={(e) => set("commands", { ...f.commands, [k]: e.target.value })} placeholder={k === "test" ? "npm test" : ""} /></div>)}</div>
        {noTest ? <p className="text-sm text-loop">No test command: the factory will not implement changes here yet.</p> : null}
      </Section>

      <Separator />
      <Section title="Overrides" hint="Leave a setting on “global” to follow Settings → Workflow. Anything you set here applies to this project only.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="pe-conc">Concurrent jobs</Label>
            <div className="flex items-center gap-2"><Input id="pe-conc" type="number" min={1} max={8} className="w-24" value={f.conc} placeholder="1" onChange={(e) => set("conc", e.target.value)} />
              <span className="text-xs text-muted-foreground">{f.conc ? <button type="button" className="underline" onClick={() => set("conc", "")}>use default (1)</button> : "default: 1 (its jobs share one clone)"}</span></div></div>
          <div className="grid gap-1.5"><Label htmlFor="pe-fix">Fix cycle limit</Label>
            <div className="flex items-center gap-2"><Input id="pe-fix" type="number" min={0} max={10} className="w-24" value={f.fix} placeholder={String(globals?.maxRemediationAttempts ?? 3)} onChange={(e) => set("fix", e.target.value)} />
              <span className="text-xs text-muted-foreground">{f.fix !== "" ? <button type="button" className="underline" onClick={() => set("fix", "")}>use global ({globals?.maxRemediationAttempts ?? 3})</button> : `global: ${globals?.maxRemediationAttempts ?? 3}`}</span></div></div>
        </div>
        <div className="grid gap-3">
          {TASKS.map((t) => {
            const own = f.models[t.id], glob = globals?.routes[t.id];
            return (
              <div key={t.id} className="grid gap-1.5"><div className="flex flex-wrap items-baseline gap-x-3"><Label>{t.label} model</Label>
                {own ? <button type="button" className="text-xs underline" onClick={() => { const m = { ...f.models }; delete m[t.id]; set("models", m); }}>use global ({glob?.model ?? "…"})</button> : <span className="text-xs text-muted-foreground">global: {glob?.model ?? "…"}</span>}</div>
                {own ? <ModelPicker label={`${t.label} override`} allowLocal={t.local} value={own} onChange={(v: RouteCfg) => set("models", { ...f.models, [t.id as TaskId]: v })} />
                  : <div><Button type="button" size="sm" variant="outline" onClick={() => set("models", { ...f.models, [t.id]: glob ?? { provider: "anthropic", model: "default" } })}>Override for this project</Button></div>}
              </div>
            );
          })}
        </div>
      </Section>

      {project ? (<>
        <Separator />
        <Section title="Prepare the repository" hint="These use the saved settings: save first if you changed anything.">
          <div className="flex flex-wrap gap-2">
            {([["sync", "Clone"], ["validate", "Validate"], ["check", "Run checks"]] as const).map(([k, label]) => <Button key={k} size="sm" variant="secondary" disabled={dirty} onClick={() => void run(k)}>{label}</Button>)}
            <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="secondary" disabled={dirty}>Onboard Spec Kit…</Button></AlertDialogTrigger>
              <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Onboard {project.name}?</AlertDialogTitle>
                <AlertDialogDescription>Adds Spec Kit and a constitution on a review branch. “Open a pull request” also pushes that branch to {project.githubRepo ?? "the repository"} and opens a PR for you to review. The factory never merges anything.</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><Button variant="outline" onClick={() => void run("onboard")}>Local branch only</Button><AlertDialogAction onClick={() => void run("onboard-pr")}>Open a pull request</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
          </div>
          {task ? <TaskOutput taskId={task} onDone={() => onSaved(id)} /> : null}
        </Section>
      </>) : null}

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t bg-card/95 px-1 py-3 backdrop-blur">
        {err ? <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">{err}</p> : <p className="flex-1 text-sm text-muted-foreground">{saved ? "Saved. Applied immediately." : dirty ? "Unsaved changes" : ""}</p>}
        <Button variant="outline" disabled={!dirty} onClick={() => setF(initial)}>Revert</Button>
        <Button disabled={busy || !f.name.trim() || (!project && !dirty)} onClick={() => void save()}>{project ? "Save changes" : "Create project"}</Button>
      </div>
    </div>
  );
}
