import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, AgentRequest, AgentResult } from "../../src/agents/types.js";

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "speckit", "todo-due-dates");
export const fixture = (rel: string) => readFileSync(join(FIXTURE, rel), "utf8");

const STEP_FILES: Record<string, string[]> = {
  specify: ["spec.md", "checklists/requirements.md"],
  clarify: [],
  plan: ["plan.md", "research.md", "data-model.md", "contracts/todo-module.md", "quickstart.md"],
  tasks: ["tasks.md"],
};

export type Structured = Record<string, unknown>;
export interface Behaviour {
  analysis: () => Structured; classification: () => Structured; review: () => Structured; analyze: () => Structured; remediation: (req: AgentRequest) => Structured;
  /** Called after the default file writing for a skill step; may add/overwrite files or return a failure. */
  onStep?: (step: string, req: AgentRequest, featureDir: string) => Partial<AgentResult> | void;
  onRemediate?: (req: AgentRequest, featureDir: string) => void;
}

export const defaults = (): Behaviour => ({
  analysis: () => ({ verdict: "ready", summary: "clear", questions: [], risks: [] }),
  classification: () => ({ type: "feature", complete: true, missing: [] }),
  review: () => ({ verdict: "approve", findings: [] }),
  analyze: () => ({ summary: "consistent", findings: [{ id: "F1", category: "Style", severity: "LOW", location: "tasks.md", summary: "nit", recommendation: "none" }] }),
  remediation: () => ({ accepted: [], rejected: [], summary: "done" }),
});

/** Behaves like Claude Code for the SpecKit flow: writes real SpecKit artefacts for skill steps, returns structured output otherwise. */
export class ScriptedAgent implements Agent {
  calls: AgentRequest[] = [];
  constructor(readonly provider: "anthropic" | "local", public b: Behaviour = defaults()) {}

  private ok(over: Partial<AgentResult> = {}): AgentResult {
    return { ok: true, text: "ok", denials: [], exitCode: 0, durationMs: 1, sessionId: "s", ...over };
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const props = (req.jsonSchema?.properties ?? {}) as Record<string, { items?: { properties?: Record<string, unknown> } }>;
    const step = /speckit-(\w+)\/SKILL\.md/.exec(req.prompt)?.[1];
    const dir = /SPECIFY_FEATURE_DIRECTORY=(\S+)/.exec(req.prompt)?.[1] ?? "";

    if (req.jsonSchema) {
      let structured: Structured;
      if ("accepted" in props) { this.b.onRemediate?.(req, dir || this.guessDir(req)); structured = this.b.remediation(req); }
      else if (props.findings?.items?.properties && "category" in props.findings.items.properties) structured = this.b.analyze();
      else if ("verdict" in props && "findings" in props) structured = this.b.review();
      else if ("complete" in props) structured = this.b.classification();
      else structured = this.b.analysis();
      return this.ok({ structured, text: JSON.stringify(structured) });
    }
    if (step && STEP_FILES[step]) {
      for (const f of STEP_FILES[step]!) {
        const dest = join(req.cwd, dir, f);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(FIXTURE, f), dest);
      }
      mkdirSync(join(req.cwd, ".specify"), { recursive: true });
      writeFileSync(join(req.cwd, ".specify", "feature.json"), JSON.stringify({ feature_directory: dir }));
      const r = this.b.onStep?.(step, req, dir);
      return this.ok(r ?? {});
    }
    return this.ok();
  }
  private guessDir(req: AgentRequest) { return /under (specs\/\S+)\//.exec(req.prompt)?.[1] ?? ""; }
}

export const overwrite = (cwd: string, rel: string, content: string) => {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};
export const exists = (cwd: string, rel: string) => existsSync(join(cwd, rel));
