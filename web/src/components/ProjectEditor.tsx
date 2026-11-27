import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { api, send } from "@/lib/api";
import { usePoll } from "@/hooks/usePoll";
import { BUILTIN_ENTRIES, WORDS, withTracker } from "@/lib/trackers";
import type { GhAccounts } from "@/lib/types";
import type { BitbucketCredential, Project, TeamAudit, TrackerEntry } from "@/lib/types";
import { DEFAULT_PROMPT_ROUTE, TASKS, type GlobalSettings, type Routes, type RouteCfg, type TaskId } from "@/lib/tasks";
import { ModelPicker } from "./ModelPicker";
import { startAction, TaskOutput } from "./TaskRunner";

const CMDS = ["install", "build", "typecheck", "lint", "test"] as const;
/** Repos, paths, branches and commands: no capital letter or "correction" from a phone keyboard. */
const CODE = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export interface Form { passes: string; host: "github" | "bitbucket"; bbRepo: string; bbCred: string; pickup: string; access: string; loopback: boolean; specKit: boolean; bashAllow: string; lprojectId: string; conc: string; fix: string; models: Partial<Routes>; id: string; name: string; source: "github" | "path"; repo: string; path: string; account: string; branch: string; autonomy: string; tracker: string; team: string; lproject: string; enabled: boolean; commands: Record<string, string> }
const blank = (): Form => ({ passes: "", host: "github", bbRepo: "", bbCred: "default", pickup: "", access: "", loopback: false, specKit: true, bashAllow: "", lprojectId: "", conc: "", fix: "", models: {}, id: "", name: "", source: "github", repo: "", path: "", account: "", branch: "main", autonomy: "supervised", tracker: "", team: "", lproject: "", enabled: true, commands: {} });
const fromProject = (p: Project): Form => ({
  host: p.host ?? "github", bbRepo: p.bitbucketRepo ?? "", bbCred: p.bitbucketCredential ?? "default",
  passes: p.overrides?.maxImplementationPasses?.toString() ?? "",
  pickup: p.overrides?.pickupMode ?? "", access: p.overrides?.agentAccess ?? "", loopback: p.allowLoopback ?? false, specKit: p.specKit ?? true, bashAllow: (p.agentBashAllow ?? []).join("\n"), lprojectId: p.linear?.projectId ?? "", conc: p.overrides?.maxConcurrentJobs?.toString() ?? "", fix: p.overrides?.maxRemediationAttempts?.toString() ?? "", models: { ...(p.overrides?.models ?? {}) },
  id: p.id, name: p.name, source: p.managed ? "github" : "path", repo: p.githubRepo ?? "", path: p.managed ? "" : p.repository, account: p.githubAccount ?? "", branch: p.defaultBranch, autonomy: p.autonomy,
  tracker: p.tracker ?? "", team: p.linear?.teamKey ?? "", lproject: p.linear?.projectName ?? "", enabled: p.enabled, commands: Object.fromEntries(CMDS.map((k) => [k, p.commands[k] ?? ""])),
});
const same = (a: Form, b: Form) => JSON.stringify(a) === JSON.stringify(b);

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="grid gap-3 max-md:grid-cols-[minmax(0,1fr)]"><div><h3 className="text-sm font-semibold">{title}</h3>{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}</div>{children}</section>
);

