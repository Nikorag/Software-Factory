import { useState } from "react";
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, MessageSquareText, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { post } from "@/lib/api";
import { ago, safeUrl } from "@/lib/format";
import type { Feedback } from "@/lib/types";
import { cn } from "@/lib/utils";

/** What a request's status means, in words (never colour alone). */
function state(f: Feedback): { label: string; tone: string; Icon: typeof CheckCircle2; detail?: string } {
  if (f.status === "pending") return { label: "Queued", tone: "text-muted-foreground", Icon: CircleDashed, detail: "Picked up at the factory's next check of the pull request." };
  if (f.status === "applying") return { label: "Working on it", tone: "text-run", Icon: Loader2 };
  if (f.status === "ignored") return { label: "Not applied", tone: "text-muted-foreground", Icon: XCircle, detail: f.note ?? undefined };
  const note = f.note ?? "Done";
  if (note.startsWith("Not changed: ")) return { label: "Declined", tone: "text-loop", Icon: XCircle, detail: note.slice("Not changed: ".length) };
  if (note.startsWith("Left for a human: ")) return { label: "Left for you", tone: "text-loop", Icon: XCircle, detail: note.slice("Left for a human: ".length) };
  return { label: "Done, pushed to the PR", tone: "text-ok", Icon: CheckCircle2 };
}

/**
 * Ask for changes to a job's open pull request. The request is applied by a fix pass, re-tested and re-reviewed, then pushed to the
 * same PR. The same thing can be asked from the PR itself with a comment that starts with /software-factory.
 */
export function RequestChanges({ jobId, feedback, open, github, locked, onSent }: { jobId: string; feedback: Feedback[]; open: boolean; github: boolean; locked: boolean; onSent: () => Promise<void> | void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setErr(null); setSent(false);
    try {
      const e = await post(`/api/jobs/${jobId}/feedback`, { text });
      if (e) setErr(e); else { setText(""); setSent(true); await onSent(); }
    } finally { setBusy(false); }
  };
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><MessageSquareText className="size-4 text-muted-foreground" aria-hidden />Request changes</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        {open ? (
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <label htmlFor="request-changes" className="text-xs text-muted-foreground">
              Describe what to change on the pull request. The factory makes the change, re-runs the checks and reviews, and pushes it to the same PR. It does not use up a fix cycle.
            </label>
            <Textarea id="request-changes" rows={4} maxLength={8000} value={text} disabled={busy} onChange={(e) => { setText(e.target.value); setSent(false); }}
              placeholder="e.g. Rename isOverdue to isPastDue and add a test for a missing due date" aria-invalid={err ? true : undefined} aria-describedby={err ? "request-changes-error" : github ? "request-changes-hint" : undefined} />
            {err ? <p id="request-changes-error" role="alert" className="text-sm text-destructive">{err}</p> : null}
            {sent ? <p role="status" className="text-sm text-ok">Sent. The factory will pick it up at its next check.</p> : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button type="submit" disabled={busy || locked || !text.trim()} className="max-md:w-full">{busy ? <Loader2 className="animate-spin" /> : <Send />}Send to the factory</Button>
              {github ? <p id="request-changes-hint" className="text-xs text-muted-foreground">Or comment on the GitHub PR starting with <code className="rounded bg-muted px-1 py-0.5 font-mono">/software-factory</code> (repository collaborators only).</p> : null}
            </div>
          </form>
        ) : null}
        {feedback.length ? (
          <ol className="grid gap-2" aria-label="Change requests">
            {[...feedback].reverse().map((f) => {
              const s = state(f), url = safeUrl(f.url);
              return (
                <li key={f.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className={cn("inline-flex items-center gap-1 font-medium", s.tone)}><s.Icon className={cn("size-3.5", f.status === "applying" && "anim animate-spin")} aria-hidden />{s.label}</span>
                    <span aria-hidden className="max-md:hidden">·</span>
                    <span>{f.source === "github" ? `@${f.author} on the PR` : "from this page"}</span>
                    {f.path ? <><span aria-hidden className="max-md:hidden">·</span><code className="break-all font-mono">{f.path}{f.line ? `:${f.line}` : ""}</code></> : null}
                    {f.at ? <><span aria-hidden className="max-md:hidden">·</span><span>{ago(f.at)}</span></> : null}
                    {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 hover:underline max-md:min-h-11">comment<ExternalLink className="size-3" aria-hidden /></a> : null}
                  </div>
                  <p className="whitespace-pre-wrap break-words">{f.body}</p>
                  {s.detail ? <p className="text-xs text-muted-foreground">{s.detail}</p> : null}
                </li>
              );
            })}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}
