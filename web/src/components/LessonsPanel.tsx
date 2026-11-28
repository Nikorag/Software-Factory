import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { usePoll } from "@/hooks/usePoll";
import { api, send } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Lesson, LessonKind, LessonStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export const KINDS: LessonKind[] = ["command", "convention", "pitfall", "reviewer-pref"];
export const FILTERS: (LessonStatus | "all")[] = ["all", "proposed", "active", "retired"];
const MAX = 500;
const select = "h-9 rounded-md border bg-transparent px-2 text-sm";
const STATUS_TONE: Record<LessonStatus, string> = { proposed: "text-wait", active: "text-ok", retired: "text-muted-foreground" };

/** Where a lesson came from, in words. */
export const sourceLabel = (l: Pick<Lesson, "source" | "sourceJobId">): string =>
  l.source === "human" ? "added by a person" : l.source.startsWith("decision:") ? "from a human answer" : l.source.startsWith("stage_execution:") ? "learned from a job's fix cycle" : l.source;

/**
 * A project's lessons (ADR 0017): what the factory learned on earlier jobs. Proposed lessons are only candidates; Approve makes one
 * active, and only active lessons are given to agents. Text comes from logs and people, so it is only rendered as text.
 */
export function LessonsPanel({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<LessonStatus | "all">("all");
  const { data, error, reload } = usePoll((signal) => api<{ lessons: Lesson[] }>(`/api/projects/${encodeURIComponent(projectId)}/lessons`, signal), 15_000, [projectId]);
  const [busy, setBusy] = useState<number | "new" | null>(null), [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; text: string; kind: LessonKind } | null>(null);
  const [draft, setDraft] = useState<{ text: string; kind: LessonKind }>({ text: "", kind: "convention" });
  const all = data?.lessons ?? [];
  const shown = filter === "all" ? all : all.filter((l) => l.status === filter);
  const count = (s: LessonStatus | "all") => (s === "all" ? all.length : all.filter((l) => l.status === s).length);

  const act = async (id: number | "new", method: "POST" | "PUT", path: string, body: unknown, done: string) => {
    if (busy !== null) return;
    setBusy(id); setMsg(null);
    const r = await send(method, path, body);
    setBusy(null);
    setMsg(r.ok ? done : r.error);
    if (r.ok) { setEditing(null); if (id === "new") setDraft({ ...draft, text: "" }); }
    await reload();
  };

  return (
    <section aria-label="Project lessons" className="grid gap-4">
      <p className="max-w-3xl text-[13px] text-muted-foreground">
        Short notes the factory carries from one job on this project to the next. New ones start as <b>proposed</b> and are only used once you approve them;
        approved lessons are given to the implementer, spec writer and reviewers as context (never as rules that override a check or a gate), and retire on their own when unused.
      </p>
      {error ? <div role="alert" className="rounded-lg border px-3 py-2 text-sm text-destructive">Could not load lessons: {error}</div> : null}
      {msg ? <div role="status" className="rounded-lg border bg-card px-3 py-2 text-sm">{msg}</div> : null}

      <div role="group" aria-label="Filter lessons by status" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => <Button key={f} size="sm" variant={filter === f ? "secondary" : "outline"} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f} ({count(f)})</Button>)}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {shown.length === 0 ? <div className="px-4 py-4 text-[13px] text-muted-foreground">{data ? "No lessons here yet." : "Loading…"}</div> : null}
        {shown.map((l) => (
          <article key={l.id} aria-label={`Lesson ${l.id}`} className="grid gap-2 border-t border-line px-4 py-3 text-[13px] first:border-t-0">
            {editing?.id === l.id ? (
              <div className="grid gap-2">
                <Textarea aria-label="Lesson text" value={editing.text} maxLength={MAX} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                <div className="flex flex-wrap items-center gap-2">
                  <select aria-label="Lesson kind" className={select} value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as LessonKind })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
                  <Button size="sm" disabled={busy !== null || !editing.text.trim()} onClick={() => void act(l.id, "PUT", `/api/lessons/${l.id}`, { text: editing.text, kind: editing.kind }, "Lesson saved.")}>Save</Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </div>
            ) : <p className="whitespace-pre-wrap wrap-anywhere">{l.text}</p>}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
              <span className={cn("font-medium", STATUS_TONE[l.status])}>{l.status}</span>
              <span className="font-mono">{l.kind}</span>
              <span>{sourceLabel(l)}</span>
              <span>used {l.hits}×{l.lastUsedAt ? `, last ${ago(l.lastUsedAt)}` : ""}</span>
              <span className="ml-auto flex gap-2">
                {l.status === "proposed" ? <Button size="sm" disabled={busy !== null} onClick={() => void act(l.id, "POST", `/api/lessons/${l.id}/approve`, {}, "Lesson approved: it will be used from the next agent run.")}>Approve</Button> : null}
                {l.status !== "retired" && editing?.id !== l.id ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setEditing({ id: l.id, text: l.text, kind: l.kind })}>Edit</Button> : null}
                {l.status === "proposed" ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(l.id, "POST", `/api/lessons/${l.id}/reject`, {}, "Lesson rejected.")}>Reject</Button> : null}
                {l.status === "active" ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void act(l.id, "POST", `/api/lessons/${l.id}/retire`, {}, "Lesson retired: it will not be used again.")}>Retire</Button> : null}
              </span>
            </div>
          </article>
        ))}
      </div>

      <form className="grid gap-2 rounded-xl border bg-card p-4" onSubmit={(e) => { e.preventDefault(); if (draft.text.trim()) void act("new", "POST", `/api/projects/${encodeURIComponent(projectId)}/lessons`, draft, "Lesson added as proposed: approve it to use it."); }}>
        <label htmlFor="new-lesson" className="text-[13px] font-semibold">Add a lesson</label>
        <Textarea id="new-lesson" value={draft.text} maxLength={MAX} placeholder="One or two imperative sentences, e.g. Run `pnpm test:unit`, not `pnpm test`; the latter needs a database." onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="New lesson kind" className={select} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as LessonKind })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <Button type="submit" size="sm" disabled={busy !== null || !draft.text.trim()}>Propose</Button>
          <span className="text-xs text-muted-foreground">Never paste secrets: text that looks like one is refused.</span>
        </div>
      </form>
    </section>
  );
}
