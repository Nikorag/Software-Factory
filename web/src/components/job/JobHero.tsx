import type { ReactNode } from "react";
import { ago, dur } from "@/lib/format";
import { modeOfJob, nodesFor, stripFor, stripStates } from "@/lib/pipeline";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";

export type Tone = "go" | "wait" | "fail" | "idle";
const DOT: Record<Tone, string> = { go: "bg-[var(--z-acc)]", wait: "bg-[var(--z-warn)]", fail: "bg-[var(--z-fail)]", idle: "bg-[#6b6b6b]" };
const GLOW: Record<Tone, string> = {
  go: "radial-gradient(ellipse 70% 120% at 0% 0%, rgba(61,232,140,.14), transparent 60%)",
  wait: "radial-gradient(ellipse 70% 120% at 0% 0%, rgba(251,191,36,.12), transparent 60%)",
  fail: "radial-gradient(ellipse 70% 120% at 0% 0%, rgba(248,113,113,.12), transparent 60%)",
  idle: "none",
};

/** What a job is doing, in one or two words, and how loudly to say it. */
export function statusOf(j: Job): { word: string; tone: Tone; pulse: boolean } {
  if (j.status === "running") return { word: "Running", tone: "go", pulse: true };
  if (j.status === "waiting") return { word: "Needs you", tone: "wait", pulse: true };
  if (j.status === "failed") return { word: "Failed", tone: "fail", pulse: false };
  if (j.status === "cancelled") return { word: "Cancelled", tone: "idle", pulse: false };
  if (j.status === "done") return { word: j.prUrl ? "Merged" : "Done", tone: "go", pulse: false };
  if (j.stage === "MERGING") return { word: "Awaiting your merge", tone: "go", pulse: false };
  return { word: j.notBefore ? "Waiting" : "Queued", tone: "idle", pulse: false };
}

/** "■ RUNNING · IMPLEMENT": the square status dot and a mono label. */
export function StatusLine({ tone, pulse, children, className }: { tone: Tone; pulse?: boolean; children: ReactNode; className?: string }) {
  return <span className={cn("z-label inline-flex items-center gap-2.5", className)}><span aria-hidden className={cn("z-dot", DOT[tone], pulse && "z-pulse")} />{children}</span>;
}

const SEG = { done: "bg-[#2fb36c]", run: "bg-[var(--z-acc)] z-scan", wait: "bg-[var(--z-warn)]", fail: "bg-[var(--z-fail)]", idle: "bg-[#0e1b14]" } as const;

/** The pipeline as a segmented scanner bar (the holding page's KITT bar): one segment per step, the current one glowing. */
export function PipelineBar({ job }: { job: Job }) {
  const mode = modeOfJob(job), ids = stripFor(mode), st = stripStates(job), nodes = nodesFor(mode);
  const label = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  const cur = st.findIndex((s) => s !== "done");
  const where = cur < 0 ? `All ${ids.length} steps done` : `Step ${cur + 1} of ${ids.length}`;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="z-label">Pipeline</span>
        <span className="z-label">{where}{cur >= 0 ? <> · <span className="text-foreground">{label(ids[cur]!)}</span></> : null}</span>
      </div>
      <div role="img" aria-label={`Pipeline: ${where}${cur >= 0 ? `, at ${label(ids[cur]!)}` : ""}`} className="flex h-[22px] gap-[3px] border border-[#1e2a24] bg-[#060a08] p-1">
        {ids.map((id, i) => <i key={id} title={`${label(id)}: ${({ done: "done", run: "running", wait: "waiting", fail: "stopped here", idle: "not reached" })[st[i]!]}`} className={cn("flex-1", SEG[st[i]!])} />)}
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid content-start gap-1.5"><span className="z-label">{label}</span><span className="z-display text-[22px] tabular-nums md:text-[26px]">{children}</span></div>;
}

/**
 * The top of the job page: status, the ticket's title, the pipeline bar, the numbers that matter and the actions.
 * A soft glow in the status colour, like the holding page's green cloud.
 */
export function JobHero({ job: j, elapsedMs, agentMs, cycles, cap, actions }: { job: Job; elapsedMs: number; agentMs: number; cycles: number; cap: number; actions: ReactNode }) {
  const s = statusOf(j);
  return (
    <section aria-label="Job summary" className="relative grid gap-6 border border-[var(--z-line)] bg-[#0d0d0d] p-5 md:p-7" style={{ backgroundImage: GLOW[s.tone] }}>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <StatusLine tone={s.tone} pulse={s.pulse}><span className="text-foreground">{s.word}</span></StatusLine>
          <span className="z-label">Updated {ago(j.updatedAt)}</span>
        </div>
        <h1 className="z-display break-words text-[26px] md:text-[38px]" data-testid="job-title">{j.title || j.key}</h1>
        <p className="z-label flex flex-wrap gap-x-2.5 gap-y-1 normal-case tracking-[.06em]">
          <span className="font-semibold text-foreground">{j.key}</span><span aria-hidden>/</span><span>{j.project}</span><span aria-hidden>/</span><span>{j.workflow}</span>
          {j.autonomous ? <><span aria-hidden>/</span><span>autonomous</span></> : null}
          {j.dryRun ? <><span aria-hidden>/</span><span className="text-[var(--z-warn)]">dry run</span></> : null}
          {j.archivedAt ? <><span aria-hidden>/</span><span>archived</span></> : null}
        </p>
      </div>
      <PipelineBar job={j} />
      <div className="grid grid-cols-3 gap-4 border-t border-[var(--z-line)] pt-5">
        <Stat label="Elapsed">{dur(elapsedMs)}</Stat>
        <Stat label="Agent time">{dur(agentMs)}</Stat>
        <div className="grid content-start gap-1.5" title={`The cap is ${cap} for this project, shared by every review and CI`}>
          <span className="z-label">Fix cycles</span>
          <span className="z-display text-[22px] tabular-nums md:text-[26px]">{cycles}<span className="text-[var(--z-muted)]"> / {cap}</span></span>
          <span className="flex gap-[3px]" aria-hidden>{Array.from({ length: Math.max(1, cap) }, (_, i) => <i key={i} className={cn("h-1.5 flex-1 bg-[#1f1f1f]", i < cycles && (cycles >= cap ? "bg-[var(--z-fail)]" : "bg-[var(--z-warn)]"))} />)}</span>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap gap-2 max-md:grid max-md:grid-cols-2 max-md:[&>*:first-child:nth-last-child(odd)]:col-span-2">{actions}</div> : null}
    </section>
  );
}

/** The one thing the job needs from a person right now (merge, answer, retry), in a band that stands apart from everything else. */
export function NeedsYou({ tone, label, title, children, actions }: { tone: Tone; label: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  const border = { go: "border-[rgba(61,232,140,.45)]", wait: "border-[rgba(251,191,36,.45)]", fail: "border-[rgba(248,113,113,.45)]", idle: "border-[var(--z-line)]" }[tone];
  return (
    <section aria-label="Needs your attention" className={cn("grid gap-3 border bg-[#0d0d0d] p-5", border)} style={{ backgroundImage: GLOW[tone] }}>
      <StatusLine tone={tone} pulse={tone !== "idle"}>{label}</StatusLine>
      <h2 className="z-display text-xl md:text-2xl">{title}</h2>
      {children}
      {actions ? <div className="flex flex-wrap gap-2 max-md:grid max-md:grid-cols-1">{actions}</div> : null}
    </section>
  );
}
