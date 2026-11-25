/** Small, pure helpers for the Claude-Code-style session view (status bar and transcript). */

/** "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-5-5[1m]" -> "Sonnet 5.5 (1M)", "opus" -> "Opus". Unknown names are shown as they are. */
export function prettyModel(model: string | null | undefined): string {
  if (!model) return "Claude";
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-(\d+)(?:-(\d+))?)?(?:-\d{8})?(\[1m\])?$/i.exec(model.trim());
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase();
  return `${family}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ""}` : ""}${m[4] ? " (1M)" : ""}`;
}

/**
 * The context window a model id implies. The factory does not record the window, so this is an estimate: the 1M variant when the id says
 * `[1m]`, otherwise the standard 200k. It only drives the "ctx %" figure in the status bar.
 */
export const contextWindow = (model: string | null | undefined): number => (model && /\[1m\]/i.test(model) ? 1_000_000 : 200_000);

/** Percent of the context window in use, clamped to 0..100. */
export const contextPercent = (tokens: number, model: string | null | undefined): number => Math.max(0, Math.min(100, Math.round((tokens / contextWindow(model)) * 100)));

/** 84_213 -> "84k", 1_250_000 -> "1.3M". */
export const tokensShort = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** /Users/jamie/.software-factory/workspaces/x/JAM-1 -> ~/.software-factory/workspaces/x/JAM-1 (and the middle is elided when it is long). */
export function shortPath(path: string | null | undefined, max = 46): string {
  if (!path) return "";
  const p = path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  if (p.length <= max) return p;
  const parts = p.split("/");
  return parts.length > 3 ? `${parts[0]}/…/${parts.slice(-2).join("/")}` : `…${p.slice(-(max - 1))}`;
}

/** The first line of a tool result, with how many more lines there are: what Claude Code shows under a tool call. */
export function resultPreview(text: string): { first: string; more: number } {
  const lines = text.replace(/\s+$/, "").split("\n");
  return { first: lines[0] ?? "", more: Math.max(0, lines.length - 1) };
}
