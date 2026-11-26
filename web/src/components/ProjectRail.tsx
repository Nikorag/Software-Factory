import { NavLink, useNavigate } from "react-router-dom";
import { Activity, Columns3, GitBranch, Menu as MenuIcon, Settings as SettingsIcon, Plus } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { inHubMode } from "@/lib/api";
import { desktopMenu, electronMac } from "@/lib/platform";
import { bucketOf, initialOf, lastTab, projectMeta, stageName, swatch, toneOf, TONE, type Bucket } from "@/lib/projects";
import { ago } from "@/lib/format";
import type { Job, Overview, Project, ProfileInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

const row = "flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-accent/70";
const GROUPS: { id: Bucket; label: string; color: string }[] = [
  { id: "running", label: "Working", color: TONE.run }, { id: "needs", label: "Needs you", color: TONE.wait }, { id: "queued", label: "Queued", color: "#C4C4CC" },
];

export function ProjectRail({ overview: o, projects, jobs, projectId, jobId, profiles, stop, paused }: {
  overview: Overview | null; projects: Project[]; jobs: Job[]; projectId: string | null; jobId: string | null;
  profiles: { current: string; profiles: ProfileInfo[] } | null; stop: boolean; paused: boolean;
}) {
  const nav = useNavigate();
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const state = stop ? { t: "EMERGENCY STOP", c: TONE.fail } : paused ? { t: "PAUSED", c: TONE.wait } : { t: "RUNNING", c: TONE.ok };
  const pick = (id: string) => nav(lastTab(id) ?? `/p/${encodeURIComponent(id)}`);
  return (
    <aside aria-label="Projects and jobs" className="flex max-h-[60vh] min-h-0 w-full shrink-0 flex-col border-b border-line bg-rail md:max-h-none md:w-[264px] md:border-b-0 md:border-r">
      <div className={cn("app-drag flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pr-3.5", electronMac ? "pl-[84px]" : "pl-4")}>
        {desktopMenu() ? <button type="button" aria-label="Application menu" title="Menu" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); desktopMenu()?.showMenu(r.left, r.bottom); }}><MenuIcon className="size-4" aria-hidden /></button> : null}
        {inHubMode() ? <a href="/" className="text-xs text-muted-foreground hover:underline">← Hub</a> : null}
        <NavLink to="/" className="flex-1 truncate text-sm font-semibold">Software Factory</NavLink>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-1 pt-3">
        {profiles && profiles.profiles.length > 1 && !inHubMode() ? (
          <Select value={profiles.current} onValueChange={(name) => { const p = profiles.profiles.find((x) => x.name === name); if (p && !p.current) window.location.href = p.url; }}>
            <SelectTrigger size="sm" className="h-7 w-auto gap-2 text-xs" aria-label="profile"><SelectValue /></SelectTrigger>
            <SelectContent>{profiles.profiles.map((p) => <SelectItem key={p.name} value={p.name} disabled={!p.running && !p.current}>{p.name}{p.running ? "" : " (stopped)"}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
        {o ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-semibold tracking-wide" style={{ color: state.c, borderColor: `${state.c}66` }}>
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: state.c }} />{state.t}
          </span>
        ) : <span className="inline-flex h-6 items-center rounded-full border px-2.5 text-[11.5px] text-muted-foreground">…</span>}
        {o ? <span className="whitespace-nowrap text-[11.5px] text-muted-foreground" title="The factory opens pull requests and never merges them">{o.mergeMode === "pr-only" ? "PR-only" : o.mergeMode}{o.dryRun ? " · DRY RUN" : ""}</span> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between px-4 pb-1.5 pt-3.5">
          <span className="text-xs font-medium text-dim">Projects</span>
          <NavLink to="/settings?tab=projects" aria-label="Add project" className="flex size-6 items-center justify-center rounded-md text-dim hover:bg-accent hover:text-foreground"><Plus className="size-3.5" /></NavLink>
        </div>
        <nav aria-label="Project list" className="flex flex-col gap-0.5 px-2">
          {projects.length === 0 ? <div className="px-2.5 py-1 text-xs text-dim">No projects yet.</div> : null}
          {projects.map((p) => {
            const meta = projectMeta(jobs.filter((j) => j.project === p.id)), sel = p.id === projectId;
            return (
              <button key={p.id} type="button" onClick={() => pick(p.id)} aria-current={sel ? "true" : undefined} className={cn(row, "min-h-9", sel && "bg-accent")}>
                <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-bold text-background" style={{ background: swatch(p.id) }}>{initialOf(p)}</span>
                <span className={cn("min-w-0 flex-1 truncate", sel ? "font-semibold" : "font-medium")}>{p.name}</span>
                <span className="whitespace-nowrap text-[11.5px]" style={{ color: meta.color }}>{meta.text}</span>
              </button>
            );
          })}
        </nav>

        <div className="mx-4 mt-3.5 border-t border-line" />
        <div className="flex items-center justify-between px-4 pb-1 pt-3"><span className="text-xs font-medium text-dim">Jobs</span><span className="text-[11.5px] text-dim">{jobs.length} open</span></div>
        <nav aria-label="Open jobs" className="flex flex-col px-2 pb-3">
          {jobs.length === 0 ? <div className="px-2.5 py-1 text-xs text-dim">Nothing open.</div> : null}
          {GROUPS.map((g) => {
            const items = jobs.filter((j) => bucketOf(j) === g.id);
            if (!items.length) return null;
            return (
              <div key={g.id}>
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-[11.5px] font-semibold" style={{ color: g.color }}>{g.label} <span className="font-medium text-dim">{items.length}</span></div>
                {items.map((j) => (
                  <NavLink key={j.id} to={`/jobs/${j.id}`} className={cn(row, "min-h-8 text-[12.5px]", j.id === jobId && "bg-secondary")}>
                    <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: toneOf(j) }} />
                    <span className="min-w-0 flex-1 truncate"><span className="font-semibold">{nameOf(j.project)}</span><span className="text-muted-foreground"> · {stageName(j)}</span></span>
                    <span className="text-[11.5px] text-dim">{ago(j.updatedAt).replace(" ago", "")}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </div>

      <nav aria-label="Factory" className="flex shrink-0 flex-col gap-0.5 border-t border-line p-2">
        {([["/board", "Board", Columns3], ["/jobs", "All jobs", GitBranch], ["/health", "Factory health", Activity], ["/settings", "Settings", SettingsIcon]] as const).map(([to, label, Icon]) => (
          <NavLink key={to} to={to} className={({ isActive }) => cn(row, "min-h-[34px] text-[#C4C4CC]", isActive && "bg-accent text-foreground")}>
            <Icon className="size-[15px]" aria-hidden />{label}
            {to === "/health" && o && o.health.length ? <span className="ml-auto size-[7px] rounded-full" style={{ background: o.health.every((h) => h.status === "ok") ? TONE.ok : TONE.wait }} aria-label={o.health.every((h) => h.status === "ok") ? "all checks passing" : "a check needs attention"} /> : null}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
