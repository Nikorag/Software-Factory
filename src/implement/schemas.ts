import { z } from "zod";

const Sev = z.enum(["blocker", "major", "minor"]);
export const CodeFinding = z.object({ id: z.string(), severity: Sev, file: z.string(), line: z.number().int().nullable(), issue: z.string(), fix: z.string() });
export const CodeReview = z.object({ verdict: z.enum(["approve", "changes_required"]), findings: z.array(CodeFinding) });
export type CodeReviewT = z.infer<typeof CodeReview>;

export const SecurityReview = z.object({
  findings: z.array(z.object({ id: z.string(), severity: z.enum(["critical", "high", "medium", "low"]), file: z.string(), line: z.number().int().nullable(), issue: z.string(), exploit: z.string(), fix: z.string() })),
});

/** Claude's review of the implementation, validating (accepting or rejecting) the earlier independent findings. */
export const ClaudeReview = z.object({
  verdict: z.enum(["approve", "changes_required"]),
  findings: z.array(CodeFinding),
  earlier: z.array(z.object({ id: z.string(), valid: z.boolean(), evidence: z.string() })).describe("your verdict on each earlier finding, with evidence"),
});

export const FinalReview = z.object({
  verdict: z.enum(["approve", "changes_required"]),
  criteria: z.array(z.object({ id: z.string(), met: z.boolean(), evidence: z.string().describe("file:line of the code and of the test that proves it") })),
  findings: z.array(CodeFinding),
});

export const Converge = z.object({ converged: z.boolean(), appendedTasks: z.number().int(), summary: z.string() });
export const FailureSummary = z.object({ summary: z.string().describe("what failed and the most likely cause, in a few sentences"), failingTests: z.array(z.string()) });
export const ImplementResult = z.object({ summary: z.string(), tasksDone: z.array(z.string()), tasksSkipped: z.array(z.object({ id: z.string(), reason: z.string() })) });
