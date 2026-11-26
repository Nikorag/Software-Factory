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

/** What a retried attempt must know: why the previous attempt(s) at this stage failed. */
const failuresText = (f?: string[]) => (f?.length ? `Earlier attempts at this step failed; do not repeat what caused it:\n${f.map((x) => `- ${x}`).join("\n")}` : "");

const DEFER_RULE = `Never get stuck on work only a person can do (manual or visual testing, a walkthrough in a real window or browser, real devices, external servers, credentials, or a command the check tool does not offer, such as generating a database migration with a tool you cannot run). Do not fake it and do not keep retrying it: tag such a task \`[HUMAN]\` in tasks.md (\`- [ ] T023 [HUMAN] ...\`) and list it in \`deferred\` with the reason and what the person should check. The factory posts deferred items on the pull request and carries on.`;

export interface Gaps { appended: number; summary: string }

/** Shown only when the project's agent access is unrestricted: the usual "check tool only" limits do not apply, and an old conversation's "I cannot run X" must not stick. */
const unrestrictedNote = (wrapper: string, checks: string[]) =>
  `You have unrestricted access in this worktree: run whatever commands you need, including the project's own tooling and build tools, and read how the project's scripts invoke them (for example tests/run.sh names the exact path of its tools). The factory's check tool (${checks.map((c) => `\`${wrapper} ${c}\``).join(", ")}) is still the authoritative result, so finish by running it. If earlier in this conversation you concluded that you cannot run something, that no longer holds: try it before deferring.`;

/** When recorded expectations encode the old behaviour that the ticket deliberately changes, regenerating them is the fix. */
const FIXTURE_NOTE = "If checks fail because recorded expectations (golden files, snapshots, fixtures, oracles) encode the OLD behaviour that this ticket deliberately changes, regenerating them with the project's own tooling is a fix, not weakening a test. Do that, commit the regenerated files, and say so in your summary. Only do it when the ticket or spec calls for the changed behaviour; if the new output looks wrong, treat it as a bug instead.";

export function implementPrompt(o: { featureDir: string; wrapper: string; checks: string[]; pass: number; ticket?: string; gaps?: Gaps; previousFailures?: string[]; unrestricted?: boolean }): string {
  const again = o.pass > 1 && o.gaps
    ? `This is pass ${o.pass}. The completeness check found work remaining: ${o.gaps.summary}\n${o.gaps.appended > 0 ? `It appended ${o.gaps.appended} new task(s) to tasks.md: do those.` : "It appended no new tasks, so close the gaps above directly. If a gap is something you cannot do here, do not try again: defer it (see below) and say why."}`
    : "";
  return [
    skillPrompt("implement", o.featureDir, [
      `Implement the tasks in ${o.featureDir}/tasks.md in this worktree, on the current branch.`,
      again,
      o.ticket ?? "",
      failuresText(o.previousFailures),
      o.unrestricted ? unrestrictedNote(o.wrapper, o.checks) : `Verify your work ONLY with the factory's check tool, one check per command: ${o.checks.map((c) => `\`${o.wrapper} ${c}\``).join(", ")}. It runs the project's own command inside a sandbox with no network. Do not run npm, pnpm, yarn, node, python or any other command to execute code: they are refused. You cannot install dependencies; if one is missing, say so in your summary instead of working around it.`,
      "Write or update tests for every behaviour you change, and never delete, skip or weaken an existing test to make a check pass.",
      "Commit coherent changes as you go with `git add` and `git commit`. You may tick finished tasks in tasks.md. Do not touch CI workflows, secrets, or the .claude and .specify directories.",
      `Tasks already tagged \`[HUMAN]\` are for a person: skip them. ${DEFER_RULE}`,
      "Finish with a short summary per the JSON schema: tasks done, any task you could not complete with the reason, and anything deferred to a human.",
    ].filter(Boolean).join("\n\n")),
  ].join("\n\n");
}

export const convergePrompt = (featureDir: string, o: { skipped?: { id: string; reason: string }[]; deferred?: { id: string; reason: string }[] } = {}) => [
  skillPrompt("converge", featureDir, "This step only assesses the codebase against the spec, plan and tasks. You may append new tasks to tasks.md and change nothing else."),
  o.skipped?.length || o.deferred?.length
    ? `The implementer reported it could not do these (judge whether that is true):\n${[...(o.skipped ?? []), ...(o.deferred ?? [])].map((x) => `- ${x.id}: ${x.reason}`).join("\n")}`
    : "",
  "Only append tasks the implementer can actually do in its sandbox (edit code and tests, run the project's checks). A gap that needs a person (manual or visual testing, real devices or servers, credentials) or a command the implementer cannot run (for example generating a migration with a CLI, installing a dependency) must NOT be appended as a task and must not hold up convergence: list it in `deferred` with the reason and what a person should do. Tasks tagged `[HUMAN]` are already for a person.",
  "Report per the JSON schema: `converged` true only if no gaps remain other than the deferred ones, how many tasks you appended, and in `summary` the concrete remaining gaps (file, requirement) if any.",
].filter(Boolean).join("\n\n");

export const failureSummaryPrompt = (kind: string, command: string, tail: string) => [
  `A project check failed. Check: ${kind}. Command: ${command}.`, "Output (end of log):", "```", clip(tail, 8000), "```",
  "Summarise what failed and the most likely cause in a few sentences, and list the failing test names if any. Do not suggest deleting or skipping tests.",
].join("\n");

