import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { send } from "@/lib/api";
import type { PermissionRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

const verb = (r: PermissionRequest) => (r.tool === "Read" ? "read" : r.tool === "Grep" ? "search" : "list files in");

/**
 * The agent asked for something outside its boundary (today: reading outside the worktree). Approve grants it for this job only,
 * read-only; deny tells the agent to carry on without it. Once nothing is left undecided the step resumes by itself.
 */
export function Approvals({ jobId, requests, locked, onDecided }: { jobId: string; requests: PermissionRequest[]; locked: boolean; onDecided: () => Promise<void> | void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (r: PermissionRequest, decision: "approve" | "deny") => {
    if (busy !== null) return;
    setBusy(r.id); setErr(null);
    try {
      const res = await send("POST", `/api/jobs/${jobId}/permissions/${r.id}`, { decision });
      if (!res.ok) setErr(res.error); else await onDecided();
    } finally { setBusy(null); }
  };
  return (
    <div className="grid gap-3">
      <ul className="grid border border-[var(--z-line)]" aria-label="Permission requests">
        {requests.map((r) => (
          <li key={r.id} className="grid gap-3 border-b border-[var(--z-line)] p-4 last:border-0 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="grid min-w-0 gap-1">
              <span className="z-label">{r.tool} · {r.stage.replaceAll("_", " ").toLowerCase()}</span>
              <span className="text-sm">The agent wants to {verb(r)} <code className="wrap-anywhere font-mono text-[13px] text-foreground">{r.path}</code></span>
              {r.status === "refused"
                ? <span className="text-xs text-[var(--z-fail)]">{r.reason ?? "This can never be granted."}</span>
                : <span className="text-xs text-muted-foreground">Approving lets this job's agents read {r.folder ? <>everything in <code className="wrap-anywhere font-mono">{r.grant}</code></> : <>this file</>}. Read-only: they still cannot change anything there.</span>}
            </div>
            {r.status === "pending" ? (
              <div className="grid grid-cols-2 gap-2 md:flex">
                <Button disabled={locked || busy !== null} aria-label={`Approve: ${verb(r)} ${r.path}`} onClick={() => void decide(r, "approve")}>{busy === r.id ? <Loader2 className="animate-spin" /> : <Check />}Approve</Button>
                <Button variant="outline" disabled={locked || busy !== null} aria-label={`Deny: ${verb(r)} ${r.path}`} onClick={() => void decide(r, "deny")}><X />Deny</Button>
              </div>
            ) : (
              <span className={cn("z-label", r.status === "approved" ? "text-[var(--z-acc)]" : r.status === "refused" ? "text-[var(--z-fail)]" : "")}>{r.status === "refused" ? "Not allowed" : r.status}</span>
            )}
          </li>
        ))}
      </ul>
      {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
    </div>
  );
}
