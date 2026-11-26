import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch } from "react-router-dom";
import { ArrowUpCircle, OctagonAlert, Pause, Play, ShieldOff, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, post, inHubMode } from "@/lib/api";
import type { Overview, Project, ProfileInfo, UpdateInfo } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { JobTabs } from "@/components/JobTabs";
import { ProjectRail } from "@/components/ProjectRail";
import { StatusBar } from "@/components/StatusBar";
import { electronOverlay } from "@/lib/platform";
import { openJobs, rememberTab } from "@/lib/projects";
import { cn } from "@/lib/utils";

const TITLES: Record<string, string> = { "/": "All projects", "/board": "Board", "/jobs": "All jobs", "/health": "Factory health", "/settings": "Settings", "/setup": "Setup" };

export function Shell() {
  const { data: o, error, updatedAt, reload } = usePoll((signal) => api<Overview>("/api/overview", signal), 3000);
  const offline = error !== null;
  const [msg, setMsg] = useState<string | null>(null);
  const { data: prof } = usePoll((signal) => api<{ current: string; profiles: ProfileInfo[] }>("/api/profiles", signal), 8000);
  useEffect(() => { if (prof) document.title = prof.profiles.length > 1 ? `Software Factory — ${prof.current}` : "Software Factory"; }, [prof]);
  const { data: upd } = usePoll((signal) => api<UpdateInfo>("/api/update", signal), 30 * 60_000);
  const [hidden, setHidden] = useState<string | null>(() => { try { return localStorage.getItem("dismissed-update"); } catch { return null; } });
  const showUpdate = !inHubMode() && upd?.available && upd.latest && hidden !== upd.latest; // updating is a local-machine action
  const dismiss = () => { setHidden(upd?.latest ?? null); try { if (upd?.latest) localStorage.setItem("dismissed-update", upd.latest); } catch { /* remembered for this tab only */ } };
  const { data: projData } = usePoll((signal) => api<{ projects: Project[] }>("/api/projects", signal), 10_000);
  const projects = projData?.projects ?? [];
  const { pathname } = useLocation();
  const jobMatch = useMatch("/jobs/:id"), projMatch = useMatch("/p/:projectId");
  const jobId = jobMatch?.params.id ?? null;
  const everyJob = useMemo(() => (o ? [...o.active, ...o.queued, ...o.recent] : []), [o]);
  const jobs = useMemo(() => openJobs(o), [o]);
  const projectId = projMatch ? decodeURIComponent(projMatch.params.projectId!) : jobId ? everyJob.find((j) => j.id === jobId)?.project ?? null : null;
  useEffect(() => { if (projectId) rememberTab(projectId, pathname); }, [projectId, pathname]);
  const [busy, setBusy] = useState(false);
  // Pause/resume/clear-stop are disabled while one is in flight or the API is unreachable. Emergency stop never is: it is always worth trying.
  const act = async (name: string) => {
    if (busy && name !== "stop") return;
    setBusy(true);
    try { const err = await post(`/api/control/${name}`); setMsg(err); if (!err) await reload(); } finally { setBusy(false); }
  };
  const stop = o?.control.emergencyStop, paused = o?.control.paused;
  return (
    <div className="flex min-h-screen w-full flex-col md:h-screen md:flex-row">
      <ProjectRail overview={o} projects={projects} jobs={jobs} projectId={projectId} jobId={jobId} profiles={prof ?? null} stop={Boolean(stop)} paused={Boolean(paused)} />
      <div className="flex min-w-0 flex-1 flex-col bg-background md:min-h-0">
        <header className={cn("app-drag flex min-h-[52px] shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2", electronOverlay && "md:pr-36")}>
          {projectId ? <JobTabs projectId={projectId} jobs={jobs.filter((j) => j.project === projectId)} jobId={jobId} /> : <h1 className="px-1.5 text-sm font-semibold">{TITLES[pathname] ?? "Software Factory"}</h1>}
          <span className="flex-1" />
          {o && !paused && !stop ? <Button variant="outline" size="sm" disabled={busy || offline} onClick={() => void act("pause")}><Pause />Pause</Button> : null}
          {o && paused && !stop ? <Button variant="outline" size="sm" disabled={busy || offline} onClick={() => void act("resume")}><Play />Resume</Button> : null}
          {o && !stop ? (
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="destructive" size="sm"><OctagonAlert />Emergency stop</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>Emergency stop?</AlertDialogTitle><AlertDialogDescription>Running agents are terminated now and nothing new starts until you clear the stop.</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>Keep running</AlertDialogCancel><AlertDialogAction onClick={() => void act("stop")}>Stop everything</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
          {o && stop ? <Button variant="outline" size="sm" disabled={busy || offline} onClick={() => void act("clear-stop")}><ShieldOff />Clear stop</Button> : null}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="grid gap-3 px-6 empty:hidden [&>*:first-child]:mt-4">
            {showUpdate ? (
              <Alert role="status"><ArrowUpCircle /><AlertDescription className="flex flex-wrap items-center gap-x-2">
                <span><b>Update available:</b> {upd!.current} → {upd!.latest}.</span><span>Run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">software-factory update</code> in a terminal, then restart the factory (wait for a quiet moment: a restart redoes any stage in progress).</span>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={dismiss} aria-label="dismiss update notice"><X /></Button></AlertDescription></Alert>
            ) : null}
            {stop ? <Alert variant="destructive" role="alert"><OctagonAlert /><AlertDescription>Emergency stop is active{o?.control.reason ? `: ${o.control.reason}` : ""}. No new work starts and running agents were terminated.</AlertDescription></Alert> : null}
            {msg ? <Alert variant="destructive" role="alert"><AlertDescription>{msg}</AlertDescription></Alert> : null}
            <ConnectionBanner global error={error} updatedAt={updatedAt} what="dashboard" />
          </div>
          <main className="min-w-0 flex-1 px-6 pb-7 pt-5"><div className="mx-auto w-full max-w-[1200px]"><Outlet context={{ overview: o, reload, offline }} /></div></main>
        </div>
        <StatusBar overview={o} open={jobs.length} />
      </div>
    </div>
  );
}
