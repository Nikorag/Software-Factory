import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dur } from "@/lib/format";
import type { Invocation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Conversation, TERM } from "./Conversation";

const role = (r: Invocation) => r.agent.split("/")[1] ?? r.agent;

/**
 * One window for all the agent sessions behind a step: a tab per session (a step can have dozens: every implement pass, converge check,
 * fix cycle), each drawn like a Claude Code session. `runs` is live (it follows the job's polling), so a tab flips from live to finished by itself.
 */
export function Peek({ jobId, runs, activeId, onActive, onClose, wrap, onWrap, ctx }: {
  jobId: string; runs: Invocation[]; activeId: number; onActive: (id: number) => void; onClose: () => void;
  wrap: boolean; onWrap: (w: boolean) => void; ctx: { key?: string; branch?: string | null };
}) {
  const active = runs.find((r) => r.id === activeId) ?? runs.at(-1);
  const tabs = useRef<HTMLDivElement>(null);
  useEffect(() => { tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "center" }); }, [active?.id]);
  if (!active) return null;
  const move = (by: number) => { const i = runs.findIndex((r) => r.id === active.id); const n = runs[(i + by + runs.length) % runs.length]; if (n) onActive(n.id); };

  const tabStrip = runs.length > 1 ? (
  <div ref={tabs} role="tablist" aria-label="Agent sessions" className={cn("flex max-h-24 shrink-0 flex-wrap overflow-y-auto border-b text-xs", TERM.line)}
    onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); move(1); } else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); } }}>
    {runs.map((r, i) => (
      <button key={r.id} type="button" role="tab" aria-selected={r.id === active.id} tabIndex={r.id === active.id ? 0 : -1} onClick={() => onActive(r.id)}
        className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 font-mono outline-none focus-visible:bg-[#2a2c31]", r.id === active.id ? cn("border-[#d97757]", TERM.text) : cn("border-transparent hover:bg-[#232428]", TERM.dim))}>
        <span className={TERM.dim}>{i + 1}</span>{role(r)}{r.finished ? (r.durationMs ? <span className={TERM.dim}>· {dur(r.durationMs)}</span> : null) : <span className={TERM.coral}>● live</span>}
      </button>
    ))}
  </div>
  ) : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false} className={cn("flex h-[85vh] max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl", TERM.bg, TERM.text, TERM.line)}>
        <DialogHeader className="sr-only">
          <DialogTitle>{active.finished ? "Conversation" : "Live"}: {role(active)}</DialogTitle>
          <DialogDescription>The back-and-forth of an agent run, shown like a Claude Code session.</DialogDescription>
        </DialogHeader>
        <Conversation key={active.id} jobId={jobId} runId={active.id} running={!active.finished} ctx={ctx} wrap={wrap} onWrap={onWrap} tabs={tabStrip} />
      </DialogContent>
    </Dialog>
  );
}
