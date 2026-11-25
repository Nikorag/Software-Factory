import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { FactoryDb } from "../db/client.js";
import { artifacts } from "../db/schema.js";

/** specs/<issue-key>-<slug>: pinned per ticket so concurrent worktrees never race on SpecKit's number scanning. */
export function featureDirFor(issueKey: string, title: string): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `specs/${issueKey.toLowerCase()}${slug ? `-${slug}` : ""}`;
}

export interface SpecBundle { dir: string; files: Record<string, string> } // relative-to-dir path -> content

export function readSpecBundle(worktree: string, featureDir: string): SpecBundle {
  const root = join(worktree, featureDir);
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(md|json|ya?ml)$/i.test(name)) files[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return { dir: featureDir, files };
}

export interface SpecCheck { id: string; ok: boolean; detail: string }

/**
 * Deterministic quality gate for a SpecKit bundle. Patterns were calibrated against real generated artefacts
 * (FR-001 style requirements, SC-001 criteria, "Given/When/Then" scenarios, `- [ ] T001` tasks, checked checklist).
 */
export function validateSpecArtifacts(b: SpecBundle): SpecCheck[] {
  const f = b.files;
  const spec = f["spec.md"] ?? "", plan = f["plan.md"] ?? "", tasks = f["tasks.md"] ?? "", checklist = f["checklists/requirements.md"];
  const checks: SpecCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  for (const name of ["spec.md", "plan.md", "tasks.md"]) {
    const len = (f[name] ?? "").trim().length;
    add(`exists:${name}`, len > 200, f[name] === undefined ? `${name} is missing` : `${name} is too short (${len} chars)`);
  }
  const marker = /\[NEEDS CLARIFICATION[^\]]*\]/i; // the bracketed marker only: research.md may say "no NEEDS CLARIFICATION remain"
  add("no-open-markers", !marker.test(spec) && !marker.test(plan), "spec.md or plan.md still contains a [NEEDS CLARIFICATION] marker");
  const placeholders = /\[(FEATURE NAME|DATE|Brief Title|NEEDS|PLACEHOLDER)\b|\$ARGUMENTS|ACTION REQUIRED/i;
  add("no-template-placeholders", !Object.values(f).some((c) => placeholders.test(c.replace(/\[NEEDS CLARIFICATION[^\]]*\]/gi, ""))), "unfilled template placeholder text remains");
  add("has-requirements", /\bFR-\d{3}\b/.test(spec), "spec.md has no functional requirements (FR-001 …)");
  add("has-success-criteria", /\bSC-\d{3}\b/.test(spec), "spec.md has no measurable success criteria (SC-001 …)");
  add("has-acceptance-scenarios", /\bGiven\b[\s\S]{0,400}\bWhen\b[\s\S]{0,400}\bThen\b/i.test(spec), "spec.md has no Given/When/Then acceptance scenario");
  add("has-user-stories", /User Story \d+/i.test(spec), "spec.md has no user stories");
  add("has-tasks", (tasks.match(/^\s*- \[[ xX]\] T\d{3}\b/gm) ?? []).length > 0, "tasks.md has no tasks (- [ ] T001 …)");
  add("checklist-complete", checklist === undefined || !/^\s*- \[ \]/m.test(checklist), "checklists/requirements.md has unchecked items");
  add("no-human-questions", openQuestions(b).length === 0, "the specification lists open questions that require a human");
  return checks;
}

/** The open human questions, if any (so the job can ask them in Linear). `$(?![\\s\\S])` is end-of-input in JS (there is no `\\Z`). */
export function openQuestions(b: SpecBundle): string[] {
  const text = (b.files["spec.md"] ?? "") + "\n" + (b.files["plan.md"] ?? "");
  const out: string[] = [];
  for (const m of text.matchAll(/^#{1,4}[ \t]*Open questions requiring a human[ \t]*$([\s\S]*?)(?=^#{1,4}[ \t]|$(?![\s\S]))/gim)) {
    for (const line of m[1]!.split("\n")) {
      const q = line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
      // "None.", "N/A", "No open questions", and parenthetical/"Note:" asides mean there is no question.
      if (q && !/^(none|n\/a|nothing|no (open )?questions?)\b/i.test(q) && !/^[(\[]|^note\b/i.test(q) && !/^[-—–.]+$/.test(q)) out.push(q);
    }
  }
  return out;
}

const kindOf = (rel: string): string => {
  const base = rel.split("/").pop()!.replace(/\.md$/i, "");
  if (rel.startsWith("contracts/")) return "contract";
  if (rel.startsWith("checklists/")) return "checklist";
  return base;
};

/** Record every artefact in the feature directory (idempotent: same path+hash is stored once). */
export function recordArtifacts(db: FactoryDb, jobId: string, b: SpecBundle, extra: Record<string, string> = {}): number {
  let added = 0;
  const all = { ...Object.fromEntries(Object.entries(b.files).map(([k, v]) => [`${b.dir}/${k}`, v])), ...extra };
  for (const [path, content] of Object.entries(all)) {
    const rel = path.startsWith(b.dir + "/") ? path.slice(b.dir.length + 1) : path;
    const r = db.insert(artifacts).values({ jobId, kind: kindOf(rel), path, sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) }).onConflictDoNothing().run();
    added += r.changes;
  }
  return added;
}
