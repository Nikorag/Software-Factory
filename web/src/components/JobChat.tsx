import { useEffect, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, send } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Msg { role: "user" | "assistant"; text: string; error?: boolean }
const SUGGESTIONS = ["Why did this job fail?", "What is it waiting on?", "Summarise what the factory did so far."];
const MAX_HISTORY = 20;

const POLL_MS = 1500, GIVE_UP_MS = 4 * 60_000;
/** Starts the question and polls for the answer: it can take minutes, and a request through the hub must finish in seconds. */
async function answer(jobId: string, message: string, history: { role: string; text: string }[]): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const base = `/api/jobs/${encodeURIComponent(jobId)}/chat`;
  const started = await send<{ id: string }>("POST", base, { message, history });
  if (!started.ok) return { ok: false, error: started.error };
  const deadline = Date.now() + GIVE_UP_MS;
  let misses = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const c = await api<{ status: "running" | "done" | "error"; reply?: string; error?: string }>(`${base}/${started.data.id}`);
      misses = 0;
      if (c.status === "done") return { ok: true, text: c.reply ?? "" };
      if (c.status === "error") return { ok: false, error: c.error ?? "the assistant could not answer" };
    } catch (e) {
      if (++misses >= 5) return { ok: false, error: (e as Error).message }; // a blip is fine; losing the connection for good is not
    }
  }
  return { ok: false, error: "Claude is taking too long. Try again." };
}

/**
 * Ask Claude about one job ("why did this one fail?"). The conversation lives in this component only: the server is stateless and is sent
 * the transcript each time, so nothing about the chat is stored. Replies are plain text (React escapes them; no markup is ever injected).
 */
export function JobChat({ jobId }: { jobId: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { setMsgs([]); setInput(""); }, [jobId]); // a different job is a different conversation
  // Keep the newest message in view by scrolling the message box itself: scrollIntoView would also scroll the page (on load, to here).
  useEffect(() => { const el = box.current; if (el && (msgs.length || busy)) el.scrollTop = el.scrollHeight; }, [msgs, busy]);

  const ask = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    const history = msgs.filter((m) => !m.error).slice(-MAX_HISTORY).map(({ role, text }) => ({ role, text }));
    setMsgs((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    const reply = await answer(jobId, message, history);
    setBusy(false);
    setMsgs((m) => [...m, reply.ok ? { role: "assistant", text: reply.text } : { role: "assistant", text: reply.error, error: true }]);
  };

  return (
    <Card><CardContent className="grid gap-3">
      <p className="text-xs text-muted-foreground">Ask Claude about this job. It reads the job's stages, decisions and recent agent output, and can't change anything.</p>
      <div ref={box} className="grid max-h-[480px] gap-2 overflow-y-auto" aria-live="polite">
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => <Button key={s} variant="outline" size="sm" onClick={() => void ask(s)} disabled={busy}>{s}</Button>)}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn("max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px]", m.role === "user" ? "ml-auto bg-secondary" : m.error ? "border border-destructive/50 text-destructive" : "border")}>{m.text}</div>
        ))}
        {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Thinking…</div>}
      </div>
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <Textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} maxLength={4000} placeholder="Why did this one fail?" aria-label="Message"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
        <Button type="submit" disabled={busy || !input.trim()} aria-label="Send"><Send className="size-4" /></Button>
      </form>
    </CardContent></Card>
  );
}
