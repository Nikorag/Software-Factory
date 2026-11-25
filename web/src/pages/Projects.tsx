import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, CircleDashed, Pencil, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import type { Project } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

const ORDER = ["install", "build", "typecheck", "lint", "test"] as const;

function Health({ p }: { p: Project }) {
  if (!p.validation) return <span className="flex items-center gap-1.5 text-muted-foreground"><CircleDashed className="size-4" />Not validated yet</span>;
  return p.validation.ok
    ? <span className="flex items-center gap-1.5 text-ok"><CheckCircle2 className="size-4" />Validated</span>
    : <span className="flex items-center gap-1.5 text-destructive"><XCircle className="size-4" />Validation failing</span>;
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-0"><dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt><dd className="truncate text-sm">{children}</dd></div>
);

/** One row per project: what it is, where it comes from, whether it is ready, and a way into the editor. */
function Row({ p }: { p: Project }) {
  const cmds = ORDER.filter((k) => p.commands[k]);
  const ready = Boolean(p.commands.test) && p.enabled;
  return (
    <li className="grid gap-3 p-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", !p.enabled ? "bg-muted-foreground/40" : ready ? "bg-ok" : "bg-loop")} aria-hidden="true" />
          <b className="truncate">{p.name}</b>
          {!p.enabled ? <span className="text-xs text-muted-foreground">disabled</span> : null}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={p.githubRepo || p.repository}>{p.githubRepo || p.repository}</div>
        <div className="mt-1.5 text-xs"><Health p={p} />{p.validation ? <span className="text-muted-foreground"> · protection: {p.validation.protection}</span> : null}</div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Linear">{p.linear ? `${p.linear.teamKey}${p.linear.projectName ? ` / ${p.linear.projectName}` : ""}` : "—"}</Fact>
        <Fact label="Autonomy">{p.autonomy}</Fact>
        <Fact label="Branch">{p.defaultBranch}</Fact>
        <Fact label="Active jobs">{p.activeJobs || "—"}</Fact>
        <div className="col-span-2 min-w-0 sm:col-span-4">
          <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Commands</dt>
          <dd className="text-sm">
            {p.commands.test
              ? <span className="font-mono text-xs"><span className="text-muted-foreground">{cmds.filter((k) => k !== "test").join(" · ")}{cmds.length > 1 ? " · " : ""}</span><span className="font-semibold text-ok">test</span> <span className="text-muted-foreground">({p.commands.test})</span></span>
              : <span className="flex items-center gap-1.5 text-loop"><AlertTriangle className="size-4" />No test command: the factory will not implement changes yet</span>}
          </dd>
        </div>
        {p.validation && p.validation.findings.length ? <div className="col-span-2 min-w-0 text-xs text-muted-foreground sm:col-span-4">{p.validation.findings.slice(0, 2).map((f) => <div key={f} className="truncate" title={f}>{f}</div>)}</div> : null}
      </dl>
      <Button variant="outline" size="sm" asChild className="justify-self-start md:justify-self-end"><Link to={`/settings?project=${encodeURIComponent(p.id)}`}><Pencil />Edit</Link></Button>
    </li>
  );
}

export function Projects() {
  const { data } = usePoll(() => api<{ projects: Project[] }>("/api/projects"), 10000);
  const ps = data?.projects ?? [];
  if (data && ps.length === 0) return <Card className="p-6 text-sm text-muted-foreground">No projects yet. <Link className="underline" to="/setup">Run the setup wizard</Link> or add one in <Link className="underline" to="/settings">Settings</Link>.</Card>;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <ul className="divide-y">{ps.map((p) => <Row key={p.id} p={p} />)}</ul>
      {data ? <div className="border-t px-4 py-2 text-xs text-muted-foreground">{ps.length} project{ps.length === 1 ? "" : "s"} · updated {ago(Date.now())}</div> : null}
    </Card>
  );
}