/** The whole editor for one project (or a new one). Server-side validation (duplicate repos, shared Linear targets, bad ids) is shown verbatim. */
export function ProjectEditor({ project, teams, globals, tracker, onSaved, onRemoved, onDirty }: { project: Project | null; teams: TeamAudit[]; globals?: GlobalSettings | null; tracker?: "linear" | "jira" | "github"; onSaved: (id: string) => void; onRemoved?: () => void; onDirty?: (d: boolean) => void }) {
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
  const { data: gh } = usePoll(() => api<GhAccounts>("/api/setup/github"), 120000);
  const { data: creds } = usePoll(() => api<{ credentials: BitbucketCredential[] }>("/api/bitbucket/credentials"), 60000);
  const [access, setAccess] = useState<string | null>(null);
  // Which tracker connection this project's tickets live in: its own, else the profile's default. Teams come from that connection.
  const { data: trackerList } = usePoll(() => api<{ default: string; trackers: TrackerEntry[] }>("/api/trackers"), 60000);
  const connections = trackerList?.trackers ?? BUILTIN_ENTRIES(tracker ?? "linear");
  const defaultConn = connections.find((c) => c.isDefault) ?? connections[0]!;
  const chosen = connections.find((c) => c.id === (f.tracker || defaultConn.id)) ?? defaultConn;
  const ownTracker = f.tracker !== "" && f.tracker !== defaultConn.id;
  const { data: ownTeams } = usePoll(async () => (ownTracker ? (await api<{ teams: TeamAudit[] }>(withTracker("/api/setup/linear", f.tracker, defaultConn.id))).teams : null), 120000, [f.tracker, ownTracker]);
  const pickList = ownTracker ? (ownTeams ?? []) : teams;
  const words = WORDS[chosen.kind];
  const team = pickList.find((t) => t.key === f.team);
  const id = project?.id ?? (f.id || slug(f.name));

  const save = async () => {
    setBusy(true); setErr(null);
    const commands = Object.fromEntries(CMDS.filter((k) => f.commands[k]?.trim()).map((k) => [k, f.commands[k]!.trim()]));
    const r = await send("PUT", `/api/settings/projects/${encodeURIComponent(id)}`, {
      name: f.name.trim(), defaultBranch: f.branch.trim() || "main", enabled: f.enabled, autonomy: f.autonomy, commands,
      host: f.host,
      ...(f.tracker ? { tracker: f.tracker } : {}),
      ...(f.host === "bitbucket"
        ? { bitbucket: { repo: f.bbRepo.trim() || undefined, credential: f.bbCred }, ...(f.source === "path" ? { repository: f.path.trim() } : {}) }
        : f.source === "github" ? { github: { repo: f.repo.trim(), account: f.account.trim() || undefined } } : { repository: f.path.trim(), github: { account: f.account.trim() || undefined, repo: f.repo.trim() || undefined } }),
      allowLoopback: f.loopback, specKit: f.specKit, agentBashAllow: f.bashAllow.split("\n").map((l) => l.trim()).filter(Boolean),
      overrides: { maxImplementationPasses: f.passes ? Number(f.passes) : undefined, pickupMode: f.pickup || undefined, agentAccess: (f.access || undefined) as "restricted" | "unrestricted" | undefined, maxConcurrentJobs: f.conc ? Number(f.conc) : undefined, maxRemediationAttempts: f.fix !== "" ? Number(f.fix) : undefined, models: f.models },
      ...(f.team ? { linear: { teamKey: f.team, projectName: f.lproject || undefined, projectId: f.lprojectId.trim() || undefined } } : {}),
    });
    setBusy(false);
    if (r.ok) { setSaved(true); onSaved(id); } else setErr(r.error);
  };
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    if (removing) return;
    setRemoving(true); setRemoveErr(null);
    const r = await send("DELETE", `/api/settings/projects/${encodeURIComponent(id)}`);
    setRemoving(false);
    if (r.ok) onRemoved?.(); else setRemoveErr(r.error); // e.g. 409: the project still has active jobs
  };
  const activeJobs = project?.activeJobs ?? 0;
  const run = async (kind: string) => { setErr(null); const r = await startAction(id, kind); if (r.ok) setTask(r.data.taskId); else setErr(r.error); };
  const noTest = !f.commands.test?.trim();

  return (
    <div className="grid gap-6 max-md:grid-cols-[minmax(0,1fr)] max-md:[&_.grid]:grid-cols-[minmax(0,1fr)]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{project ? project.name : "New project"}</h2>
        {project && !project.enabled ? <Badge variant="outline">disabled</Badge> : null}
        {project?.validation ? <Badge variant="outline" className={project.validation.ok ? "border-ok/40 text-ok" : "border-destructive/40 text-destructive"}>{project.validation.ok ? "validated" : "validation failing"}</Badge> : null}
        {project ? (
          <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" size="sm" disabled={removing || activeJobs > 0} title={activeJobs > 0 ? `${activeJobs} active job(s): finish or cancel them first` : undefined}><Trash2 />Remove</Button></AlertDialogTrigger>
            <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {project.name}?</AlertDialogTitle><AlertDialogDescription>It stops picking up tickets. Existing jobs, the clone and your repository are left alone.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        ) : null}
      </div>
      {removeErr ? <p role="alert" className="-mt-4 text-sm text-destructive">Could not remove: {removeErr}</p>
        : activeJobs > 0 ? <p className="-mt-4 text-xs text-muted-foreground">{activeJobs} active job(s) use this project: it can be removed once they finish or are cancelled.</p> : null}

      {project?.onboarding ? (
        <section className="grid gap-2 rounded-lg border bg-muted/20 p-4" aria-label="Onboarding">
          <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Onboarding</h3>
            <Badge variant="outline" className={cn(project.onboarding.status === "ready" ? "border-ok/40 text-ok" : project.onboarding.status === "in-progress" ? "border-loop/40 text-loop" : "text-muted-foreground")}>
              {project.onboarding.status === "ready" ? "Ready: tickets will be picked up" : project.onboarding.status === "in-progress" ? "Almost there: tickets are skipped until all of this is done" : "Not started: tickets are skipped until all of this is done"}</Badge></div>
          <ul className="grid gap-1.5 text-sm">
            {project.onboarding.steps.map((st) => (
              <li key={st.id} className="flex items-start gap-2">
                {st.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-label="done" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="to do" />}
                <span className="min-w-0"><span className={cn(!st.ok && "font-medium")}>{st.label}</span><span className="block truncate text-xs text-muted-foreground" title={st.detail}>{st.detail}</span></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Section title="General" hint="One Linear project maps to one repository. Nothing starts until a ticket in that Linear project is labelled and moved to the pickup status.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="pe-name">Name</Label><Input id="pe-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="My App" /></div>
          <div className="grid gap-1.5"><Label htmlFor="pe-id">Id</Label><Input id="pe-id" {...CODE} disabled={!!project} value={project ? project.id : f.id || slug(f.name)} onChange={(e) => set("id", slug(e.target.value))} placeholder="my-app" /></div>
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
        <div className="grid gap-1.5"><Label>Hosted on</Label>
          <Select value={f.host} onValueChange={(v) => set("host", v as Form["host"])}><SelectTrigger aria-label="host" className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="github">GitHub</SelectItem><SelectItem value="bitbucket">Bitbucket</SelectItem></SelectContent></Select></div>
        <Select value={f.source} onValueChange={(v) => set("source", v as Form["source"])}><SelectTrigger aria-label="repository source"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="github">{f.host === "bitbucket" ? "Bitbucket" : "GitHub"}: the factory keeps its own clone (recommended)</SelectItem><SelectItem value="path">An existing checkout on this machine</SelectItem></SelectContent></Select>
        {f.host === "bitbucket" ? (
          <>
            {f.source === "path" ? <Input aria-label="checkout path" {...CODE} value={f.path} onChange={(e) => set("path", e.target.value)} placeholder="~/projects/my-app" /> : null}
            <Input aria-label="Bitbucket repo" {...CODE} value={f.bbRepo} onChange={(e) => set("bbRepo", e.target.value)} placeholder="workspace/repository-slug" />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label htmlFor="pe-cred">Credential</Label>
                {creds?.credentials.length ? <Select value={f.bbCred} onValueChange={(v) => set("bbCred", v)}><SelectTrigger id="pe-cred" aria-label="Bitbucket credential"><SelectValue /></SelectTrigger>
                  <SelectContent>{creds.credentials.map((c) => <SelectItem key={c.name} value={c.name}>{c.name} ({c.kind === "api-token" ? "API token" : "access token"})</SelectItem>)}</SelectContent></Select>
                  : <p className="text-xs text-loop">No credentials yet: add one in Settings → Integrations → Bitbucket.</p>}</div>
              <div className="grid gap-1.5"><Label htmlFor="pe-branch">Default branch</Label><Input id="pe-branch" {...CODE} value={f.branch} onChange={(e) => set("branch", e.target.value)} /></div>
            </div>
            {project ? <div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={!f.bbRepo || dirty} onClick={async () => { setAccess("Checking…"); const r = await send<{ name: string; mainBranch: string | null }>("POST", `/api/bitbucket/credentials/${encodeURIComponent(f.bbCred)}/test`, { repo: f.bbRepo }); setAccess(r.ok ? `✓ ${r.data.name} is reachable${r.data.mainBranch ? ` (default branch ${r.data.mainBranch})` : ""}` : `✗ ${r.error}`); }}>Test access</Button>{access ? <span className="text-xs">{access}</span> : null}</div> : null}
          </>
        ) : (
          <>
            {f.source === "github" ? <Input aria-label="GitHub repo" {...CODE} value={f.repo} onChange={(e) => set("repo", e.target.value)} placeholder="owner/name" /> : <Input aria-label="checkout path" {...CODE} value={f.path} onChange={(e) => set("path", e.target.value)} placeholder="~/projects/my-app" />}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label htmlFor="pe-acct">GitHub account (gh)</Label>
                {gh?.accounts.length ? <Select value={f.account || "__profile"} onValueChange={(v) => set("account", v === "__profile" ? "" : v)}><SelectTrigger id="pe-acct" aria-label="GitHub account"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="__profile">{gh.defaultAccount ? `profile default (${gh.defaultAccount})` : "gh's active login"}</SelectItem>{gh.accounts.map((a) => <SelectItem key={a.login} value={a.login}>{a.login}</SelectItem>)}</SelectContent></Select>
                  : <Input id="pe-acct" {...CODE} value={f.account} onChange={(e) => set("account", e.target.value)} placeholder="optional" />}</div>
              <div className="grid gap-1.5"><Label htmlFor="pe-branch">Default branch</Label><Input id="pe-branch" {...CODE} value={f.branch} onChange={(e) => set("branch", e.target.value)} /></div>
            </div>
          </>
        )}
      </Section>
      <Separator />
      <Section title="Issue tracker" hint={words.hint}>
        {connections.length > 1 || ownTracker ? (
          <div className="grid max-w-sm gap-1.5"><Label htmlFor="pe-tracker">Tracker connection</Label>
            <Select value={f.tracker || "__default"} onValueChange={(v) => { set("tracker", v === "__default" ? "" : v); set("team", ""); set("lproject", ""); }}>
              <SelectTrigger id="pe-tracker" aria-label="tracker connection"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="__default">(profile default: {defaultConn.label})</SelectItem>{connections.filter((c) => c.id !== defaultConn.id).map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent></Select></div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="pe-team">{words.team}</Label>
            {pickList.length ? <Select value={f.team || "__none"} onValueChange={(v) => { set("team", v === "__none" ? "" : v); set("lproject", ""); }}><SelectTrigger id="pe-team" aria-label="linear team"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="__none">{words.none}</SelectItem>{pickList.map((t) => <SelectItem key={t.key} value={t.key}>{t.key === t.name ? t.key : `${t.key} · ${t.name}`}</SelectItem>)}</SelectContent></Select>
              : <Input id="pe-team" value={f.team} onChange={(e) => set("team", chosen.kind === "github" ? e.target.value.trim() : e.target.value.toUpperCase())} placeholder={words.placeholder} />}</div>
          <div className="grid gap-1.5"><Label htmlFor="pe-lp">{words.project}</Label>
            {team?.projects.length ? <Select value={f.lproject || "__all"} onValueChange={(v) => set("lproject", v === "__all" ? "" : v)}><SelectTrigger id="pe-lp" aria-label="linear project"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="__all">{words.whole}</SelectItem>{team.projects.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select>
              : <Input id="pe-lp" value={f.lproject} onChange={(e) => set("lproject", e.target.value)} placeholder="optional" />}</div>
          <div className="grid gap-1.5"><Label htmlFor="pe-lpid">Tracker project id</Label><Input id="pe-lpid" {...CODE} className="font-mono text-xs" value={f.lprojectId} onChange={(e) => set("lprojectId", e.target.value)} placeholder="optional: use instead of the name" /></div>
        </div>
      </Section>
      <Separator />
      <Section title="Commands" hint="Run by the factory in a throwaway worktree, sandboxed. A test command is required before it will implement anything: use the project's own CI as the guide, then press “Run checks” to prove they work.">
        <div className="grid gap-3 sm:grid-cols-2">{CMDS.map((k) => <div key={k} className="grid gap-1.5"><Label htmlFor={`pe-c-${k}`} className="capitalize">{k}</Label><Input id={`pe-c-${k}`} {...CODE} className="font-mono text-xs" value={f.commands[k] ?? ""} onChange={(e) => set("commands", { ...f.commands, [k]: e.target.value })} placeholder={k === "test" ? "npm test" : ""} /></div>)}</div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={f.loopback} onChange={(e) => set("loopback", e.target.checked)} />
          <span>Allow local network in tests<span className="block text-xs text-muted-foreground">Lets test, lint and build commands use TCP on this machine only (e.g. tests that start an in-process database or mock server). Nothing outside this machine is reachable. Off by default.</span></span></label>
        <div className="grid gap-1.5"><Label htmlFor="pe-bash">Extra commands the agent may run</Label>
          <textarea id="pe-bash" {...CODE} rows={3} className="rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" placeholder={"GOLDEN_OUT=/tmp/golden godot --headless"} value={f.bashAllow} onChange={(e) => set("bashAllow", e.target.value)} />
          <span className="text-xs text-muted-foreground">One command prefix per line. Only applies while agent access is restricted.</span></div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={f.specKit} onChange={(e) => set("specKit", e.target.checked)} />
          <span>Use the SpecKit specification workflow<span className="block text-xs text-muted-foreground">On by default. Off skips spec generation for this project.</span></span></label>
        {noTest ? <p className="text-sm text-loop">No test command: the factory will not implement changes here yet.</p> : null}
      </Section>

      <Separator />
      <Section title="Overrides" hint="Leave a setting on “global” to follow Settings → Workflow. Anything you set here applies to this project only.">
        <div className="grid gap-1.5"><Label>Ticket pickup</Label>
          <Select value={f.pickup || "__global"} onValueChange={(v) => set("pickup", v === "__global" ? "" : v)}><SelectTrigger aria-label="ticket pickup" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="__global">{`profile default (${globals?.pickupMode ?? "automatic"})`}</SelectItem><SelectItem value="automatic">automatic</SelectItem><SelectItem value="manual">manual: I pick tickets on the Board</SelectItem></SelectContent></Select></div>
        <div className="grid gap-1.5"><Label>Agent access</Label>
          <Select value={f.access || "__global"} onValueChange={(v) => set("access", v === "__global" ? "" : v)}><SelectTrigger aria-label="agent access" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="__global">global default (restricted)</SelectItem><SelectItem value="restricted">restricted: git and the project checks only</SelectItem><SelectItem value="unrestricted">unrestricted: Claude Code auto mode, any command</SelectItem></SelectContent></Select>
          {f.access === "unrestricted" && <span className="text-xs text-muted-foreground">The implementer can run any command your user can. Reviewers stay read-only and the factory still checks the diff for protected paths and secrets.</span>}</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label htmlFor="pe-conc">Concurrent jobs</Label>
            <div className="flex items-center gap-2"><Input id="pe-conc" type="number" inputMode="numeric" min={1} max={8} className="w-24" value={f.conc} placeholder="1" onChange={(e) => set("conc", e.target.value)} />
              <span className="text-xs text-muted-foreground">{f.conc ? <button type="button" className="underline" onClick={() => set("conc", "")}>use default (1)</button> : "default: 1 (each job has its own worktree, but tickets in one repository often touch the same files)"}</span></div></div>
          <div className="grid gap-1.5"><Label htmlFor="pe-passes">Implementation passes</Label>
            <div className="flex items-center gap-2"><Input id="pe-passes" type="number" inputMode="numeric" min={1} max={10} className="w-24" value={f.passes} placeholder={String(globals?.maxImplementationPasses ?? 3)} onChange={(e) => set("passes", e.target.value)} />
              <span className="text-xs text-muted-foreground">{f.passes ? <button type="button" className="underline" onClick={() => set("passes", "")}>use global ({globals?.maxImplementationPasses ?? 3})</button> : `global: ${globals?.maxImplementationPasses ?? 3}`}</span></div></div>
          <div className="grid gap-1.5"><Label htmlFor="pe-fix">Fix cycle limit</Label>
            <div className="flex items-center gap-2"><Input id="pe-fix" type="number" inputMode="numeric" min={0} max={10} className="w-24" value={f.fix} placeholder={String(globals?.maxRemediationAttempts ?? 3)} onChange={(e) => set("fix", e.target.value)} />
              <span className="text-xs text-muted-foreground">{f.fix !== "" ? <button type="button" className="underline" onClick={() => set("fix", "")}>use global ({globals?.maxRemediationAttempts ?? 3})</button> : `global: ${globals?.maxRemediationAttempts ?? 3}`}</span></div></div>
        </div>
        <div className="grid gap-3">
          {TASKS.map((t) => {
            const own = f.models[t.id], glob = globals?.routes[t.id] ?? (t.id === "prompt_generation" ? DEFAULT_PROMPT_ROUTE : undefined);
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

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t bg-card/95 px-1 py-3 backdrop-blur max-md:z-10 max-md:-mx-4 max-md:gap-2 max-md:px-4 max-md:pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        {err ? <p role="alert" className="min-w-0 flex-1 text-sm text-destructive max-md:basis-full">{err}</p> : <p className="flex-1 text-sm text-muted-foreground max-md:basis-full max-md:empty:hidden">{saved ? "Saved. Applied immediately." : dirty ? "Unsaved changes" : ""}</p>}
        <Button variant="outline" className="max-md:flex-1" disabled={!dirty} onClick={() => setF(initial)}>Revert</Button>
        <Button className="max-md:flex-[2]" disabled={busy || !f.name.trim() || (!project && !dirty)} onClick={() => void save()}>{project ? "Save changes" : "Create project"}</Button>
      </div>
    </div>
  );
}
