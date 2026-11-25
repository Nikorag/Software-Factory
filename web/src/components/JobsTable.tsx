import { useNavigate } from "react-router-dom";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ago } from "@/lib/format";
import type { Job } from "@/lib/types";
import { ProgressStrip } from "./ProgressStrip";
import { StatusBadge } from "./StatusBadge";

export function JobsTable({ jobs }: { jobs: Job[] }) {
  const nav = useNavigate();
  if (!jobs.length) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <Table>
      <TableHeader><TableRow>{["Ticket", "Project", "Progress", "Stage", "Status", "Updated", "Note"].map((c) => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
      <TableBody>
        {jobs.map((j) => (
          <TableRow key={j.id} className="cursor-pointer" tabIndex={0} onClick={() => nav(`/jobs/${j.id}`)} onKeyDown={(e) => { if (e.key === "Enter") nav(`/jobs/${j.id}`); }}>
            <TableCell className="font-mono text-xs">{j.key}{j.dryRun ? " (dry)" : ""}</TableCell>
            <TableCell>{j.project}</TableCell>
            <TableCell><ProgressStrip job={j} /></TableCell>
            <TableCell>{j.stage}{j.heldFromStage ? <small className="text-muted-foreground"> ← {j.heldFromStage}</small> : null}</TableCell>
            <TableCell><StatusBadge status={j.status} /></TableCell>
            <TableCell className="text-muted-foreground">{ago(j.updatedAt)}</TableCell>
            <TableCell className={j.lastError ? "text-destructive" : "text-muted-foreground"}>{(j.lastError || (j.prUrl ? "PR raised" : "")).split("\n")[0]!.slice(0, 90)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
