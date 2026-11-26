import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Play, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pager } from "@/components/Pager";
import { usePaged } from "@/lib/paging";
import { StatusBadge } from "@/components/StatusBadge";
import { api, send } from "@/lib/api";
import type { Board as BoardData, BoardItem } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { ConnectionBanner, useOffline } from "@/components/ConnectionBanner";
import { safeLink, stageLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

const ALL = "__all";

const LANE_PAGE = 10;
/** One column of the board: the first few tickets, then "show more" so a busy column does not become a wall. */
function Lane({ state, items, render }: { state: string; items: BoardItem[]; render: (t: BoardItem) => React.ReactNode }) {
  const [shown, setShown] = useState(LANE_PAGE);
  return (
    <section aria-label={state} className="grid w-72 shrink-0 content-start gap-2">
      <h3 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{state}<span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{items.length}</span></h3>
      {items.slice(0, shown).map(render)}
      {items.length > shown ? <Button size="sm" variant="ghost" onClick={() => setShown(shown + LANE_PAGE)}>Show {Math.min(LANE_PAGE, items.length - shown)} more ({items.length - shown} hidden)</Button> : null}
    </section>
  );
}

function Ticket({ t, onStart, busy }: { t: BoardItem; onStart: (t: BoardItem) => void; busy: boolean }) {
  const href = safeLink(t.url); // a ticket URL comes from the tracker: never let it be javascript: or data:
  return (
    <div className="grid gap-2 rounded-lg border bg-card p-3 text-sm shadow-sm">
      <div className="flex items-center gap-2">
        {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs font-semibold hover:underline">{t.key}<ExternalLink className="size-3" /></a> : <span className="font-mono text-xs font-semibold">{t.key}</span>}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t.projectName}</span>
      </div>
      <div className="font-medium leading-snug">{t.title}</div>
      {t.labels.length ? <div className="flex flex-wrap gap-1">{t.labels.map((l) => <Badge key={l} variant="outline" className="text-[10px]">{l}</Badge>)}</div> : null}
      <div className="flex items-center gap-2">
        {t.job ? (
          <Link to={`/jobs/${t.job.id}`} className="flex items-center gap-2 text-xs hover:underline"><StatusBadge status={t.job.status} /><span className="text-muted-foreground">{stageLabel(t.job.stage).toLowerCase()}</span></Link>
        ) : null}
        <span className="flex-1" />
        {t.canStart ? <Button size="sm" disabled={busy} onClick={() => onStart(t)}><Play />{t.job ? "Start again" : "Start"}</Button> : null}
      </div>
      {!t.canStart && t.reason ? <p className="text-xs text-muted-foreground">{t.reason}</p> : null}
    </div>
  );
}

/** Pick tickets to work on. Search by number ("418"), key ("JAM-418") or words. Starting a ticket is your opt-in: it needs no label or status. */
export function Board() {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [project, setProject] = useState(ALL);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const { data, error, updatedAt, reload } = usePoll((signal) => api<BoardData>(`/api/board${(() => { const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(project !== ALL ? { project } : {}) }).toString(); return qs ? `?${qs}` : ""; })()}`, signal), 20000, [q, project]);
  const offline = useOffline() || error !== null;

  const start = async (t: BoardItem) => {
    if (busy) return;
    setBusy(t.id); setMsg(null);
    const r = await send<{ jobId: string }>("POST", "/api/board/start", { issueId: t.id });
    setBusy(null);
    setMsg(r.ok ? { ok: true, text: `Started ${t.key}. It is queued and will begin shortly.` } : { ok: false, text: r.error });
    void reload();
  };

  const lanes = new Map<string, BoardItem[]>();
  for (const t of data?.items ?? []) lanes.set(t.state, [...(lanes.get(t.state) ?? []), t]);
  const searching = q !== "";
  const results = usePaged(data?.items ?? [], 25, `${q}|${project}`);

  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search tickets" className="pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Find by number or title:  418,  JAM-418,  login" /></div>
        {data && data.projects.length > 1 ? (
          <Select value={project} onValueChange={setProject}><SelectTrigger className="w-48" aria-label="project filter"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value={ALL}>all projects</SelectItem>{data.projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select>
        ) : null}
        {data ? <Badge variant="outline" className={cn(data.mode === "manual" ? "border-loop/50 text-loop" : "border-ok/50 text-ok")}>{data.mode === "manual" ? "Manual mode: nothing starts until you start it" : "Automatic mode: labelled tickets start on their own"}</Badge> : null}
      </div>
      {msg ? <Alert variant={msg.ok ? "default" : "destructive"} role={msg.ok ? "status" : "alert"}><AlertDescription>{msg.text}</AlertDescription></Alert> : null}
      <ConnectionBanner error={error} updatedAt={updatedAt} what="board" />
      {data && data.items.length === 0 ? (
        <Card><CardContent className="text-sm text-muted-foreground">{searching ? `No ticket matches “${q}” in this profile's projects.` : data.projects.length ? "No open tickets in your projects." : <>No projects are linked to Linear yet. <Link className="underline" to="/settings">Add one in Settings</Link>.</>}</CardContent></Card>
      ) : null}
      {searching ? (<>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{results.slice.map((t) => <div key={t.id} className="grid gap-1"><span className="text-xs text-muted-foreground">{t.state}</span><Ticket t={t} onStart={start} busy={busy !== null || offline} /></div>)}</div>
        <Pager page={results.page} pages={results.pages} pageSize={results.pageSize} total={results.total} onPage={results.setPage} onPageSize={results.setPageSize} />
      </>) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {[...lanes.entries()].map(([state, items]) => (
            <Lane key={state} state={state} items={items} render={(t) => <Ticket key={t.id} t={t} onStart={start} busy={busy !== null || offline} />} />
          ))}
        </div>
      )}
    </div>
  );
}
