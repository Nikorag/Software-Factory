import { useState, type ReactNode } from "react";
import { ago, stageText } from "@/lib/format";
import type { Decision, JobDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A section's mono heading, with an optional note on the right. */
export function SectionHead({ title, note, children }: { title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h2 className="z-label text-foreground">{title}</h2>
      {note ? <span className="z-label">{note}</span> : null}
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2 max-md:ml-0 max-md:w-full">{children}</div> : null}
    </div>
  );
}

/** Long text folded to two lines, with a button to read it all. */
function Fold({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split("\n").length > 2;
  return (
    <div className={className}>
      <p className={cn("whitespace-pre-wrap wrap-anywhere", !open && long && "line-clamp-2")}>{text}</p>
      {long ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="z-label mt-1 text-[var(--z-acc)] hover:underline max-md:min-h-11">{open ? "Show less" : "Show all"}</button> : null}
    </div>
  );
}

/** What the factory decided and why: one readable row each, the reasoning folded until asked for. */
export function DecisionList({ rows }: { rows: Decision[] }) {
  return (
    <ol className="grid" aria-label="Decisions">
      {rows.map((x) => (
        <li key={x.id} className="grid gap-1.5 border-b border-[var(--z-line)] py-3.5 last:border-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <code className="z-label wrap-anywhere text-[var(--z-acc)]">{x.kind}</code>
            <span className="z-label ml-auto normal-case tracking-normal">{x.actor}{x.at ? ` · ${ago(x.at)}` : ""}</span>
          </div>
          <p className="wrap-anywhere text-sm">{stageText(x.decision)}</p>
          {x.rationale ? <Fold text={stageText(x.rationale)} className="text-[13px] text-muted-foreground" /> : null}
        </li>
      ))}
    </ol>
  );
}

const base = (p: string) => p.split("/").at(-1) ?? p;
const dir = (p: string) => p.split("/").slice(0, -1).join("/");

/**
 * Files the job produced (each path once, with every kind it was recorded as), its worktree, and the write-back to the tracker
 * summarised: counts, with anything that did not go through listed.
 */
export function FilesPanel({ d }: { d: Pick<JobDetail, "artifacts" | "worktree" | "outbox"> }) {
  const [allOut, setAllOut] = useState(false);
  const files = new Map<string, Set<string>>();
  for (const a of d.artifacts) files.set(a.path, (files.get(a.path) ?? new Set()).add(a.kind));
  const counts = d.outbox.reduce<Record<string, number>>((m, o) => ({ ...m, [o.status]: (m[o.status] ?? 0) + 1 }), {});
  const problems = d.outbox.filter((o) => o.status !== "done");
  const shown = allOut ? d.outbox : problems;
  return (
    <div className="grid gap-8">
      <section className="grid gap-3" aria-label="Artifacts">
        <SectionHead title="Artifacts" note={`${files.size} file${files.size === 1 ? "" : "s"}`} />
        {files.size ? (
          <ul className="grid border border-[var(--z-line)]">
            {[...files].map(([path, kinds]) => (
              <li key={path} className="grid gap-1 border-b border-[var(--z-line)] px-4 py-3 last:border-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-4">
                <span className="min-w-0"><span className="block truncate font-mono text-[13px] text-foreground" title={path}>{base(path)}</span><span className="block truncate font-mono text-[11px] text-muted-foreground" title={path}>{dir(path)}</span></span>
                <span className="flex flex-wrap gap-1.5">{[...kinds].map((k) => <span key={k} className="z-label border border-[var(--z-line)] px-1.5 py-0.5 text-[10px]">{k}</span>)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">None yet.</p>}
      </section>
      <section className="grid gap-3" aria-label="Worktree">
        <SectionHead title="Worktree" note={d.worktree?.state} />
        {d.worktree ? <p className="border border-[var(--z-line)] px-4 py-3 font-mono text-xs wrap-anywhere">{d.worktree.path}<span className="text-muted-foreground"> on </span>{d.worktree.branch}</p> : <p className="text-sm text-muted-foreground">Not created.</p>}
      </section>
      <section className="grid gap-3" aria-label="Tracker write-back">
        <SectionHead title="Tracker write-back" note={d.outbox.length ? Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ") : undefined}>
          {problems.length !== d.outbox.length ? <button type="button" aria-expanded={allOut} onClick={() => setAllOut(!allOut)} className="z-label text-[var(--z-acc)] hover:underline max-md:min-h-11">{allOut ? "Only problems" : `Show all ${d.outbox.length}`}</button> : null}
        </SectionHead>
        {d.outbox.length === 0 ? <p className="text-sm text-muted-foreground">Nothing written back yet.</p>
          : shown.length === 0 ? <p className="text-sm text-muted-foreground">All {d.outbox.length} updates reached the tracker.</p>
          : (
            <ul className="grid border border-[var(--z-line)]">
              {shown.map((o) => (
                <li key={o.id} className="grid gap-0.5 border-b border-[var(--z-line)] px-4 py-2.5 last:border-0">
                  <span className="flex items-center gap-3 text-sm"><span className="font-mono text-[13px]">{o.kind.replaceAll("_", " ")}</span>
                    <span className={cn("z-label ml-auto", o.status === "done" ? "text-[var(--z-acc)]" : o.status === "failed" ? "text-[var(--z-fail)]" : "text-[var(--z-warn)]")}>{o.status}{o.attempts > 1 ? ` · ${o.attempts} tries` : ""}</span></span>
                  {o.lastError ? <span className="wrap-anywhere text-xs text-muted-foreground">{o.lastError}</span> : null}
                </li>
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
