import type { Condition, Gate } from "./definition.js";

/** What a gate can look at. Everything here is data the engine recorded; a gate never runs anything. */
export interface GateContext {
  /** The stage's own output. */
  output: unknown;
  job: { remediationAttempts: number; stageAttempts: number; dryRun: boolean; autonomous: boolean; manual: boolean; kind: string };
  /** The latest recorded output of a stage in this job, by stage id. */
  outputOf: (stageId: string) => unknown;
  /** Whether a path exists inside the job's worktree (the engine contains it: no escaping via .. or symlinks). */
  exists: (relPath: string) => boolean;
}

export interface GateTrace { type: string; passed: boolean; detail: string; children?: GateTrace[] }
export interface GateResult { passed: boolean; trace: GateTrace }

const BLOCKING = ["critical", "blocker", "major", "high"];

const dig = (v: unknown, path: string[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), v);

/** Reads a condition's field: job.*, output.* or outputs.<STAGE>.*. */
function read(field: string, ctx: GateContext): unknown {
  const [root, ...rest] = field.split(".");
  if (root === "job") return (ctx.job as Record<string, unknown>)[rest[0]!];
  if (root === "output") return dig(ctx.output, rest);
  if (root === "outputs") return dig(ctx.outputOf(rest[0]!), rest.slice(1));
  return undefined;
}

export function evaluateCondition(c: Condition, ctx: GateContext): { held: boolean; detail: string } {
  const actual = read(c.field, ctx);
  const want = c.value;
  const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN);
  let held: boolean;
  switch (c.op) {
    case "exists": held = actual !== undefined && actual !== null; break;
    case "truthy": held = Boolean(actual) && !(Array.isArray(actual) && actual.length === 0); break;
    case "eq": held = actual === want || (actual !== undefined && want !== undefined && String(actual) === String(want)); break;
    case "neq": held = !(actual === want || (actual !== undefined && want !== undefined && String(actual) === String(want))); break;
    case "gt": held = num(actual) > num(want); break;
    case "gte": held = num(actual) >= num(want); break;
    case "lt": held = num(actual) < num(want); break;
    case "lte": held = num(actual) <= num(want); break;
    case "contains": held = Array.isArray(actual) ? actual.some((x) => String(x) === String(want)) : typeof actual === "string" && want !== undefined && actual.includes(String(want)); break;
  }
  return { held, detail: `${c.field} ${c.op}${want === undefined ? "" : ` ${JSON.stringify(want)}`} (was ${JSON.stringify(actual) ?? "missing"})` };
}

/**
 * Deterministic and auditable: the same output and context always give the same answer, and the trace says why. A gate is evaluated only
 * after the stage's own handler reported success, so a gate can make a stage stricter but never lets a failed one through.
 */
export function evaluateGate(g: Gate, ctx: GateContext): GateResult {
  const leaf = (passed: boolean, detail: string): GateResult => ({ passed, trace: { type: g.type, passed, detail } });
  const out = ctx.output as Record<string, unknown> | undefined;
  switch (g.type) {
    case "all": case "any": {
      const kids = g.of.map((x) => evaluateGate(x, ctx));
      const passed = g.type === "all" ? kids.every((k) => k.passed) : kids.some((k) => k.passed);
      return { passed, trace: { type: g.type, passed, detail: g.type === "all" ? "every condition must hold" : "at least one condition must hold", children: kids.map((k) => k.trace) } };
    }
    case "result_ok": return leaf(true, "the stage reported success");
    case "verdict_approved": {
      const v = out?.verdict;
      return leaf(v === "approve", `verdict was ${JSON.stringify(v) ?? "missing"}`);
    }
    case "no_blocking_findings": {
      const sev = new Set(g.severities ?? BLOCKING);
      const f = out?.findings;
      if (f !== undefined && !Array.isArray(f)) return leaf(false, "findings is not a list");
      const bad = ((f ?? []) as { severity?: string; id?: string }[]).filter((x) => x && sev.has(String(x.severity)));
      return leaf(bad.length === 0, bad.length ? `${bad.length} blocking finding(s): ${bad.slice(0, 5).map((x) => x.id ?? x.severity).join(", ")}` : "no blocking findings");
    }
    case "exit_code_zero": return leaf(out?.exitCode === 0, `exit code was ${JSON.stringify(out?.exitCode) ?? "missing"}`);
    case "tests_passed": {
      const results = Array.isArray(out?.results) ? (out!.results as { kind?: string; ok?: boolean }[]) : undefined;
      if (results) { const t = results.filter((r) => r.kind === "test"); return leaf(t.length > 0 && t.every((r) => r.ok), t.length ? `${t.filter((r) => r.ok).length}/${t.length} test run(s) passed` : "no test run recorded"); }
      return leaf(out?.exitCode === 0 && (out?.command === "test" || out?.testsPassed === true), out?.exitCode === 0 ? "the test command exited 0" : `exit code was ${JSON.stringify(out?.exitCode) ?? "missing"}`);
    }
    case "artifact_exists": { const ok = ctx.exists(g.path); return leaf(ok, `${g.path} ${ok ? "exists" : "does not exist"} in the worktree`); }
    case "fields_present": {
      const missing = g.fields.filter((f) => { const v = dig(ctx.output, f.split(".")); return v === undefined || v === null || v === ""; });
      return leaf(missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "all required fields are present");
    }
    case "condition": { const r = evaluateCondition(g.condition, ctx); return leaf(r.held, r.detail); }
  }
}

/** Nodes and depth of a gate, for the size limits. */
export function gateSize(g: Gate, depth = 1): { depth: number; nodes: number } {
  if (g.type !== "all" && g.type !== "any") return { depth, nodes: 1 };
  const kids = g.of.map((x) => gateSize(x, depth + 1));
  return { depth: Math.max(depth, ...kids.map((k) => k.depth)), nodes: 1 + kids.reduce((n, k) => n + k.nodes, 0) };
}
