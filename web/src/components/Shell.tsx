import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { OctagonAlert, Pause, Play, ShieldOff } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, getToken, post } from "@/lib/api";
import type { Overview } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

const NAV = [["/", "Overview"], ["/jobs", "Jobs"], ["/projects", "Projects"], ["/health", "Health"]] as const;

export function Shell() {
  const { data: o, error, reload } = usePoll(() => api<Overview>("/api/overview"), 3000);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (name: string) => { const err = await post(`/api/control/${name}`); setMsg(err); if (!err) void reload(); };
  const stop = o?.control.emergencyStop, paused = o?.control.paused;
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 px-4 py-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Software Factory</h1>
        {o ? <Badge variant="outline" className={cn("font-semibold", stop ? "border-destructive/50 text-destructive" : paused ? "border-loop/50 text-loop" : "border-ok/50 text-ok")}>{stop ? "EMERGENCY STOP" : paused ? "PAUSED" : "RUNNING"}</Badge> : <Badge variant="outline">…</Badge>}
        {o ? <Badge variant="secondary">{o.mergeMode === "pr-only" ? "PR-only: never merges" : o.mergeMode}{o.dryRun ? " · DRY RUN" : ""}</Badge> : null}
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{getToken() ? "controls enabled" : "read-only (no token: use `pnpm factory dashboard --open`)"}</span>
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
      {stop ? <Alert variant="destructive" role="alert"><OctagonAlert /><AlertDescription>Emergency stop is active{o?.control.reason ? `: ${o.control.reason}` : ""}. No new work starts and running agents were terminated.</AlertDescription></Alert> : null}
      {msg ? <Alert variant="destructive" role="alert"><AlertDescription>{msg}</AlertDescription></Alert> : null}
      {error && !o ? <Alert variant="destructive"><AlertDescription>Cannot load: {error}</AlertDescription></Alert> : null}
      <main className="flex-1"><Outlet context={{ overview: o, reload }} /></main>
    </div>
  );
}
