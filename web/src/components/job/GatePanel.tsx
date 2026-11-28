import { useState } from "react";
import { Check, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { send } from "@/lib/api";
import type { JobDetail } from "@/lib/types";

/** Review what the gated step produced (today: the implementer's prompt and acceptance criteria), then confirm or ask for changes. */
export function GatePanel({ jobId, plan, locked, onDecided }: { jobId: string; plan: JobDetail["plan"]; locked: boolean; onDecided: () => Promise<void> | void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"confirm" | "return" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (what: "confirm" | "return") => {
    if (busy) return;
    setBusy(what); setErr(null);
    try {
      const res = await send("POST", `/api/jobs/${jobId}/gate/${what}`, what === "return" ? { note: note.trim() } : undefined);
      if (!res.ok) setErr(res.error); else { setNote(""); await onDecided(); }
    } finally { setBusy(null); }
  };
  return (
    <div className="grid gap-3">
      {plan ? (
        <div className="grid gap-2">
          <pre aria-label="Generated prompt" className="max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere border border-[var(--z-line)] bg-[#0a0a0a] p-3 font-sans text-[13px] leading-relaxed">{plan.prompt}</pre>
          <ul aria-label="Acceptance criteria" className="grid gap-1 text-sm">{plan.criteria.map((c) => <li key={c.id}><span className="z-label">{c.id}</span> {c.text}</li>)}</ul>
        </div>
      ) : null}
      <Textarea rows={3} aria-label="What should change" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Only needed to ask for changes: what should the prompt do differently? The step runs again with your note." />
      <div className="grid grid-cols-1 gap-2 sm:flex">
        <Button disabled={locked || busy !== null} onClick={() => void act("confirm")}>{busy === "confirm" ? <Loader2 className="animate-spin" /> : <Check />}Confirm</Button>
        <Button variant="outline" disabled={locked || busy !== null || !note.trim()} onClick={() => void act("return")}>{busy === "return" ? <Loader2 className="animate-spin" /> : <Undo2 />}Ask for changes</Button>
      </div>
      {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
    </div>
  );
}
