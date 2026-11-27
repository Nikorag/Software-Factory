import type { StageHandler } from "../core/engine.js";
import { createStageKit, type StageKitDeps } from "../app/stage-kit.js";
import { withCommentary } from "../agents/commentary.js";
import { criteriaFrom, ImplementationPlan } from "./plan.js";

const MIN = 60_000;
const ANSWER_ADVICE = "Answer on the job page (the job resumes with your answer), or answer in the ticket and then retry the job.";
const MAX_PROMPT = 24_000;

export const promptWriterPrompt = (ticket: string, commands: { test?: string | undefined; lint?: string | undefined; typecheck?: string | undefined }) => [
  "Write the implementer's prompt for this ticket. Do not implement anything.",
  ticket,
  `The project's checks (the implementer runs them through a check tool; mention what must be covered by tests, not how to run them): test: ${commands.test ?? "(detect from the repo)"}; lint: ${commands.lint ?? "(detect)"}; typecheck: ${commands.typecheck ?? "(detect)"}.`,
  "Work only a person can do (manual or visual testing, real devices, credentials) must not be an acceptance criterion; leave it out or say it is for a human to verify.",
  "Return JSON per the schema: `prompt` is the full text the implementer will receive; `acceptanceCriteria` are the testable statements of done; use `needs_clarification` with `questions` only as the instructions allow.",
].join("\n\n");

/**
 * haiku_prompt mode, REQUIREMENTS_ANALYSIS: one read-only Haiku run turns the ticket plus what it finds in the repository into the
 * implementer's prompt. The prompt and acceptance criteria are kept in the stage's recorded output: no files, no spec bundle.
 */
export function createPromptHandlers(d: StageKitDeps) {
  const { prepare, agent, record } = createStageKit(d);

  const requirementsAnalysis: StageHandler = async (ctx) => {
    const p = await prepare(ctx.job);
    if (!p.ok) return p.stop;
    const project = d.project(ctx.job.projectId);
    const r = await agent(ctx, { task: "prompt_generation", role: "prompt-writer", prompt: promptWriterPrompt(p.ticket, project.commands), cwd: p.cwd, schema: ImplementationPlan, timeoutMs: 10 * MIN });
    if (!r.ok) return r.stop;
    const plan = r.data!;
    if (plan.verdict === "needs_clarification") {
      const qs = plan.questions.length ? plan.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") : "(the prompt writer did not list specific questions)";
      return { kind: "blocked", reason: `The requirements need clarification before the work can start:\n${qs}\n\n${ANSWER_ADVICE}` };
    }
    const criteria = criteriaFrom(plan.acceptanceCriteria);
    if (!plan.prompt.trim() || criteria.length === 0) return { kind: "retry", reason: "the prompt writer returned no prompt or no acceptance criteria" };
    record(ctx.job.id, "prompt.generated", `${plan.prompt.length} chars, ${criteria.length} acceptance criteria`, r.result.route?.model);
    return { kind: "ok", output: { plan: { prompt: plan.prompt.slice(0, MAX_PROMPT), criteria }, branch: p.info.branch } };
  };

  return withCommentary({ REQUIREMENTS_ANALYSIS: requirementsAnalysis });
}
