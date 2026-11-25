import { useState } from "react";
import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checks } from "@/components/Integrations";
import { TrackerSetup } from "@/components/TrackerSetup";
import { ProjectEditor } from "@/components/ProjectEditor";
import { api } from "@/lib/api";
import type { Project, SetupInfo, TeamAudit } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

const STEPS = ["Your tools", "Issue Tracking", "First project", "Done"];

/** First-run wizard: each step checks the real thing, so "Next" is only offered when it is true. */
export function Setup() {
  const [step, setStep] = useState(0);
  const [toolsOk, setToolsOk] = useState(false);
  const [teams, setTeams] = useState<TeamAudit[]>([]);
  const [open, setOpen] = useState(false);
  const { data: info, reload: reloadInfo } = usePoll(() => api<SetupInfo>("/api/setup"), 10000);
  const { data: ps, reload } = usePoll(() => api<{ projects: Project[] }>("/api/projects"), 10000);
  const projects = ps?.projects ?? [];
  const next = (ok: boolean, label = "Continue") => <Button disabled={!ok} onClick={() => setStep(step + 1)}>{label}</Button>;
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <ol className="flex flex-wrap gap-2 text-sm">
        {STEPS.map((s, i) => <li key={s}><button type="button" onClick={() => setStep(i)} className={cn("flex items-center gap-2 rounded-full border px-3 py-1", i === step && "border-foreground font-medium", i < step && "text-ok")}>{i < step ? <Check className="size-3.5" /> : <span className="text-xs text-muted-foreground">{i + 1}</span>}{s}</button></li>)}
      </ol>
      {step === 0 ? (
        <Card><CardHeader><CardTitle>Check your tools</CardTitle><CardDescription>The factory drives tools you already have. Each one is checked live; fix any that are red, then re-check. Spec Kit and a local model are optional here.</CardDescription></CardHeader>
          <CardContent className="grid gap-4"><Checks onChange={setToolsOk} /><div>{next(true, toolsOk ? "Continue" : "Continue anyway")}</div></CardContent></Card>
      ) : null}
      {step === 1 ? (
        <Card><CardHeader><CardTitle>Connect your issue tracker</CardTitle><CardDescription>Tickets come from Linear or Jira (each profile picks one). With Linear the factory can create the few statuses and labels it needs; with Jira you map its statuses and labels to ones that already exist.</CardDescription></CardHeader>
          <CardContent className="grid gap-4"><TrackerSetup info={info} onChanged={() => void reloadInfo()} onKey={() => void reloadInfo()} onTeams={setTeams} /><div className="flex gap-2"><Button variant="outline" onClick={() => setStep(0)}>Back</Button>{next(Boolean(info?.tracker.connected ?? info?.linear.keyPresent))}</div></CardContent></Card>
      ) : null}
      {step === 2 ? (
        <Card><CardHeader><CardTitle>Add your first project</CardTitle><CardDescription>Link a GitHub repository to a Linear project and tell the factory how to run its tests. You can add more later in Settings.</CardDescription></CardHeader>
          <CardContent className="grid gap-4">
            {projects.map((p) => <div key={p.id} className="flex items-center gap-2 rounded-md border p-3 text-sm"><Check className="size-4 text-ok" /><b>{p.name}</b><span className="text-muted-foreground">{p.githubRepo || p.repository}</span></div>)}
            {open ? <div className="rounded-md border p-4"><ProjectEditor project={null} teams={teams} onSaved={() => { setOpen(false); void reload(); void reloadInfo(); }} /></div>
              : <div><Button variant={projects.length ? "outline" : "default"} onClick={() => setOpen(true)}>{projects.length ? "Add another" : "Add a project"}</Button></div>}
            <div className="flex gap-2"><Button variant="outline" onClick={() => setStep(1)}>Back</Button>{next(projects.length > 0)}</div>
          </CardContent></Card>
      ) : null}
      {step === 3 ? (
        <Card><CardHeader><CardTitle>You're set</CardTitle><CardDescription>Nothing runs until a ticket is picked up.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <p>In Linear, label a ticket <b>factory:enabled</b> and move it to <b>Ready for specification</b>. The factory specifies it, builds it in a sandbox, has it reviewed, and opens a pull request. <b>It never merges: you do.</b></p>
            <p>Next, in <Link to="/settings" className="underline">Settings</Link>, press <b>Run checks</b> on each project to prove its commands work, and <b>Onboard Spec Kit</b> to prepare the repository.</p>
            <div><Button asChild><Link to="/settings">Go to Settings</Link></Button> <Button variant="outline" asChild><Link to="/">Open the dashboard</Link></Button></div>
          </CardContent></Card>
      ) : null}
    </div>
  );
}
