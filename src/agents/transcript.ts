import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { redactSecrets } from "../implement/secrets.js";

export type Turn =
  | { kind: "prompt"; text: string }
  | { kind: "session"; model?: string; tools?: number }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: string }
  | { kind: "tool_result"; id: string; text: string; error: boolean }
  | { kind: "result"; ok: boolean; text: string; turns?: number }
  | { kind: "stderr" | "raw"; text: string };

const MAX_FIELD = 4000;
const clip = (s: string, n = MAX_FIELD) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const safe = (s: string, n?: number) => clip(redactSecrets(s), n);

function summariseInput(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  if (name === "Bash") return pick("command") ?? "";
  if (["Read", "Write", "Edit", "NotebookEdit"].includes(name)) return pick("file_path") ?? pick("notebook_path") ?? "";
  if (name === "Grep" || name === "Glob") return [pick("pattern"), pick("path")].filter(Boolean).join("  in  ");
  return JSON.stringify(i);
}
const asText = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("") : "");

/** One log line -> zero or more display turns. Pure. Anything credential-shaped is redacted and long fields are clipped. */
export function parseLine(line: string): Turn[] {
  if (!line.trim()) return [];
  if (line.startsWith("[stderr] ")) return [{ kind: "stderr", text: safe(line.slice(9)) }];
  let o: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { o = JSON.parse(line); } catch { return [{ kind: "raw", text: safe(line, 500) }]; }
  switch (o.type) {
    case "factory_prompt": return [{ kind: "prompt", text: safe(String(o.text ?? ""), 20_000) }];
    case "system": return o.subtype === "init" ? [{ kind: "session", model: o.model, tools: Array.isArray(o.tools) ? o.tools.length : undefined }] : [];
    case "assistant": return (o.message?.content ?? []).flatMap((b: Record<string, any>): Turn[] => // eslint-disable-line @typescript-eslint/no-explicit-any
      b.type === "text" && b.text ? [{ kind: "text", text: safe(String(b.text)) }]
      : b.type === "tool_use" ? [{ kind: "tool", id: String(b.id), name: String(b.name), input: safe(summariseInput(String(b.name), b.input), 1500) }] : []);
    case "user": return (Array.isArray(o.message?.content) ? o.message.content : []).flatMap((b: Record<string, any>): Turn[] => // eslint-disable-line @typescript-eslint/no-explicit-any
      b.type === "tool_result" ? [{ kind: "tool_result", id: String(b.tool_use_id), text: safe(asText(b.content)), error: Boolean(b.is_error) }] : []);
    case "result": return [{ kind: "result", ok: !o.is_error && o.subtype === "success", text: safe(String(o.result ?? o.subtype ?? "")), turns: o.num_turns }];
    default: return []; // rate_limit_event, hooks, partial messages...
  }
}

/**
 * Reads a run's log from byte `after`, returning the turns in the complete lines since then and the offset to resume from.
 * Only files under <dataDir>/logs are readable (no path traversal, no symlink escapes). A partial last line waits for the next call.
 * At most `maxBytes` are read per call, and every call makes progress: a single line longer than that (a huge tool result) is skipped
 * with a note, and a read that starts in the middle of a line (the rest of a skipped one) drops that fragment. `more` says the window was
 * full, so there is more to read right now.
 */
export function readConversation(dataDir: string, path: string, after: number, maxBytes = 1_000_000): { turns: Turn[]; offset: number; size: number; more: boolean } | null {
  try {
    const root = realpathSync(join(dataDir, "logs"));
    const real = realpathSync(resolve(path));
    if (real !== root && !real.startsWith(root + sep)) return null;
    const size = statSync(real).size;
    const start = Math.min(Math.max(0, after), size);
    const len = Math.min(size - start, maxBytes);
    // one byte before `start` tells us whether we are at the beginning of a line
    const lead = start > 0 ? 1 : 0;
    const raw = Buffer.alloc(len + lead);
    const fd = openSync(real, "r");
    try { readSync(fd, raw, 0, len + lead, start - lead); } finally { closeSync(fd); }
    const midLine = lead === 1 && raw[0] !== 0x0a;
    const buf = raw.subarray(lead);
    const full = len === maxBytes && start + len < size;
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) {
      // no line ends in this window. If the window is full the line is too long to show: skip past it (noting it once, at its start).
      if (!full) return { turns: [], offset: start, size, more: false }; // a line still being written: wait for it
      return { turns: midLine ? [] : [{ kind: "raw", text: `(a log line over ${maxBytes} bytes was too long to show and was skipped)` }], offset: start + len, size, more: true };
    }
    // a final line without a newline is still being written, unless it is the end of a finished file (the caller knows `done`)
    let complete = buf.subarray(0, lastNl + 1);
    if (midLine) complete = complete.subarray(complete.indexOf(0x0a) + 1); // the tail of a line skipped by the previous call
    return { turns: complete.toString("utf8").split("\n").flatMap(parseLine), offset: start + lastNl + 1, size, more: start + lastNl + 1 < size && full };
  } catch { return null; }
}
