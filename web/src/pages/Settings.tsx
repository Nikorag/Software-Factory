import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ChevronsUpDown, Plus, Search, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pager } from "@/components/Pager";
import { matches, usePaged } from "@/lib/paging";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checks } from "@/components/Integrations";
import { TrackerSetup } from "@/components/TrackerSetup";
import { UpdateCheck } from "@/components/UpdateCheck";
import { HubSetup } from "@/components/HubSetup";
import { AdvancedSettings } from "@/components/AdvancedSettings";
import { BitbucketSetup } from "@/components/BitbucketSetup";
import { ProjectEditor } from "@/components/ProjectEditor";
import { api, inHubMode } from "@/lib/api";
import { WorkflowSettings } from "@/pages/WorkflowSettings";
import { ProfilesSettings } from "@/pages/ProfilesSettings";
import type { GlobalSettings } from "@/lib/tasks";
import type { Project, SetupInfo, TeamAudit } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

const NEW = "__new";

/** Projects: a list on the left, a full-height editor on the right. */
function ProjectsPane({ projects, teams, globals, tracker, reload }: { projects: Project[]; teams: TeamAudit[]; globals: GlobalSettings | null; tracker?: "linear" | "jira" | "github"; reload: () => void }) {
  const [params] = useSearchParams();
  const [sel, setSel] = useState<string | null>(params.get("project"));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string | null>(null); // a selection waiting on "discard unsaved changes?"
  useEffect(() => { if (sel === null && projects[0]) setSel(projects[0].id); }, [projects, sel]);
  const onDirty = useCallback((d: boolean) => setDirty(d), []);
  const [menuOpen, setMenuOpen] = useState(false); // below lg (phones and tablets) the project list is a drawer behind its own burger button
  useEffect(() => {
    if (!menuOpen) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = ""; };
  }, [menuOpen]);
  const go = (id: string) => { setMenuOpen(false); if (id === sel) return; if (dirty) setPending(id); else setSel(id); };
  const [filter, setFilter] = useState("");
  const visible = projects.filter((p) => p.id === sel || matches(filter, p.name, p.id, p.githubRepo, p.bitbucketRepo, p.repository));
  const paged = usePaged(visible, 10, filter);
  const current = sel === NEW ? null : projects.find((p) => p.id === sel) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)] [&>*]:min-w-0">
      {menuOpen ? <div aria-hidden className="fixed inset-0 z-20 bg-black/55 lg:hidden" onClick={() => setMenuOpen(false)} /> : null}
      <Button variant="outline" className="w-full min-w-0 justify-between lg:hidden" aria-label={`Project: ${sel === NEW ? "adding a project" : current?.name ?? "none"}. Choose another project`} aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
        <span className="min-w-0 truncate"><span className="font-normal text-muted-foreground">Project: </span>{sel === NEW ? "Adding a project" : current?.name ?? "Choose"}</span><ChevronsUpDown className="text-muted-foreground" />
      </Button>
      <aside aria-label="Projects" className={cn("min-w-0 overflow-y-auto bg-card text-card-foreground max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:w-[min(320px,88vw)] max-lg:pb-safe max-lg:pt-safe max-lg:border-r max-lg:border-line max-lg:shadow-xl max-lg:transition-transform max-lg:duration-200 lg:self-start lg:overflow-hidden lg:rounded-xl lg:border", menuOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full max-lg:invisible")}>
        <div className="flex items-center justify-between border-b border-line py-1.5 pl-4 pr-1.5 lg:hidden"><span className="text-sm font-semibold">Projects</span><Button variant="ghost" size="icon" aria-label="Close projects menu" onClick={() => setMenuOpen(false)}><X /></Button></div>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 p-3">
        <Button size="sm" onClick={() => go(NEW)}><Plus />Add project</Button>
        {projects.length > 5 ? <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 max-md:top-3.5 size-4 text-muted-foreground" /><Input aria-label="Filter projects" className="pl-8" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter projects" /></div> : null}
        <nav aria-label="Projects" className="grid grid-cols-[minmax(0,1fr)] gap-1">
          {paged.slice.map((p) => (
            <button key={p.id} type="button" aria-current={sel === p.id ? "true" : undefined} onClick={() => go(p.id)}
              className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent max-lg:min-h-12", sel === p.id && "bg-accent font-medium")}>
              <span className="min-w-0 flex-1"><span className="block truncate">{p.name}</span><span className="block truncate font-mono text-[11px] text-muted-foreground" title={p.githubRepo || p.repository}>{p.githubRepo || p.repository}</span></span>
              {p.onboarding ? <span className={cn("size-2 shrink-0 rounded-full", p.onboarding.status === "ready" ? "bg-ok" : p.onboarding.status === "in-progress" ? "bg-loop" : "bg-muted-foreground/40")} role="img" aria-label={`onboarding: ${p.onboarding.status}`} title={`Onboarding: ${p.onboarding.status}`} /> : null}
              {!p.commands.test ? <AlertTriangle className="size-4 shrink-0 text-loop" aria-label="no test command" /> : null}
              {!p.enabled ? <span className="text-[11px] text-muted-foreground">off</span> : null}
            </button>
          ))}
          {projects.length > 0 && visible.length === 0 ? <p className="px-1 text-sm text-muted-foreground">No project matches “{filter}”.</p> : null}
          {projects.length === 0 ? <p className="px-1 text-sm text-muted-foreground">No projects yet. <Link className="underline" to="/setup">Run the setup wizard</Link> or add one.</p> : null}
        </nav>
        <Pager page={paged.page} pages={paged.pages} pageSize={paged.pageSize} total={paged.total} onPage={paged.setPage} />
        </div>
      </aside>
      <Card className="min-w-0 overflow-hidden max-lg:overflow-visible"><CardContent className="min-w-0 p-5 max-md:p-4">
        {sel === null && projects.length === 0 ? <p className="text-sm text-muted-foreground">Add a project to get started.</p> : (
          <ProjectEditor key={sel ?? "none"} project={current} teams={teams} globals={globals} tracker={tracker} onDirty={onDirty}
            onSaved={(id) => { reload(); if (sel === NEW) setSel(id); }} onRemoved={() => { reload(); setSel(null); }} />
        )}
      </CardContent></Card>
      <AlertDialog open={pending !== null} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle><AlertDialogDescription>You have edits to this project that are not saved.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={() => { setSel(pending); setPending(null); setDirty(false); }}>Discard</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "projects"; // #/settings?tab=system opens straight to a tab (the app menu uses it for "Check for Updates…")
  const { data, reload } = usePoll(() => api<{ projects: Project[] }>("/api/projects"), 15000);
  const { data: info, reload: reloadInfo } = usePoll(() => api<SetupInfo>("/api/setup"), 30000);
  const [teams, setTeams] = useState<TeamAudit[]>([]);
  const { data: globals, reload: reloadGlobals } = usePoll(() => api<GlobalSettings>("/api/settings/global"), 60000);
  // Teams power the editor's Linear pickers; load them once a key exists (the Integrations tab refreshes them).
  usePoll(async () => { if (!info?.linear.keyPresent) return null; const r = await api<{ teams: TeamAudit[] }>("/api/setup/linear"); setTeams(r.teams); return r; }, 300000, [info?.linear.keyPresent]);
  return (
    <Tabs value={tab} onValueChange={(v) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", v); return n; }, { replace: true })}>
      <TabsList><TabsTrigger value="projects">Projects</TabsTrigger><TabsTrigger value="workflow">Workflow</TabsTrigger><TabsTrigger value="integrations">Integrations</TabsTrigger><TabsTrigger value="profiles">Profiles</TabsTrigger><TabsTrigger value="system">System</TabsTrigger></TabsList>
      <TabsContent value="projects"><ProjectsPane projects={data?.projects ?? []} teams={teams} globals={globals} tracker={info?.tracker.kind} reload={() => { void reload(); void reloadInfo(); }} /></TabsContent>
      <TabsContent value="workflow" className="max-md:[&_.grid]:grid-cols-[minmax(0,1fr)]"><WorkflowSettings value={globals} onSaved={() => void reloadGlobals()} /></TabsContent>
      <TabsContent value="integrations" className="grid gap-4 max-md:grid-cols-[minmax(0,1fr)] max-md:[&_.grid]:grid-cols-[minmax(0,1fr)]">
        <Card><CardHeader><CardTitle className="text-sm">Status</CardTitle></CardHeader><CardContent><Checks /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Bitbucket</CardTitle></CardHeader><CardContent><BitbucketSetup /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Issue tracker</CardTitle></CardHeader><CardContent><TrackerSetup info={info} onChanged={() => void reloadInfo()} onKey={() => void reloadInfo()} onTeams={setTeams} /></CardContent></Card>
      </TabsContent>
      <TabsContent value="profiles" className="max-md:[&_.grid]:grid-cols-[minmax(0,1fr)]"><ProfilesSettings /></TabsContent>
      <TabsContent value="system" className="grid gap-4 max-md:grid-cols-[minmax(0,1fr)] max-md:[&_.grid]:grid-cols-[minmax(0,1fr)]"><Card><CardHeader><CardTitle className="text-sm">Updates</CardTitle></CardHeader><CardContent><UpdateCheck /></CardContent></Card>
        {!inHubMode() && <Card><CardHeader><CardTitle className="text-sm">Advanced (restart required)</CardTitle></CardHeader><CardContent><AdvancedSettings /></CardContent></Card>}
        {!inHubMode() && <Card><CardHeader><CardTitle className="text-sm">Hub</CardTitle></CardHeader><CardContent><HubSetup /></CardContent></Card>}
        <Card><CardContent className="grid gap-1 text-sm">
        <div>Your settings are stored in <span className="font-mono text-xs">{info?.configDir ?? info?.homeConfigDir}</span></div>
        <div className="text-muted-foreground">{info?.usingDefaults ? "Using the shipped defaults until you change a setting." : "These are your own files: you can also edit projects.yaml by hand."}</div>
        <div className="text-muted-foreground">Delivery is pull-request only: the factory never merges.</div>
      </CardContent></Card></TabsContent>
    </Tabs>
  );
}
