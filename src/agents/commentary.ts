import { redactSecrets } from "../implement/secrets.js";

/** Longest commentary stored (a few lines). The API clips stored output at 1500 characters, so this stays well inside it. */
export const COMMENTARY_MAX = 400;

/**
 * A short plain-language account of what an agent did: the agent's own `summary` when its schema has one, else its reply text.
 * Whitespace collapsed, secrets redacted, clipped to COMMENTARY_MAX. Undefined when there is nothing to say.
 */
export function commentaryOf(result: { text?: string }, data?: unknown): string | undefined {
  const own = data && typeof data === "object" && typeof (data as { summary?: unknown }).summary === "string" ? (data as { summary: string }).summary : "";
  const text = result.text?.trim().startsWith("{") ? "" : (result.text ?? ""); // a raw JSON reply is not commentary
  // Redact before clipping so a credential cut in half is not left readable.
  const s = redactSecrets(own.trim() ? own : text).replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > COMMENTARY_MAX ? `${s.slice(0, COMMENTARY_MAX - 1).trimEnd()}…` : s;
}

/** Latest commentary per stage execution, handed from `agent()` to `withCommentary()`. */
const pending = new Map<number, string>();
export const noteCommentary = (executionId: number, c: string | undefined): void => { if (c) pending.set(executionId, c); };

type Handler = (ctx: { executionId: number }) => Promise<{ kind: string; output?: unknown }>;

/** Adds `commentary` (first, so a clipped copy of the output still has it) to a successful stage's object output. */
export function withCommentary<H extends Record<string, unknown>>(handlers: H): H {
  const out: Record<string, unknown> = {};
  for (const [stage, h] of Object.entries(handlers)) {
    const run = h as Handler;
    out[stage] = async (ctx: { executionId: number }) => {
      try {
        const r = await run(ctx);
        const c = pending.get(ctx.executionId);
        const o = r.output;
        if (r.kind === "ok" && c && o && typeof o === "object" && !Array.isArray(o) && !("commentary" in o)) return { ...r, output: { commentary: c, ...o } };
        return r;
      } finally { pending.delete(ctx.executionId); }
    };
  }
  return out as H;
}
