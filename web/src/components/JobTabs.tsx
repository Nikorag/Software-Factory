import { NavLink, useNavigate } from "react-router-dom";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { LayoutGrid } from "lucide-react";
import { toneOf } from "@/lib/projects";
import { stageName } from "@/lib/projects";
import type { Job } from "@/lib/types";
import { cn } from "@/lib/utils";

const tab = "inline-flex h-[34px] max-w-[280px] items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors";

/** The project's open jobs, one tab each, after the Overview tab. Finished jobs are in the Overview. */
export function JobTabs({ projectId, jobs, jobId }: { projectId: string; jobs: Job[]; jobId: string | null }) {
  const mobile = useIsMobile(), nav = useNavigate();
  if (mobile) {
    // A phone has no room for a tab per job: Overview, then one dropdown holding the open jobs.
    return (
      <nav aria-label="Project tabs" className="flex min-w-0 flex-1 items-center gap-1.5">
        <NavLink to={`/p/${encodeURIComponent(projectId)}`} end className={({ isActive }) => cn(tab, "shrink-0", isActive ? "border-input bg-secondary text-foreground" : "border-transparent text-[#C4C4CC] hover:bg-accent/60")}>
          <LayoutGrid className="size-3.5" aria-hidden />Overview
        </NavLink>
        {jobs.length ? (
          <Select value={jobId && jobs.some((j) => j.id === jobId) ? jobId : ""} onValueChange={(id) => nav(`/jobs/${id}`)}>
            <SelectTrigger size="sm" aria-label="Open jobs" className={cn("h-[34px] min-w-0 max-w-full flex-1 gap-2 text-[13px]", jobId && "bg-secondary")}><SelectValue placeholder={`Jobs (${jobs.length})`} /></SelectTrigger>
            <SelectContent>
              {jobs.map((j) => (
                <SelectItem key={j.id} value={j.id}>
                  <span className="flex min-w-0 items-center gap-2"><span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: toneOf(j) }} /><span className="font-mono text-xs font-semibold">{j.key}</span><span className="truncate text-muted-foreground">{stageName(j)}</span></span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </nav>
    );
  }
  return (
    <nav aria-label="Project tabs" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <NavLink to={`/p/${encodeURIComponent(projectId)}`} end className={({ isActive }) => cn(tab, isActive ? "border-input bg-secondary text-foreground" : "border-transparent text-[#C4C4CC] hover:bg-accent/60")}>
        <LayoutGrid className="size-3.5" aria-hidden />Overview
      </NavLink>
      {jobs.length ? <span aria-hidden className="mx-1 h-5 w-px bg-input" /> : null}
      {jobs.map((j) => {
        const sel = j.id === jobId;
        return (
          <NavLink key={j.id} to={`/jobs/${j.id}`} className={cn(tab, sel ? "border-input bg-secondary text-foreground" : "border-transparent text-[#C4C4CC] hover:bg-accent/60")}>
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: toneOf(j), boxShadow: sel ? "0 0 0 3px #0E0E10" : undefined }} />
            <span className="font-mono text-xs font-semibold">{j.key}</span>
            <span className={cn("truncate", sel ? "text-[#C4C4CC]" : "text-dim")}>{stageName(j)}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
