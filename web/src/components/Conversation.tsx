import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { api } from "@/lib/api";
import { dur } from "@/lib/format";
import { contextPercent, contextWindow, prettyModel, resultPreview, shortPath, tokensShort } from "@/lib/session";
import { nextDelay } from "@/hooks/usePoll";
import { cn } from "@/lib/utils";

export type Turn =
  | { kind: "prompt"; text: string } | { kind: "session"; model?: string; tools?: number } | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: string } | { kind: "tool_result"; id: string; text: string; error: boolean }
  | { kind: "result"; ok: boolean; text: string; turns?: number } | { kind: "usage"; tokens: number } | { kind: "stderr" | "raw"; text: string };
interface Page { turns: Turn[]; offset: number; done: boolean; agent: string; model: string | null; cwd?: string | null; startedAt?: number | null; durationMs?: number | null }

/** The terminal look is the same in light and dark mode: it is meant to read like a Claude Code session. */
export const TERM = { bg: "bg-[#1a1b1e]", text: "text-[#dcdcdc]", dim: "text-[#8b8f97]", line: "border-[#34363b]", coral: "text-[#d97757]", ok: "text-[#7fbf7f]", err: "text-[#e5737e]" };
const SPIN = ["✻", "✽", "✶", "✳", "✢", "·"];

/** Ticks once a second while `on`, so a live run's clock and spinner move. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [on]);
  return now;
}

/** A powerline segment: a coloured block with an arrow into the next one. */
function Seg({ bg, fg, z, first, children, title }: { bg: string; fg: string; z: number; first?: boolean; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("relative flex h-6 shrink-0 items-center whitespace-nowrap text-xs", first ? "rounded-l-full pl-3" : "pl-4")} style={{ background: bg, color: fg, zIndex: z, paddingRight: 6 }}>
      {children}
      <i aria-hidden className="absolute left-full top-0 h-0 w-0 border-y-[12px] border-l-[10px] border-y-transparent" style={{ borderLeftColor: bg }} />
    </span>
  );
}

/** Collapsible tool output: the first line, "… +N lines" to expand, like Claude Code. */
function Output({ text, error }: { text: string; error: boolean }) {
  const [open, setOpen] = useState(false);
  const { first, more } = resultPreview(text);
  return (
    <div className={cn("flex gap-2 pl-5", error ? TERM.err : TERM.dim)}>
      <span aria-hidden>⎿</span>
      <div className="min-w-0 flex-1">
        {open ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono">{text || "(no output)"}</pre> : <span className="block truncate">{first || "(no output)"}</span>}
        {more > 0 || open ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="underline-offset-2 hover:underline">{open ? "show less" : `… +${more} line${more === 1 ? "" : "s"} (click to expand)`}</button> : null}
      </div>
    </div>
  );
}

/** The prompt the factory sent, drawn like a user message: a highlighted block, folded to a few lines. */
function Prompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const shown = open ? lines : lines.slice(0, 2);
  return (
    <div className="bg-[#2a2c31] px-3 py-2">
      <div className="flex gap-2"><span aria-hidden className={TERM.dim}>❯</span><div className="min-w-0 flex-1 whitespace-pre-wrap break-words"><b>Prompt sent to Claude</b>{"\n"}{shown.join("\n")}</div></div>
      {lines.length > 2 || open ? <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cn("ml-5 mt-1 underline-offset-2 hover:underline", TERM.dim)}>{open ? "show less" : `… +${lines.length - 2} lines (click to expand)`}</button> : null}
    </div>
  );
}

/**
 * One agent run's back-and-forth, drawn like a Claude Code session with its status bar. Everything here is untrusted text (tickets, code,
 * command output) and is only ever rendered as text. `ctx` is what the job page already knows: the ticket key and the worktree's branch.
 */