const resultsText = (results: { kind: string; ok: boolean; command: string }[]) => results.map((r) => `- ${r.kind} \`${r.command}\`: ${r.ok ? "passed" : "FAILED"}`).join("\n") || "(none)";

export const codeReviewPrompt = (o: { ticket: string; spec: string; stat: string; diff: string; results: { kind: string; ok: boolean; command: string }[]; history?: string }) => [
  "Independently review this implementation. You have not seen the author's reasoning.", o.ticket,
  `Specification (excerpt):\n${clip(o.spec, 12_000)}`, `Check results:\n${resultsText(o.results)}`, `Diff stat:\n${o.stat}`, `Diff (code only):\n\`\`\`diff\n${o.diff}\n\`\`\``,
  o.history ?? "",
  "Report findings per the JSON schema with the file and line. `blocker`: wrong behaviour, data loss, or a requirement not met. `major`: a likely bug, an untested behaviour, or a weakened/deleted test. `minor`: polish. Only report what you can point to in the diff or the code; do not speculate. Never block on something only a person can verify (manual or visual testing, real devices); that is listed on the pull request.",
].filter(Boolean).join("\n\n");

export const securityReviewPrompt = (diff: string, files: string[]) => [
  "Review this change for security problems.", `Files changed: ${files.join(", ")}`, `Diff:\n\`\`\`diff\n${diff}\n\`\`\``,
  "Report each finding per the JSON schema, with how it could be exploited and the fix. Use `critical` only for a demonstrable, serious vulnerability (secrets exposure, injection, auth bypass, remote code execution). Report only what you can show from the code.",
].join("\n\n");

export const claudeReviewPrompt = (o: { ticket: string; spec: string; stat: string; earlier: { id: string; severity: string; file: string; issue: string }[]; results: { kind: string; ok: boolean; command: string }[]; base: string; history?: string }) => [
  `Review this implementation as the senior reviewer. Read the changed files yourself (use \`git diff ${o.base}...HEAD\` and the Read tool).`, o.ticket,
  `Specification (excerpt):\n${clip(o.spec, 12_000)}`, `Check results:\n${resultsText(o.results)}`, `Diff stat:\n${o.stat}`,
  `An independent reviewer (a different model) reported these earlier findings:\n${JSON.stringify(o.earlier, null, 2)}`,
  o.history ?? "",
  "For EACH earlier finding give a verdict in `earlier`: valid or not, with evidence. Then report any further blocker/major problems in `findings`. Judge on evidence; do not rubber-stamp and do not invent problems. Never block on something only a person can verify; that is listed on the pull request.",
].filter(Boolean).join("\n\n");

export const implRemediationPrompt = (o: { featureDir: string; wrapper: string; checks: string[]; findings: unknown[]; ticket?: string; history?: string; previousFailures?: string[]; unrestricted?: boolean }) => [
  "Fix the findings below in this worktree. Judge each on its merits: fix the valid ones, and reject any that are wrong with concrete evidence. Never delete, skip or weaken a test to make a check pass.",
  o.ticket ?? "",
  failuresText(o.previousFailures),
  o.unrestricted ? unrestrictedNote(o.wrapper, o.checks) : `Verify with the factory's check tool only (${o.checks.map((c) => `\`${o.wrapper} ${c}\``).join(", ")}); other code-running commands are refused. Commit your fixes with \`git add\` and \`git commit\`.`,
  FIXTURE_NOTE,
  `Findings:\n${JSON.stringify(o.findings, null, 2)}`,
  o.history ?? "",
  `If a finding can only be resolved by a person, do not reject it: defer it. ${DEFER_RULE} For a finding about open tasks in ${o.featureDir}/tasks.md, defer the task ids. These can never be deferred and must be fixed: failing project checks (check:*), weakened or deleted tests, protected paths, uncommitted changes and conflict markers.`,
  "Finish by reporting which finding ids you accepted (fixed), which you rejected (with evidence) and which you deferred to a human (with the reason) per the JSON schema.",
].filter(Boolean).join("\n\n");

export const finalReviewPrompt = (o: { ticket: string; criteria: Criterion[]; stat: string; results: { kind: string; ok: boolean; command: string }[]; base: string; decisions: string[]; history?: string }) => [
  `You are the final gate. Verify the implementation against the specification. Read the code and tests yourself (\`git diff ${o.base}...HEAD\`, the Read tool).`, o.ticket,
  `Criteria that must be met (functional requirements and success criteria):\n${o.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")}`,
  `Check results (re-run just now):\n${resultsText(o.results)}`, `Diff stat:\n${o.stat}`,
  o.decisions.length ? `Decisions the agents recorded (rejected findings and their reasons; challenge any you disagree with):\n${o.decisions.map((d) => `- ${d}`).join("\n")}` : "",
  o.history ?? "",
  "For EVERY criterion say whether it is met and cite the file:line of the code AND of a test that would fail without it. A criterion with no test is NOT met, unless it can only be verified by a person (manual or visual checks, real devices): then it is met if the code implements it, and say in the evidence that it is deferred to human verification on the PR. Answer `approve` only if all are met and nothing blocking remains; otherwise `changes_required` with findings.",
].filter(Boolean).join("\n\n");

export const specExcerpt = (b: SpecBundle) => b.files["spec.md"] ?? "";
