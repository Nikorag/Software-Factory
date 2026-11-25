import { useNavigate } from "react-router-dom";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ago } from "@/lib/format";
import type { Job } from "@/lib/types";
import { ProgressStrip } from "./ProgressStrip";
import { StatusBadge } from "./StatusBadge";

const FINISHED = ["done", "failed", "cancelled"];
export interface JobActions { archive: (j: Job, archived: boolean) => void; remove: (j: Job) => void }

/** Delete with a confirmation. Reused by the list and the job page. */
export function DeleteJobButton({ job, onConfirm, label }: { job: Job; onConfirm: () => void; label?: string }) {
  return (
    <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="outline" aria-label={`delete ${job.key}`}><Trash2 />{label}</Button></AlertDialogTrigger>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {job.key} permanently?</AlertDialogTitle>
        <AlertDialogDescription>This removes the job, its history and its agent logs. It cannot be undone. The pull request and the ticket are not touched. To keep the history but hide the job, archive it instead.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={onConfirm}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  );
}

export function JobsTable({ jobs, actions }: { jobs: Job[]; actions?: JobActions }) {
  const nav = useNavigate();
  if (!jobs.length) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <Table>
      <TableHeader><TableRow>{["Ticket", "Project", "Progress", "Stage", "Status", "Updated", "Note", ...(actions ? [""] : [])].map((c, i) => <TableHead key={i}>{c}</TableHead>)}</TableRow></TableHeader>
      <TableBody>
        {jobs.map((j) => (
          <TableRow key={j.id} className="cursor-pointer" tabIndex={0} onClick={() => nav(`/jobs/${j.id}`)} onKeyDown={(e) => { if (e.key === "Enter") nav(`/jobs/${j.id}`); }}>
            <TableCell className="font-mono text-xs">{j.key}{j.dryRun ? " (dry)" : ""}{j.archivedAt ? <span className="ml-1 text-muted-foreground">(archived)</span> : null}</TableCell>
            <TableCell>{j.project}</TableCell>
            <TableCell><ProgressStrip job={j} /></TableCell>
            <TableCell>{j.stage}{j.heldFromStage ? <small className="text-muted-foreground"> ← {j.heldFromStage}</small> : null}</TableCell>
            <TableCell><StatusBadge status={j.status} /></TableCell>
            <TableCell className="text-muted-foreground">{ago(j.updatedAt)}</TableCell>
            <TableCell className={j.lastError ? "text-destructive" : "text-muted-foreground"}>{(j.lastError || (j.prUrl ? "PR raised" : "")).split("\n")[0]!.slice(0, 90)}</TableCell>
            {actions ? (
              <TableCell onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {FINISHED.includes(j.status) ? (
                  <span className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" aria-label={`${j.archivedAt ? "restore" : "archive"} ${j.key}`} title={j.archivedAt ? "Restore" : "Archive"} onClick={() => actions.archive(j, !j.archivedAt)}>{j.archivedAt ? <ArchiveRestore /> : <Archive />}</Button>
                    <DeleteJobButton job={j} onConfirm={() => actions.remove(j)} />
                  </span>
                ) : null}
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
