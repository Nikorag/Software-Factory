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

/** Work only a person can do (manual or visual testing, real devices, credentials, commands the sandbox does not offer). Posted on the PR. */
export const Deferred = z.array(z.object({ id: z.string().describe("task id (T023), finding id, or a short slug"), reason: z.string().describe("why only a human can do it, and what they should check") }))
  .default([]).describe("items only a human can do; they are listed on the pull request instead of blocking the run");

export const Converge = z.object({ converged: z.boolean(), appendedTasks: z.number().int(), summary: z.string(), deferred: Deferred });
export const FailureSummary = z.object({ summary: z.string().describe("what failed and the most likely cause, in a few sentences"), failingTests: z.array(z.string()) });
export const ImplementResult = z.object({ summary: z.string(), tasksDone: z.array(z.string()), tasksSkipped: z.array(z.object({ id: z.string(), reason: z.string() })), deferred: Deferred });
/** The implementer's answer to review findings: fixed, rejected with evidence, or deferred to a human. */
export const ImplRemediation = z.object({
  accepted: z.array(z.string()).describe("ids of findings you fixed"),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })).describe("ids of findings you judged invalid, with evidence"),
  deferred: Deferred,
  summary: z.string(),
});
