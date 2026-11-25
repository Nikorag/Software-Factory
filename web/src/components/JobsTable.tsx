import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArchiveRestore, Loader2, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type DeleteOptions, type SendResult } from "@/lib/api";
import { ago, stageLabel, stageText } from "@/lib/format";
import type { Job } from "@/lib/types";
import { ProgressStrip } from "./ProgressStrip";
import { StatusBadge } from "./StatusBadge";

const FINISHED = ["done", "failed", "cancelled"];
export interface JobActions { archive: (j: Job, archived: boolean) => void; remove: (j: Job, o: DeleteOptions) => Promise<SendResult> }

/**
 * Delete with a confirmation. If the job still has a worktree on disk (the usual case for a failed or finished job), the dialog offers
 * to remove it too: the job cannot be deleted while its worktree exists. A worktree with uncommitted changes needs a second, explicit
 * confirmation. Reused by the list and the job page.
 */
export function DeleteJobButton({ job, onDelete, label, disabled }: { job: Job; onDelete: (o: DeleteOptions) => Promise<SendResult>; label?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [wt, setWt] = useState<{ path: string } | null>(null);
  const [alsoWorktree, setAlsoWorktree] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErr(null); setDirty(false); setWt(null); setAlsoWorktree(true);
    const ac = new AbortController();
    api<{ worktree: { path: string; state: string } | null }>(`/api/jobs/${job.id}`, ac.signal)
      .then((d) => { if (d.worktree && d.worktree.state !== "removed") setWt({ path: d.worktree.path }); })
      .catch(() => { /* without the worktree info the plain delete still works */ });
    return () => ac.abort();
  }, [open, job.id]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await onDelete({ removeWorktree: Boolean(wt) && alsoWorktree, discardChanges: dirty });
      if (r.ok) { setOpen(false); return; }
      if (r.code === "worktree-dirty") setDirty(true);
      setErr(r.error);
    } finally { setBusy(false); }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) setOpen(o); }}>
      <AlertDialogTrigger asChild><Button size="sm" variant="outline" disabled={disabled} aria-label={`delete ${job.key}`}><Trash2 />{label}</Button></AlertDialogTrigger>
      <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete {job.key} permanently?</AlertDialogTitle>
        <AlertDialogDescription>This removes the job, its history and its agent logs. It cannot be undone. The pull request and the ticket are not touched. To keep the history but hide the job, archive it instead.</AlertDialogDescription></AlertDialogHeader>
        {wt ? (
          <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <input type="checkbox" className="mt-0.5" checked={alsoWorktree} disabled={busy} onChange={(e) => setAlsoWorktree(e.target.checked)} />
            <span>Also delete its worktree and local branch<code className="mt-1 block break-all text-xs text-muted-foreground">{wt.path}</code>
              {!alsoWorktree ? <span className="mt-1 block text-xs text-muted-foreground">A job whose worktree is still on disk cannot be deleted. Leave this ticked, or archive the job.</span> : null}</span>
          </label>
        ) : null}
        {err ? <p role="alert" className="text-sm text-destructive">{err}{dirty ? " Deleting anyway discards those changes for good." : ""}</p> : null}
        <AlertDialogFooter><AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <Button variant={dirty ? "destructive" : "default"} disabled={busy || (Boolean(wt) && !alsoWorktree)} onClick={() => void confirm()}>{busy ? <Loader2 className="animate-spin" /> : null}{dirty ? "Discard changes and delete" : wt && alsoWorktree ? "Delete job and worktree" : "Delete"}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  );
}

/** `disabled`: actions are greyed out (an action is in flight, or the API is unreachable). */
export function JobsTable({ jobs, actions, disabled }: { jobs: Job[]; actions?: JobActions; disabled?: boolean }) {
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
            <TableCell>{stageLabel(j.stage)}{j.heldFromStage ? <small className="text-muted-foreground"> ← {stageLabel(j.heldFromStage)}</small> : null}</TableCell>
            <TableCell><StatusBadge status={j.status} /></TableCell>
            <TableCell className="text-muted-foreground">{ago(j.updatedAt)}</TableCell>
            <TableCell className={j.lastError ? "text-destructive" : "text-muted-foreground"}>{stageText((j.lastError || (j.prUrl ? "PR raised" : "")).split("\n")[0]!.slice(0, 90))}</TableCell>
            {actions ? (
              <TableCell onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {FINISHED.includes(j.status) ? (
                  <span className="flex justify-end gap-1">
                    <Button size="sm" variant="outline" disabled={disabled} aria-label={`${j.archivedAt ? "restore" : "archive"} ${j.key}`} title={j.archivedAt ? "Restore" : "Archive"} onClick={() => actions.archive(j, !j.archivedAt)}>{j.archivedAt ? <ArchiveRestore /> : <Archive />}</Button>
                    <DeleteJobButton job={j} disabled={disabled} onDelete={(o) => actions.remove(j, o)} />
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
