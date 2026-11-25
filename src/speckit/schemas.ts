import { z } from "zod";

/** Structured-output contracts for each agent step. JSON Schema is derived from the zod schema, so they cannot drift. */
export const toJsonSchema = (s: z.ZodType): Record<string, unknown> => {
  const schema = z.toJSONSchema(s) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
};

export const Classification = z.object({
  type: z.enum(["feature", "bugfix", "maintenance"]),
  complete: z.boolean().describe("true if the requirements are complete enough to specify without asking questions"),
  missing: z.array(z.string()).describe("specific missing details, empty if complete"),
});

export const Analysis = z.object({
  verdict: z.enum(["ready", "needs_clarification"]),
  summary: z.string(),
  questions: z.array(z.string()).describe("exact questions a human must answer; empty if ready"),
  risks: z.array(z.string()),
});

const Severity = z.enum(["blocker", "major", "minor"]);
export const Review = z.object({
  verdict: z.enum(["approve", "changes_required"]),
  findings: z.array(z.object({ id: z.string(), severity: Severity, section: z.string(), issue: z.string(), fix: z.string() })),
});
export type Finding = z.infer<typeof Review>["findings"][number];

export const Analyze = z.object({
  summary: z.string(),
  findings: z.array(z.object({
    id: z.string(), category: z.string(), severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
    location: z.string(), summary: z.string(), recommendation: z.string(),
  })),
});

export const Remediation = z.object({
  accepted: z.array(z.string()).describe("ids of findings you fixed"),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })).describe("ids of findings you judged invalid, with evidence"),
  summary: z.string(),
});

/** Findings that must be fixed before the spec may advance. Minor / MEDIUM / LOW are recorded but do not block. */
export const blocking = (sev: string): boolean => ["blocker", "major", "CRITICAL", "HIGH"].includes(sev);
