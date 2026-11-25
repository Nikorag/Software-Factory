import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { send } from "@/lib/api";
import type { Project, TeamAudit } from "@/lib/types";

const CMDS = ["install", "build", "typecheck", "lint", "test"] as const;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
interface Form { id: string; name: string; source: "github" | "path"; repo: string; path: string; account: string; branch: string; autonomy: string; team: string; lproject: string; enabled: boolean; commands: Record<string, string> }

const blank = (): Form => ({ id: "", name: "", source: "github", repo: "", path: "", account: "", branch: "main", autonomy: "supervised", team: "", lproject: "", enabled: true, commands: {} });
const fromProject = (p: Project): Form => ({
  id: p.id, name: p.name, source: p.managed ? "github" : "path", repo: p.githubRepo ?? "", path: p.managed ? "" : p.repository, account: p.githubAccount ?? "", branch: p.defaultBranch, autonomy: p.autonomy,
  team: p.linear?.teamKey ?? "", lproject: p.linear?.projectName ?? "", enabled: p.enabled, commands: Object.fromEntries(CMDS.map((k) => [k, p.commands[k] ?? ""])),
});

/** Add or edit a project. Validation is server-side (duplicate repos, shared Linear targets, bad ids) and shown verbatim. */
export function ProjectForm({ open, onOpenChange, project, teams, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project | null; teams: TeamAudit[]; onSaved: () => void }) {
  const [f, setF] = useState<Form>(blank());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF(project ? fromProject(project) : blank()); setErr(null); } }, [open, project]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const team = teams.find((t) => t.key === f.team);

  const save = async () => {
    setBusy(true); setErr(null);
    const id = project?.id ?? (f.id || slug(f.name));
    const commands = Object.fromEntries(CMDS.filter((k) => f.commands[k]?.trim()).map((k) => [k, f.commands[k]!.trim()]));
    const r = await send("PUT", `/api/settings/projects/${encodeURIComponent(id)}`, {
      name: f.name.trim(), defaultBranch: f.branch.trim() || "main", enabled: f.enabled, autonomy: f.autonomy, commands,
      ...(f.source === "github" ? { github: { repo: f.repo.trim(), account: f.account.trim() || undefined } } : { repository: f.path.trim(), github: { account: f.account.trim() || undefined, repo: f.repo.trim() || undefined } }),
      ...(f.team ? { linear: { teamKey: f.team, projectName: f.lproject || undefined } } : {}),
    });
    setBusy(false);
    if (r.ok) { onOpenChange(false); onSaved(); } else setErr(r.error);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{project ? `Edit ${project.name}` : "Add a project"}</DialogTitle><DialogDescription>One Linear project maps to one repository. Nothing starts until a ticket in that Linear project is labelled and moved to the pickup status.</DialogDescription></DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="pf-name">Name</Label><Input id="pf-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="My App" /></div>
            <div className="grid gap-1.5"><Label htmlFor="pf-id">Id</Label><Input id="pf-id" disabled={!!project} value={project ? project.id : f.id || slug(f.name)} onChange={(e) => set("id", slug(e.target.value))} placeholder="my-app" /></div>
          </div>
          <div className="grid gap-1.5"><Label>Repository</Label>
            <Select value={f.source} onValueChange={(v) => set("source", v as Form["source"])}><SelectTrigger aria-label="repository source"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="github">GitHub: the factory keeps its own clone (recommended)</SelectItem><SelectItem value="path">An existing checkout on this machine</SelectItem></SelectContent></Select>
            {f.source === "github" ? <Input aria-label="GitHub repo" value={f.repo} onChange={(e) => set("repo", e.target.value)} placeholder="owner/name" /> : <Input aria-label="checkout path" value={f.path} onChange={(e) => set("path", e.target.value)} placeholder="~/projects/my-app" />}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="grid gap-1.5"><Label htmlFor="pf-acct">GitHub account (gh)</Label><Input id="pf-acct" value={f.account} onChange={(e) => set("account", e.target.value)} placeholder="optional" /></div>
            <div className="grid gap-1.5"><Label htmlFor="pf-branch">Default branch</Label><Input id="pf-branch" value={f.branch} onChange={(e) => set("branch", e.target.value)} /></div>
            <div className="grid gap-1.5"><Label>Autonomy</Label>
              <Select value={f.autonomy} onValueChange={(v) => set("autonomy", v)}><SelectTrigger aria-label="autonomy"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="supervised">supervised</SelectItem><SelectItem value="full">full</SelectItem><SelectItem value="off">off</SelectItem></SelectContent></Select></div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="pf-team">Linear team key</Label>
              {teams.length ? <Select value={f.team || "__none"} onValueChange={(v) => { set("team", v === "__none" ? "" : v); set("lproject", ""); }}><SelectTrigger id="pf-team" aria-label="linear team"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="__none">(none)</SelectItem>{teams.map((t) => <SelectItem key={t.key} value={t.key}>{t.key} · {t.name}</SelectItem>)}</SelectContent></Select>
                : <Input id="pf-team" value={f.team} onChange={(e) => set("team", e.target.value.toUpperCase())} placeholder="ENG" />}</div>
            <div className="grid gap-1.5"><Label htmlFor="pf-lp">Linear project</Label>
              {team?.projects.length ? <Select value={f.lproject || "__all"} onValueChange={(v) => set("lproject", v === "__all" ? "" : v)}><SelectTrigger id="pf-lp" aria-label="linear project"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="__all">(whole team)</SelectItem>{team.projects.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent></Select>
                : <Input id="pf-lp" value={f.lproject} onChange={(e) => set("lproject", e.target.value)} placeholder="optional" />}</div>
          </div>
          <div className="grid gap-2">
            <Label>Commands the factory runs (sandboxed, in a throwaway worktree)</Label>
            <p className="text-xs text-muted-foreground">A <b>test</b> command is required before the factory will implement anything. Use the project's own CI as the guide, then press “Run checks” to prove they work.</p>
            <div className="grid gap-2 sm:grid-cols-2">{CMDS.map((k) => <div key={k} className="grid gap-1"><Label htmlFor={`pf-c-${k}`} className="text-xs capitalize">{k}</Label><Input id={`pf-c-${k}`} className="font-mono text-xs" value={f.commands[k] ?? ""} onChange={(e) => set("commands", { ...f.commands, [k]: e.target.value })} placeholder={k === "test" ? "npm test" : ""} /></div>)}</div>
          </div>
          <div className="flex items-center gap-2"><Switch id="pf-en" checked={f.enabled} onCheckedChange={(v) => set("enabled", v)} /><Label htmlFor="pf-en">Enabled (picks up tickets)</Label></div>
          {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || !f.name.trim()} onClick={() => void save()}>{project ? "Save changes" : "Add project"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
