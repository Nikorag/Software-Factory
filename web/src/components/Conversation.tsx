import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, Terminal } from "lucide-react";
import { api } from "@/lib/api";
import { nextDelay } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

export type Turn =
  | { kind: "prompt"; text: string } | { kind: "session"; model?: string; tools?: number } | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: string } | { kind: "tool_result"; id: string; text: string; error: boolean }
  | { kind: "result"; ok: boolean; text: string; turns?: number } | { kind: "stderr" | "raw"; text: string };
interface Page { turns: Turn[]; offset: number; done: boolean; agent: string; model: string | null }

/** Collapsible block: long prompts and tool output stay out of the way until you want them. */
function Fold({ summary, children, open = false }: { summary: React.ReactNode; children: React.ReactNode; open?: boolean }) {
  const [o, setO] = useState(open);
  return (
    <div className="rounded-md border bg-muted/30">
      <button type="button" aria-expanded={o} onClick={() => setO(!o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", o && "rotate-90")} />{summary}
      </button>
      {o ? <div className="border-t px-3 py-2">{children}</div> : null}
    </div>
  );
}
const Pre = ({ children, className }: { children: string; className?: string }) => <pre className={cn("max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs", className)}>{children}</pre>;

/** One agent run's back-and-forth. Everything here is untrusted text (tickets, code, command output) and is only ever rendered as text. */
export function Conversation({ jobId, runId, running }: { jobId: string; runId: number; running: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [meta, setMeta] = useState<{ agent: string; model: string | null; done: boolean }>({ agent: "", model: null, done: !running });
  const [err, setErr] = useState<string | null>(null);
  const offset = useRef(0);
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
    const ctrl = new AbortController();
    offset.current = 0; setTurns([]); setErr(null);
    const tick = async () => {
      try {
        const p = await api<Page>(`/api/jobs/${encodeURIComponent(jobId)}/invocations/${runId}/conversation?after=${offset.current}`, ctrl.signal);
        if (!live) return;
        failures = 0; setErr(null);
        offset.current = p.offset;
        if (p.turns.length) setTurns((t) => [...t, ...p.turns]);
        setMeta({ agent: p.agent, model: p.model, done: p.done });
        if (!p.done) timer = setTimeout(() => void tick(), 1500);
      } catch (e) {
        if (!live) return;
        // a blip (service restart, the log not written yet) must not end a live view for good: keep retrying, backing off
        setErr((e as Error).message); failures++;
        timer = setTimeout(() => void tick(), nextDelay(1500, failures, 30_000));
      }
    };
    void tick();
    return () => { live = false; clearTimeout(timer); ctrl.abort(); };
  }, [jobId, runId]);

  useEffect(() => { if (stick.current) end.current?.scrollIntoView?.({ block: "end" }); }, [turns]);
  // tool results belong under the call that made them
  const results = new Map(turns.flatMap((t) => (t.kind === "tool_result" ? [[t.id, t] as const] : [])));

  return (
    <div className="grid gap-2" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <b className="text-foreground">{meta.agent || "agent run"}</b>{meta.model ? <span className="font-mono">{meta.model}</span> : null}
        {!meta.done ? <span className="flex items-center gap-1 text-run"><Loader2 className="size-3.5 animate-spin" />live</span> : <span>finished</span>}
      </div>
      {err ? <p role="alert" className="text-sm text-destructive">{turns.length ? "Lost the connection to this run" : "No conversation for this run yet"}: {err}. Retrying…</p> : null}
      {turns.map((t, i) => {
        switch (t.kind) {
          case "prompt": return <Fold key={i} summary={<span className="font-medium">Prompt sent to Claude</span>}><Pre>{t.text}</Pre></Fold>;
          case "session": return <div key={i} className="text-xs text-muted-foreground">Session started{t.model ? ` with ${t.model}` : ""}{t.tools != null ? ` · ${t.tools} tools` : ""}</div>;
          case "text": return <div key={i} className="whitespace-pre-wrap break-words rounded-md bg-card px-3 py-2 text-sm shadow-sm ring-1 ring-border">{t.text}</div>;
          case "tool": {
            const r = results.get(t.id);
            return (
              <Fold key={i} summary={<span className="flex min-w-0 items-center gap-2"><Terminal className="size-3.5 shrink-0" /><b>{t.name}</b><span className="truncate font-mono text-muted-foreground">{t.input.split("\n")[0]}</span>
                {r ? (r.error ? <span className="ml-auto text-destructive">error</span> : <span className="ml-auto text-ok">done</span>) : meta.done ? null : <Loader2 className="ml-auto size-3.5 animate-spin" />}</span>}>
                <div className="grid gap-2"><Pre>{t.input}</Pre>{r ? <Pre className={cn("rounded bg-background p-2", r.error && "text-destructive")}>{r.text || "(no output)"}</Pre> : <span className="text-xs text-muted-foreground">waiting for the result…</span>}</div>
              </Fold>
            );
          }
          case "tool_result": return null; // shown under its call
          case "result": return <div key={i} className={cn("whitespace-pre-wrap break-words rounded-md border px-3 py-2 text-sm", t.ok ? "border-ok/40" : "border-destructive/50 text-destructive")}><b>{t.ok ? "Finished" : "Failed"}{t.turns ? ` after ${t.turns} turn${t.turns === 1 ? "" : "s"}` : ""}.</b> {t.text}</div>;
          default: return <Pre key={i} className="text-muted-foreground">{t.text}</Pre>;
        }
      })}
      {turns.length === 0 && !err ? <p className="text-sm text-muted-foreground">Waiting for the first message…</p> : null}
      <div ref={end} />
    </div>
  );
}
