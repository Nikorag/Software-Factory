import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ArrowUpCircle, OctagonAlert, Pause, Play, ShieldOff, X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, post } from "@/lib/api";
import type { Overview, UpdateInfo } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

const NAV = [["/", "Overview"], ["/jobs", "Jobs"], ["/health", "Health"], ["/settings", "Settings"]] as const;

export function Shell() {
  const { data: o, error, reload } = usePoll(() => api<Overview>("/api/overview"), 3000);
  const [msg, setMsg] = useState<string | null>(null);
  const { data: upd } = usePoll(() => api<UpdateInfo>("/api/update"), 30 * 60_000);
  const [hidden, setHidden] = useState<string | null>(() => { try { return localStorage.getItem("dismissed-update"); } catch { return null; } });
  const showUpdate = upd?.available && upd.latest && hidden !== upd.latest;
  const dismiss = () => { setHidden(upd?.latest ?? null); try { if (upd?.latest) localStorage.setItem("dismissed-update", upd.latest); } catch { /* remembered for this tab only */ } };
  const act = async (name: string) => { const err = await post(`/api/control/${name}`); setMsg(err); if (!err) void reload(); };
  const stop = o?.control.emergencyStop, paused = o?.control.paused;
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-7xl min-w-0 flex-col gap-4 px-4 py-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Software Factory</h1>
        {o ? <Badge variant="outline" className={cn("font-semibold", stop ? "border-destructive/50 text-destructive" : paused ? "border-loop/50 text-loop" : "border-ok/50 text-ok")}>{stop ? "EMERGENCY STOP" : paused ? "PAUSED" : "RUNNING"}</Badge> : <Badge variant="outline">…</Badge>}
        {o ? <Badge variant="secondary">{o.mergeMode === "pr-only" ? "PR-only: never merges" : o.mergeMode}{o.dryRun ? " · DRY RUN" : ""}</Badge> : null}
        <span className="flex-1" />
        {o && !paused && !stop ? <Button variant="outline" size="sm" onClick={() => void act("pause")}><Pause />Pause</Button> : null}
        {o && paused && !stop ? <Button variant="outline" size="sm" onClick={() => void act("resume")}><Play />Resume</Button> : null}
        {o && !stop ? (
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="destructive" size="sm"><OctagonAlert />Emergency stop</Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader><AlertDialogTitle>Emergency stop?</AlertDialogTitle><AlertDialogDescription>Running agents are terminated now and nothing new starts until you clear the stop.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep running</AlertDialogCancel><AlertDialogAction onClick={() => void act("stop")}>Stop everything</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
        {o && stop ? <Button variant="outline" size="sm" onClick={() => void act("clear-stop")}><ShieldOff />Clear stop</Button> : null}
      </header>
      <nav className="flex gap-1 border-b">
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors", isActive ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{label}</NavLink>
        ))}
      </nav>
      {showUpdate ? (
        <Alert role="status"><ArrowUpCircle /><AlertDescription className="flex flex-wrap items-center gap-x-2">
          <span><b>Update available:</b> {upd!.current} → {upd!.latest}.</span><span>Run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">software-factory update</code> in a terminal, then restart the factory (wait for a quiet moment: a restart redoes any stage in progress).</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={dismiss} aria-label="dismiss update notice"><X /></Button></AlertDescription></Alert>
      ) : null}
      {stop ? <Alert variant="destructive" role="alert"><OctagonAlert /><AlertDescription>Emergency stop is active{o?.control.reason ? `: ${o.control.reason}` : ""}. No new work starts and running agents were terminated.</AlertDescription></Alert> : null}
      {msg ? <Alert variant="destructive" role="alert"><AlertDescription>{msg}</AlertDescription></Alert> : null}
      {error && !o ? <Alert variant="destructive"><AlertDescription>Cannot load: {error}</AlertDescription></Alert> : null}
      <main className="min-w-0 flex-1"><Outlet context={{ overview: o, reload }} /></main>
    </div>
  );
}
