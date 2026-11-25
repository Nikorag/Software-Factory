import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";
import { usePoll } from "@/hooks/usePoll";

export function Projects() {
  const { data } = usePoll(() => api<{ projects: Project[] }>("/api/projects"), 10000);
  const ps = data?.projects ?? [];
  return (
    <Card><CardContent>
      <Table>
        <TableHeader><TableRow>{["Project", "Autonomy", "Linear", "Commands", "Validation", "Active"].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {ps.map((p) => (
            <TableRow key={p.id}>
              <TableCell><b>{p.name}</b><div className="font-mono text-xs text-muted-foreground">{p.githubRepo || p.repository}</div></TableCell>
              <TableCell>{p.autonomy}</TableCell>
              <TableCell>{p.linear ? `${p.linear.teamKey}${p.linear.projectName ? ` / ${p.linear.projectName}` : ""}` : "—"}</TableCell>
              <TableCell>{p.commands.test ? <div className="flex flex-wrap gap-1">{["install", "build", "typecheck", "lint", "test"].filter((k) => p.commands[k]).map((k) => <Badge key={k} variant="outline" title={p.commands[k]} className={k === "test" ? "border-ok/40 text-ok" : ""}>{k}</Badge>)}</div> : <span className="text-loop">no test command: blocked</span>}</TableCell>
              <TableCell>
                {p.validation ? <span className={p.validation.ok ? "text-ok" : "text-destructive"}>{p.validation.ok ? "ok" : "failing"}</span> : <span className="text-muted-foreground">unchecked</span>}
                {p.validation ? <div className="text-xs text-muted-foreground">protection: {p.validation.protection}</div> : null}
                {(p.validation?.findings ?? []).slice(0, 3).map((f) => <div key={f} className="text-xs text-muted-foreground">{f.slice(0, 110)}</div>)}
              </TableCell>
              <TableCell>{p.activeJobs || ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent></Card>
  );
}
