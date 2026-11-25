import { useState } from "react";
import { Link } from "react-router-dom";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checks, LinearSetup } from "@/components/Integrations";
import { ProjectForm } from "@/components/ProjectForm";
import { startAction, TaskOutput } from "@/components/TaskRunner";
import { api, send } from "@/lib/api";
import type { Project, SetupInfo, TeamAudit } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

const ACTIONS = [["sync", "Clone"], ["validate", "Validate"], ["check", "Run checks"]] as const;

function ProjectCard({ p, onEdit, onChanged }: { p: Project; onEdit: () => void; onChanged: () => void }) {
  const [task, setTask] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (kind: string) => { setErr(null); const r = await startAction(p.id, kind); if (r.ok) setTask(r.data.taskId); else setErr(r.error); };
  const remove = async () => { const r = await send("DELETE", `/api/settings/projects/${encodeURIComponent(p.id)}`); if (r.ok) onChanged(); else setErr(r.error); };
  return (
    <Card><CardContent className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><b>{p.name}</b>{!p.enabled ? <Badge variant="outline">disabled</Badge> : null}<Badge variant="secondary">{p.autonomy}</Badge></div>
          <div className="font-mono text-xs text-muted-foreground">{p.githubRepo || p.repository} · {p.defaultBranch}{p.linear ? ` · Linear ${p.linear.teamKey}${p.linear.projectName ? ` / ${p.linear.projectName}` : ""}` : " · no Linear binding"}</div></div>
        <Button variant="outline" size="sm" onClick={onEdit}><Pencil />Edit</Button>
        <AlertDialog><AlertDialogTrigger asChild><Button variant="outline" size="sm" aria-label={`remove ${p.name}`}><Trash2 /></Button></AlertDialogTrigger>
          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Remove {p.name}?</AlertDialogTitle><AlertDialogDescription>It stops picking up tickets. Existing jobs, the clone and your repository are left alone.</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={() => void remove()}>Remove</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        {p.commands.test ? (["install", "build", "typecheck", "lint", "test"] as const).filter((k) => p.commands[k]).map((k) => <Badge key={k} variant="outline" title={p.commands[k]} className={k === "test" ? "border-ok/40 text-ok" : ""}>{k}: <span className="ml-1 font-mono">{p.commands[k]}</span></Badge>) : <span className="text-loop">No test command: the factory will not implement changes here yet. Edit to add one.</span>}
      </div>
      {p.validation ? <div className="text-xs text-muted-foreground"><span className={p.validation.ok ? "text-ok" : "text-destructive"}>{p.validation.ok ? "validated" : "validation failing"}</span> · protection: {p.validation.protection}</div> : null}
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map(([k, label]) => <Button key={k} size="sm" variant="secondary" onClick={() => void run(k)}>{label}</Button>)}
        <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="secondary">Onboard Spec Kit…</Button></AlertDialogTrigger>
          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Onboard {p.name}?</AlertDialogTitle>
            <AlertDialogDescription>Adds Spec Kit and a constitution on a review branch. “Open a pull request” also pushes that branch to {p.githubRepo ?? "the repository"} and opens a PR for you to review. The factory never merges anything.</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><Button variant="outline" onClick={() => void run("onboard")}>Local branch only</Button><AlertDialogAction onClick={() => void run("onboard-pr")}>Open a pull request</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      </div>
      {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
      {task ? <TaskOutput taskId={task} onDone={onChanged} /> : null}
    </CardContent></Card>
  );
}

export function Settings() {
  const { data, reload } = usePoll(() => api<{ projects: Project[] }>("/api/projects"), 15000);
  const { data: info, reload: reloadInfo } = usePoll(() => api<SetupInfo>("/api/setup"), 30000);
  const [teams, setTeams] = useState<TeamAudit[]>([]);
  const [editing, setEditing] = useState<Project | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-4">
      <Tabs defaultValue="projects">
        <TabsList><TabsTrigger value="projects">Projects</TabsTrigger><TabsTrigger value="integrations">Integrations</TabsTrigger><TabsTrigger value="system">System</TabsTrigger></TabsList>
        <TabsContent value="projects" className="grid gap-3">
          <div className="flex items-center"><p className="flex-1 text-sm text-muted-foreground">Changes apply immediately: no restart needed.</p><Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}><Plus />Add project</Button></div>
          {(data?.projects ?? []).length === 0 ? <Alert><AlertDescription>No projects yet. <Link className="underline" to="/setup">Run the setup wizard</Link> or add one.</AlertDescription></Alert> : null}
          {(data?.projects ?? []).map((p) => <ProjectCard key={p.id} p={p} onEdit={() => { setEditing(p); setOpen(true); }} onChanged={() => void reload()} />)}
        </TabsContent>
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
      <ProjectForm open={open} onOpenChange={setOpen} project={editing} teams={teams} onSaved={() => { void reload(); void reloadInfo(); }} />
    </div>
  );
}
