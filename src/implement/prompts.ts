import { skillPrompt } from "../speckit/prompts.js";
import type { SpecBundle } from "../speckit/artifacts.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

export interface Criterion { id: string; text: string }

/** The testable statements in a spec: functional requirements and success criteria (what "done" means). */
export function extractCriteria(spec: string): Criterion[] {
  const out: Criterion[] = [];
  for (const m of spec.matchAll(/^\s*[-*]\s*\*{0,2}((?:FR|SC)-\d{3})\*{0,2}\s*[:.\-–]\s*(.+)$/gm)) out.push({ id: m[1]!, text: m[2]!.trim().slice(0, 400) });
  return out;
}

export function implementPrompt(o: { featureDir: string; wrapper: string; checks: string[]; pass: number; appended?: string }): string {
  return [
    skillPrompt("implement", o.featureDir, [
      `Implement the tasks in ${o.featureDir}/tasks.md in this worktree, on the current branch. ${o.pass > 1 ? `This is pass ${o.pass}: the completeness check appended new tasks; do those. ${o.appended ?? ""}` : ""}`,
      `Verify your work ONLY with the factory's check tool, one check per command: ${o.checks.map((c) => `\`${o.wrapper} ${c}\``).join(", ")}. It runs the project's own command inside a sandbox with no network. Do not run npm, pnpm, yarn, node, python or any other command to execute code: they are refused. You cannot install dependencies; if one is missing, say so in your summary instead of working around it.`,
      "Write or update tests for every behaviour you change, and never delete, skip or weaken an existing test to make a check pass.",
      "Commit coherent changes as you go with `git add` and `git commit`. You may tick finished tasks in tasks.md. Do not touch CI workflows, secrets, or the .claude and .specify directories.",
      "Finish with a short summary per the JSON schema: tasks done, and any task you could not complete with the reason.",
    ].join("\n\n")),
  ].join("\n\n");
}

export const convergePrompt = (featureDir: string) => [
  skillPrompt("converge", featureDir, "This step only assesses the codebase against the spec, plan and tasks. You may append new tasks to tasks.md and change nothing else."),
  "Report per the JSON schema: `converged` true only if no gaps remain, and how many tasks you appended.",
].join("\n\n");

export const failureSummaryPrompt = (kind: string, command: string, tail: string) => [
  `A project check failed. Check: ${kind}. Command: ${command}.`, "Output (end of log):", "```", clip(tail, 8000), "```",
  "Summarise what failed and the most likely cause in a few sentences, and list the failing test names if any. Do not suggest deleting or skipping tests.",
].join("\n");

const resultsText = (results: { kind: string; ok: boolean; command: string }[]) => results.map((r) => `- ${r.kind} \`${r.command}\`: ${r.ok ? "passed" : "FAILED"}`).join("\n") || "(none)";

export const codeReviewPrompt = (o: { ticket: string; spec: string; stat: string; diff: string; results: { kind: string; ok: boolean; command: string }[] }) => [
  "Independently review this implementation. You have not seen the author's reasoning.", o.ticket,
  `Specification (excerpt):\n${clip(o.spec, 12_000)}`, `Check results:\n${resultsText(o.results)}`, `Diff stat:\n${o.stat}`, `Diff (code only):\n\`\`\`diff\n${o.diff}\n\`\`\``,
  "Report findings per the JSON schema with the file and line. `blocker`: wrong behaviour, data loss, or a requirement not met. `major`: a likely bug, an untested behaviour, or a weakened/deleted test. `minor`: polish. Only report what you can point to in the diff or the code; do not speculate.",
].join("\n\n");

export const securityReviewPrompt = (diff: string, files: string[]) => [
  "Review this change for security problems.", `Files changed: ${files.join(", ")}`, `Diff:\n\`\`\`diff\n${diff}\n\`\`\``,
  "Report each finding per the JSON schema, with how it could be exploited and the fix. Use `critical` only for a demonstrable, serious vulnerability (secrets exposure, injection, auth bypass, remote code execution). Report only what you can show from the code.",
].join("\n\n");

export const claudeReviewPrompt = (o: { ticket: string; spec: string; stat: string; earlier: { id: string; severity: string; file: string; issue: string }[]; results: { kind: string; ok: boolean; command: string }[]; base: string }) => [
  `Review this implementation as the senior reviewer. Read the changed files yourself (use \`git diff ${o.base}...HEAD\` and the Read tool).`, o.ticket,
  `Specification (excerpt):\n${clip(o.spec, 12_000)}`, `Check results:\n${resultsText(o.results)}`, `Diff stat:\n${o.stat}`,
  `An independent reviewer (a different model) reported these earlier findings:\n${JSON.stringify(o.earlier, null, 2)}`,
  "For EACH earlier finding give a verdict in `earlier`: valid or not, with evidence. Then report any further blocker/major problems in `findings`. Judge on evidence; do not rubber-stamp and do not invent problems.",
].join("\n\n");

export const implRemediationPrompt = (o: { featureDir: string; wrapper: string; checks: string[]; findings: unknown[] }) => [
  "Fix the findings below in this worktree. Judge each on its merits: fix the valid ones, and reject any that are wrong with concrete evidence. Never delete, skip or weaken a test to make a check pass.",
  `Verify with the factory's check tool only (${o.checks.map((c) => `\`${o.wrapper} ${c}\``).join(", ")}); other code-running commands are refused. Commit your fixes with \`git add\` and \`git commit\`.`,
  `Findings:\n${JSON.stringify(o.findings, null, 2)}`,
  "Finish by reporting which finding ids you accepted and which you rejected (with reasons) per the JSON schema.",
].join("\n\n");

export const finalReviewPrompt = (o: { ticket: string; criteria: Criterion[]; stat: string; results: { kind: string; ok: boolean; command: string }[]; base: string; decisions: string[] }) => [
  `You are the final gate. Verify the implementation against the specification. Read the code and tests yourself (\`git diff ${o.base}...HEAD\`, the Read tool).`, o.ticket,
  `Criteria that must be met (functional requirements and success criteria):\n${o.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")}`,
  `Check results (re-run just now):\n${resultsText(o.results)}`, `Diff stat:\n${o.stat}`,
  o.decisions.length ? `Decisions the agents recorded (rejected findings and their reasons; challenge any you disagree with):\n${o.decisions.map((d) => `- ${d}`).join("\n")}` : "",
  "For EVERY criterion say whether it is met and cite the file:line of the code AND of a test that would fail without it. A criterion with no test is NOT met. Answer `approve` only if all are met and nothing blocking remains; otherwise `changes_required` with findings.",
].filter(Boolean).join("\n\n");

export const specExcerpt = (b: SpecBundle) => b.files["spec.md"] ?? "";
