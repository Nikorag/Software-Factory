import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import type { FactoryDb } from "../db/client.js";
import { stageExecutions } from "../db/schema.js";

/** What Claude Haiku returns when asked to write the implementer's prompt. */
export const ImplementationPlan = z.object({
  verdict: z.enum(["ready", "needs_clarification"]),
  questions: z.array(z.string()).default([]).describe("exact questions a human must answer; empty if ready"),
  prompt: z.string().describe("the complete, concise prompt for the implementing agent: objective, requirements, repository context, conventions, constraints, testing expectations"),
  acceptanceCriteria: z.array(z.string()).describe("short, testable statements of what done means"),
});
export type ImplementationPlan = z.infer<typeof ImplementationPlan>;

export interface StoredPlan { prompt: string; criteria: { id: string; text: string }[] }

export const criteriaFrom = (items: string[]): StoredPlan["criteria"] => items.map((t) => t.trim()).filter(Boolean).map((text, i) => ({ id: `AC-${String(i + 1).padStart(2, "0")}`, text: text.slice(0, 400) }));

/** The plan from the latest successful REQUIREMENTS_ANALYSIS (haiku_prompt mode): it lives in that stage's recorded output, not in a file. */
export function latestPlan(db: FactoryDb, jobId: string): StoredPlan | undefined {
  const row = db.select().from(stageExecutions)
    .where(and(eq(stageExecutions.jobId, jobId), eq(stageExecutions.stage, "REQUIREMENTS_ANALYSIS"), eq(stageExecutions.outcome, "succeeded")))
    .orderBy(desc(stageExecutions.id)).limit(1).get();
  try {
    const plan = (row?.outputJson ? JSON.parse(row.outputJson) : {}) as { plan?: StoredPlan };
    return plan.plan?.prompt ? plan.plan : undefined;
  } catch { return undefined; }
}

/** The plan as the reviewers see it (they judge the change against the same brief the implementer had). */
export const planExcerpt = (p: StoredPlan): string => `${p.prompt}\n\nAcceptance criteria:\n${p.criteria.map((c) => `- ${c.id}: ${c.text}`).join("\n")}`;
