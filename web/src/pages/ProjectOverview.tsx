import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOverview } from "@/pages/Overview";
import { ConnectionBanner, useOffline } from "@/components/ConnectionBanner";
import { usePoll } from "@/hooks/usePoll";
import { api, send } from "@/lib/api";
import { ago } from "@/lib/format";
import { stripStates } from "@/lib/pipeline";
import { effectiveStatus, initialOf, openJobs, stageName, swatch, toneOf, TONE } from "@/lib/projects";
import type { Board, Project } from "@/lib/types";
import { cn } from "@/lib/utils";

const card = "overflow-hidden rounded-xl border bg-card";
const SEG = { done: TONE.ok, run: TONE.run, wait: TONE.wait, fail: TONE.fail, idle: "#26262C" } as const;
const DONE_TONE: Record<string, string> = { done: TONE.ok, failed: TONE.fail, cancelled: TONE.queue };
const DONE_LABEL: Record<string, string> = { done: "finished", failed: "failed", cancelled: "cancelled" };

/** The project's own page: what is moving, what is ready to start, and what finished recently. */
export function ProjectOverview() {
  const { projectId = "" } = useParams();
  const nav = useNavigate();
  const { overview: o, reload } = useOverview();
  const { data: projData } = usePoll((signal) => api<{ projects: Project[] }>("/api/projects", signal), 10_000);
  const { data: board, error, updatedAt, reload: reloadBoard } = usePoll((signal) => api<Board>(`/api/board?project=${encodeURIComponent(projectId)}`, signal), 20_000, [projectId]);
  const offline = useOffline() || error !== null;
  const [busy, setBusy] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  if (!o) return <Skeleton className="h-64 w-full" />;
  const p = projData?.projects.find((x) => x.id === projectId);
  const name = p?.name ?? projectId;
  const mine = openJobs(o).filter((j) => j.project === projectId);
  const finished = o.recent.filter((j) => j.project === projectId && ["done", "failed", "cancelled"].includes(effectiveStatus(j)) && !j.archivedAt);
  const n = (s: string) => mine.filter((j) => effectiveStatus(j) === s).length;
  const ready = (board?.items ?? []).filter((t) => t.canStart);
  const stats = [
    { n: n("running"), label: "running", c: TONE.run }, { n: n("queued"), label: "queued", c: "#ECECEE" }, { n: n("waiting") + n("failed"), label: "need you", c: TONE.wait },
    { n: finished.filter((j) => effectiveStatus(j) === "done").length, label: "finished recently", c: TONE.ok }, { n: n("failed"), label: "failed", c: n("failed") ? TONE.fail : "#ECECEE" },
  ];
  const start = async (id: string, key: string) => {
    if (busy) return;
    setBusy(id); setMsg(null);
    const r = await send<{ jobId: string }>("POST", "/api/board/start", { issueId: id, projectId });
    setBusy(null); setMsg(r.ok ? `Started ${key}. It is queued and will begin shortly.` : r.error);
    void reloadBoard(); void reload();
  };
  const pickup = p?.overrides?.pickupMode ?? board?.mode;
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-[360px] items-center gap-3">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-[9px] text-[17px] font-bold text-background" style={{ background: swatch(projectId) }}>{initialOf({ name })}</span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
            <div className="truncate text-[12.5px] text-muted-foreground">{[p?.githubRepo ?? p?.bitbucketRepo ?? p?.repository, pickup ? `${pickup === "manual" ? "Manual" : "Automatic"} pickup` : null, p?.overrides?.maxConcurrentJobs ? `up to ${p.overrides.maxConcurrentJobs} at once` : null].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
        <div className="contents max-md:grid max-md:w-full max-md:grid-cols-2 max-md:gap-2">
          <Button variant="outline" size="sm" asChild><Link to={`/settings?tab=projects&project=${encodeURIComponent(projectId)}`}>Project settings</Link></Button>
          <Button size="sm" asChild><Link to="/board">Start a ticket</Link></Button>
        </div>
      </div>
      <ConnectionBanner error={error} updatedAt={updatedAt} what="board" />
      {msg ? <div role="status" className="rounded-lg border bg-card px-3 py-2 text-sm">{msg}</div> : null}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3 max-md:grid-cols-3 max-md:gap-2">
        {stats.map((s) => <div key={s.label} className="rounded-xl border bg-card px-4 py-3.5 max-md:px-3 max-md:py-2.5"><div className="text-[26px] max-md:text-[22px] font-semibold leading-tight tracking-tight tabular-nums" style={{ color: s.c }}>{s.n}</div><div className="text-xs text-muted-foreground">{s.label}</div></div>)}
      </div>

      <section aria-label="Ongoing jobs" className={card}>
        <h2 className="px-4 pb-2.5 pt-3.5 text-[13px] font-semibold">Ongoing</h2>
        {mine.length ? (
          <div className="overflow-x-auto"><div className="min-w-[640px] max-md:min-w-0">
            {mine.map((j) => (
              <button key={j.id} type="button" onClick={() => nav(`/jobs/${j.id}`)} className="grid min-h-12 w-full grid-cols-[96px_minmax(0,1.4fr)_minmax(0,1fr)_130px_90px] items-center gap-3.5 border-t border-line px-4 text-left text-[13px] hover:bg-accent/40 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1.5 max-md:py-3">
                <span className="font-mono text-xs font-semibold">{j.key}</span>
                <span className="truncate text-muted-foreground max-md:hidden">{j.project}</span>
                <span className="flex gap-0.5 max-md:col-span-2 max-md:row-start-3" aria-hidden>{stripStates(j).map((s, i) => <span key={i} className="h-1.5 flex-1 rounded-sm" style={{ background: s === "idle" ? SEG.idle : s === "run" ? toneOf(j) : SEG[s] }} />)}</span>
                <span className="text-[12.5px] max-md:col-span-2 max-md:row-start-2" style={{ color: toneOf(j) }}>{stageName(j)}</span>
                <span className="text-right text-xs text-dim max-md:col-start-2 max-md:row-start-1">{ago(j.updatedAt)}</span>
              </button>
            ))}
          </div></div>
        ) : <div className="border-t border-line px-4 py-4 text-[13px] text-muted-foreground">Nothing in progress. Pick a ticket from the board to start one.</div>}
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section aria-label="Ready on the board" className={cn(card, "min-w-0 flex-1 basis-[380px]")}>
          <div className="flex items-center px-4 pb-2.5 pt-3.5"><h2 className="text-[13px] font-semibold">Ready to start</h2><span className="ml-auto text-xs text-muted-foreground">from {p?.tracker ?? "your tracker"}</span></div>
          {ready.slice(0, 8).map((t) => (
            <div key={t.id} className="flex min-h-[46px] items-center gap-3 border-t border-line px-4 text-[13px]">
              <span className="w-[72px] shrink-0 font-mono text-xs text-muted-foreground">{t.key}</span>
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs max-md:px-4 max-md:text-sm" disabled={busy !== null || offline} onClick={() => void start(t.id, t.key)}>Start</Button>
            </div>
          ))}
          {ready.length === 0 ? <div className="border-t border-line px-4 py-4 text-[13px] text-muted-foreground">Nothing is waiting to be started.</div> : null}
        </section>
        <section aria-label="Recently finished" className={cn(card, "min-w-0 flex-1 basis-[380px]")}>
          <h2 className="px-4 pb-2.5 pt-3.5 text-[13px] font-semibold">Recently finished</h2>
          {finished.slice(0, 8).map((j) => (
            <Link key={j.id} to={`/jobs/${j.id}`} className="flex min-h-[46px] max-md:min-h-12 items-center gap-3 border-t border-line px-4 text-[13px] hover:bg-accent/40">
              <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: DONE_TONE[effectiveStatus(j)] }} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{j.key}</span>
              <span className="text-xs" style={{ color: DONE_TONE[effectiveStatus(j)] }}>{DONE_LABEL[effectiveStatus(j)]}</span>
              <span className="w-10 text-right text-xs text-dim">{ago(j.updatedAt).replace(" ago", "")}</span>
            </Link>
          ))}
          {finished.length === 0 ? <div className="border-t border-line px-4 py-4 text-[13px] text-muted-foreground">Nothing has finished yet.</div> : null}
        </section>
      </div>
    </div>
  );
}
