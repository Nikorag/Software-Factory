import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, Plus } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checks, LinearSetup } from "@/components/Integrations";
import { ProjectEditor } from "@/components/ProjectEditor";
import { api } from "@/lib/api";
import type { Project, SetupInfo, TeamAudit } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

const NEW = "__new";

/** Projects: a list on the left, a full-height editor on the right. */
function ProjectsPane({ projects, teams, reload }: { projects: Project[]; teams: TeamAudit[]; reload: () => void }) {
  const [params] = useSearchParams();
  const [sel, setSel] = useState<string | null>(params.get("project"));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<string | null>(null); // a selection waiting on "discard unsaved changes?"
  useEffect(() => { if (sel === null && projects[0]) setSel(projects[0].id); }, [projects, sel]);
  const onDirty = useCallback((d: boolean) => setDirty(d), []);
  const go = (id: string) => { if (id === sel) return; if (dirty) setPending(id); else setSel(id); };
  const current = sel === NEW ? null : projects.find((p) => p.id === sel) ?? null;

  return (
    <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)] [&>*]:min-w-0">
      <Card className="min-w-0 self-start overflow-hidden"><CardContent className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 p-3">
        <Button size="sm" onClick={() => go(NEW)}><Plus />Add project</Button>
        <nav aria-label="Projects" className="grid grid-cols-[minmax(0,1fr)] gap-1">
          {projects.map((p) => (
            <button key={p.id} type="button" aria-current={sel === p.id ? "true" : undefined} onClick={() => go(p.id)}
              className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent", sel === p.id && "bg-accent font-medium")}>
              <span className="min-w-0 flex-1"><span className="block truncate">{p.name}</span><span className="block truncate font-mono text-[11px] text-muted-foreground" title={p.githubRepo || p.repository}>{p.githubRepo || p.repository}</span></span>
              {!p.commands.test ? <AlertTriangle className="size-4 shrink-0 text-loop" aria-label="no test command" /> : null}
              {!p.enabled ? <span className="text-[11px] text-muted-foreground">off</span> : null}
            </button>
          ))}
          {projects.length === 0 ? <p className="px-1 text-sm text-muted-foreground">No projects yet. <Link className="underline" to="/setup">Run the setup wizard</Link> or add one.</p> : null}
        </nav>
      </CardContent></Card>
      <Card className="min-w-0 overflow-hidden"><CardContent className="min-w-0 p-5">
        {sel === null && projects.length === 0 ? <p className="text-sm text-muted-foreground">Add a project to get started.</p> : (
          <ProjectEditor key={sel ?? "none"} project={current} teams={teams} onDirty={onDirty}
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
  const { data, reload } = usePoll(() => api<{ projects: Project[] }>("/api/projects"), 15000);
  const { data: info, reload: reloadInfo } = usePoll(() => api<SetupInfo>("/api/setup"), 30000);
  const [teams, setTeams] = useState<TeamAudit[]>([]);
  // Teams power the editor's Linear pickers; load them once a key exists (the Integrations tab refreshes them).
  usePoll(async () => { if (!info?.linear.keyPresent) return null; const r = await api<{ teams: TeamAudit[] }>("/api/setup/linear"); setTeams(r.teams); return r; }, 300000, [info?.linear.keyPresent]);
  return (
    <Tabs defaultValue="projects">
      <TabsList><TabsTrigger value="projects">Projects</TabsTrigger><TabsTrigger value="integrations">Integrations</TabsTrigger><TabsTrigger value="system">System</TabsTrigger></TabsList>
      <TabsContent value="projects"><ProjectsPane projects={data?.projects ?? []} teams={teams} reload={() => { void reload(); void reloadInfo(); }} /></TabsContent>
      <TabsContent value="integrations" className="grid gap-4">
        <Card><CardHeader><CardTitle className="text-sm">Status</CardTitle></CardHeader><CardContent><Checks /></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm">Linear</CardTitle></CardHeader><CardContent><LinearSetup info={info} onKey={() => void reloadInfo()} onTeams={setTeams} /></CardContent></Card>
      </TabsContent>
      <TabsContent value="system"><Card><CardContent className="grid gap-1 text-sm">
        <div>Your settings are stored in <span className="font-mono text-xs">{info?.configDir ?? info?.homeConfigDir}</span></div>
        <div className="text-muted-foreground">{info?.usingDefaults ? "Using the shipped defaults until you change a setting." : "These are your own files: you can also edit projects.yaml by hand."}</div>
        <div className="text-muted-foreground">Delivery is pull-request only: the factory never merges.</div>
      </CardContent></Card></TabsContent>
    </Tabs>
  );
}
