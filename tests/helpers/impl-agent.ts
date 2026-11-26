import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, AgentRequest, AgentResult } from "../../src/agents/types.js";

type S = Record<string, unknown>;
export interface ImplBehaviour {
  /** What the implementer does to the worktree on each implement pass (n starts at 1). */
  implement: (cwd: string, featureDir: string, n: number, req: AgentRequest) => void;
  remediate: (cwd: string, featureDir: string, n: number, req: AgentRequest) => void;
  converge: (n: number) => S;
  classify: () => S; codeReview: (n: number) => S; security: () => S; claudeReview: (n: number) => S; finalReview: (n: number) => S;
  remediation: () => S;
  /** haiku_prompt mode: the prompt writer's answer. */
  plan?: () => S;
  /** What the implementer does when asked to resolve merge conflicts (default: keeps both sides of every conflict and commits the merge). */
  conflict?: (cwd: string, req: AgentRequest) => S;
  /** The implementer's structured answer on each implement pass (default: T001 done, nothing skipped or deferred). */
  implementResult?: (n: number) => S;
  failure?: (req: AgentRequest) => Partial<AgentResult> | undefined;
}

export const write = (cwd: string, rel: string, content: string) => { const p = join(cwd, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
export const tickTasks = (cwd: string, dir: string) => {
  const p = join(cwd, dir, "tasks.md");
  if (!existsSync(p)) return; // haiku_prompt mode has no task list
  writeFileSync(p, readFileSync(p, "utf8").replace(/- \[ \] (T\d{3})/g, "- [x] $1"));
};
/** Leaves (or puts back) a task unticked, optionally with a marker such as `[HUMAN]` after its id. */
export const untick = (cwd: string, dir: string, id: string, tag = "") => {
  const p = join(cwd, dir, "tasks.md");
  writeFileSync(p, readFileSync(p, "utf8").replace(new RegExp(`- \\[[ xX]\\] ${id}\\b`), `- [ ] ${id}${tag ? ` ${tag}` : ""}`));
};
/** Resolves every conflicted file by keeping both sides (dropping the markers) and concludes the merge, as a careful agent would for independent additions. */
export const keepBothSides = (cwd: string): S => {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const files = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  for (const f of files) writeFileSync(join(cwd, f), readFileSync(join(cwd, f), "utf8").split("\n").filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join("\n"));
  git("add", "-A"); git("commit", "--no-edit");
  return { resolved: true, files: files.map((path) => ({ path, resolution: "kept both sides" })), ambiguity: "", summary: "combined both sides" };
};
export const GOOD_SRC = 'export function isOverdue(due, today) { return due < today; }\n';
export const GOOD_TEST = 'import test from "node:test";\nimport assert from "node:assert";\nimport { isOverdue } from "../src/due.js";\ntest("a past date is overdue", () => assert.equal(isOverdue("2020-01-01", "2026-01-01"), true));\ntest("today is not overdue", () => assert.equal(isOverdue("2026-01-01", "2026-01-01"), false));\n';

export const defaults = (): ImplBehaviour => ({
  implement: (cwd, dir) => { write(cwd, "src/due.js", GOOD_SRC); write(cwd, "test/due.test.js", GOOD_TEST); tickTasks(cwd, dir); },
  remediate: () => {},
  converge: () => ({ converged: true, appendedTasks: 0, summary: "all tasks satisfied" }),
  classify: () => ({ summary: "ok", failingTests: [] }),
  codeReview: () => ({ verdict: "approve", findings: [] }),
  security: () => ({ findings: [] }),
  claudeReview: () => ({ verdict: "approve", findings: [], earlier: [] }),
  finalReview: () => ({ verdict: "approve", criteria: [{ id: "FR-001", met: true, evidence: "src/due.js:1, test/due.test.js:4" }], findings: [] }),
  remediation: () => ({ accepted: [], rejected: [], summary: "fixed" }),
});

/** Plays Claude Code / Haiku for the implementation stages: real file edits in the worktree, structured output elsewhere. */
export class ImplAgent implements Agent {
  calls: AgentRequest[] = [];
  private n = { implement: 0, remediate: 0, converge: 0, code: 0, claude: 0, final: 0 };
  constructor(readonly provider: "anthropic" | "local", public b: ImplBehaviour = defaults()) {}

  private ok(over: Partial<AgentResult> = {}): AgentResult { return { ok: true, text: "ok", denials: [], exitCode: 0, durationMs: 1, sessionId: "sess-impl", ...over }; }
  private featureDir(req: AgentRequest): string { return /SPECIFY_FEATURE_DIRECTORY=(\S+)/.exec(req.prompt)?.[1] ?? /under (specs\/\S+)\//.exec(req.prompt)?.[1] ?? /(specs\/[a-z0-9-]+)\//.exec(req.prompt)?.[1] ?? ""; }

  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const fail = this.b.failure?.(req);
    if (fail) return { ok: false, text: "", denials: [], exitCode: 1, durationMs: 1, ...fail };
    const props = (req.jsonSchema?.properties ?? {}) as Record<string, unknown>;
    const dir = this.featureDir(req);
    let s: S;
    if ("acceptanceCriteria" in props) s = this.b.plan?.() ?? { verdict: "ready", questions: [], prompt: "Add isOverdue(due, today) to src/due.js, following the existing module style, with node:test tests.", acceptanceCriteria: ["isOverdue is true for a past date", "isOverdue is false for today"] };
    else if ("resolved" in props) s = this.b.conflict ? this.b.conflict(req.cwd, req) : keepBothSides(req.cwd);
    else if ("deferred" in props && !("accepted" in props) && !("tasksDone" in props) && !("converged" in props)) { this.b.implement(req.cwd, "", ++this.n.implement, req); s = this.b.implementResult?.(this.n.implement) ?? { summary: "implemented", deferred: [] }; }
    else if ("tasksDone" in props) { this.b.implement(req.cwd, dir, ++this.n.implement, req); s = this.b.implementResult?.(this.n.implement) ?? { summary: "implemented", tasksDone: ["T001"], tasksSkipped: [], deferred: [] }; }
    else if ("converged" in props) s = this.b.converge(++this.n.converge);
    else if ("failingTests" in props) s = this.b.classify();
    else if (JSON.stringify(req.jsonSchema ?? {}).includes('"exploit"')) s = this.b.security();
    else if ("earlier" in props) s = this.b.claudeReview(++this.n.claude);
    else if ("criteria" in props) s = this.b.finalReview(++this.n.final);
    else if ("accepted" in props) { this.b.remediate(req.cwd, dir, ++this.n.remediate, req); s = this.b.remediation(); }
    else if ("verdict" in props && "findings" in props) s = this.b.codeReview(++this.n.code);
    else return this.ok();
    return this.ok({ structured: s, text: JSON.stringify(s) });
  }
}