export function Conversation({ jobId, runId, running, ctx }: { jobId: string; runId: number; running: boolean; ctx?: { key?: string; branch?: string | null } }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [meta, setMeta] = useState<Omit<Page, "turns" | "offset">>({ agent: "", model: null, done: !running });
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
        setMeta({ agent: p.agent, model: p.model, done: p.done, cwd: p.cwd, startedAt: p.startedAt, durationMs: p.durationMs });
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

  const liveNow = !meta.done;
  const now = useNow(liveNow);
  const results = useMemo(() => new Map(turns.flatMap((t) => (t.kind === "tool_result" ? [[t.id, t] as const] : []))), [turns]);
  const stats = useMemo(() => {
    let tokens = 0, calls = 0, model: string | undefined;
    for (const t of turns) { if (t.kind === "usage") tokens = t.tokens; else if (t.kind === "tool") calls++; else if (t.kind === "session" && t.model) model = t.model; }
    return { tokens, calls, model };
  }, [turns]);
  const model = stats.model ?? meta.model;
  const pct = stats.tokens ? contextPercent(stats.tokens, model) : null;
  const elapsed = liveNow ? (meta.startedAt ? Math.max(0, now - meta.startedAt) : 0) : (meta.durationMs ?? 0);
  const role = meta.agent.split("/")[1] ?? meta.agent;
  const spin = SPIN[Math.floor(now / 1000) % SPIN.length]!;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col font-mono text-[13px] leading-relaxed", TERM.bg, TERM.text)}>
      <div className={cn("flex items-center gap-2 border-b px-4 py-2 pr-12 text-xs", TERM.line)}>
        <span className={cn("font-semibold", TERM.coral)}>✻</span><b>Claude Code</b><span className={cn("truncate", TERM.dim)}>{shortPath(meta.cwd) || "agent run"}</span>
        <span className="ml-auto shrink-0">{liveNow ? <span className={TERM.coral}>● live</span> : <span className={TERM.dim}>finished</span>}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        <div className="grid gap-2.5">
          {err ? <p role="alert" className={TERM.err}>{turns.length ? "Lost the connection to this run" : "No conversation for this run yet"}: {err}. Retrying…</p> : null}
          {turns.map((t, i) => {
            switch (t.kind) {
              case "prompt": return <Prompt key={i} text={t.text} />;
              case "session": return <div key={i} className={TERM.dim}>Session started{t.model ? ` with ${t.model}` : ""}{t.tools != null ? ` · ${t.tools} tools` : ""}</div>;
              case "text": return <div key={i} className="flex gap-2"><span aria-hidden>⏺</span><div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{t.text}</div></div>;
              case "tool": {
                const r = results.get(t.id);
                const [first] = t.input.split("\n");
                return (
                  <div key={i} className="grid gap-0.5">
                    <div className="flex gap-2">
                      <span aria-hidden className={r ? (r.error ? TERM.err : TERM.ok) : TERM.dim}>⏺</span>
                      <div className="min-w-0 flex-1 truncate"><b>{t.name}</b><span className={TERM.dim}>({first})</span></div>
                    </div>
                    {r ? <Output text={r.text} error={r.error} /> : <div className={cn("pl-5", TERM.dim)}>⎿ {meta.done ? "(no result recorded)" : "Running…"}</div>}
                  </div>
                );
              }
              case "tool_result": case "usage": return null; // shown under its call / in the status bar
              case "result": return (
                <div key={i} className={cn("whitespace-pre-wrap break-words", t.ok ? TERM.dim : TERM.err)}>
                  <div>{t.ok ? "✻ Finished" : "✗ Failed"}{t.turns ? ` after ${t.turns} turns` : ""}</div>{t.text ? <div className="pl-4">{t.text}</div> : null}
                </div>
              );
              default: return <pre key={i} className={cn("whitespace-pre-wrap break-words", TERM.dim)}>{t.text}</pre>;
            }
          })}
          {turns.length === 0 && !err ? <p className={TERM.dim}>Waiting for the first message…</p> : null}
          {liveNow ? <div className={TERM.coral}>{spin} Working… <span className={TERM.dim}>({dur(elapsed) || "0s"}{stats.tokens ? ` · ↓ ${tokensShort(stats.tokens)} tokens` : ""})</span></div> : null}
          <div ref={end} />
        </div>
      </div>

      <div className={cn("border-t", TERM.line)}>
        <div className="flex items-center overflow-hidden px-2 pt-2" role="status" aria-label="run status">
          <Seg first z={9} bg="#d9622b" fg="#ffffff">{ctx?.key ?? "run"}</Seg>
          <Seg z={8} bg="#2b2d31" fg="#e8e8e8">{role || "agent"}</Seg>
          {meta.cwd ? <Seg z={7} bg="#c98a3a" fg="#1a1b1e" title={meta.cwd}>{shortPath(meta.cwd, 34)}</Seg> : null}
          {ctx?.branch ? <Seg z={6} bg="#2f8f8f" fg="#ffffff" title={ctx.branch}><GitBranch className="mr-1 size-3" />{ctx.branch.length > 24 ? `${ctx.branch.slice(0, 23)}…` : ctx.branch}</Seg> : null}
          <Seg z={5} bg="#3a7f95" fg="#ffffff" title={model ?? undefined}>{prettyModel(model)}</Seg>
          <Seg z={4} bg="#4f6fb0" fg="#ffffff">{stats.calls} tool call{stats.calls === 1 ? "" : "s"}</Seg>
          {pct !== null ? <><Seg z={3} bg="#c9a227" fg="#1a1b1e" title={`${stats.tokens.toLocaleString()} tokens in the context (estimated against a ${tokensShort(contextWindow(model))} window)`}>◔ {pct}%</Seg><Seg z={2} bg="#8a9a2a" fg="#1a1b1e">{100 - pct}% left</Seg></> : null}
          <Seg z={1} bg="#2b2d31" fg="#e8e8e8">◷ {dur(elapsed) || "0s"}</Seg>
        </div>
        <div className={cn("px-4 pb-2 pt-1 text-xs", TERM.dim)}><span className={TERM.coral}>⏵⏵</span> {liveNow ? "watching live" : "finished"} · read-only view of this run</div>
      </div>
    </div>
  );
}
