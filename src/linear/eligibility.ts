import type { LinearConfig, ProjectConfig } from "../config/schema.js";
import type { LinearIssue } from "./client.js";

export type WorkflowKind = "feature" | "bugfix" | "maintenance";
export interface Eligibility { eligible: boolean; reasons: string[]; workflow: WorkflowKind; autonomous: boolean }

/**
 * Pure decision: may the factory process this issue? Only issues that explicitly opt in are eligible.
 * `existingJobStatus` is the status of any prior job for the issue (a finished/failed job must never be silently re-run).
 */
export function evaluateEligibility(
  issue: LinearIssue, project: ProjectConfig, linear: LinearConfig,
  ctx: { projectRunnable: boolean; existingJobStatus?: string },
): Eligibility {
  const names = new Set(issue.labels.map((l) => l.name.toLowerCase()));
  const has = (n: string) => names.has(n.toLowerCase());
  const reasons: string[] = [];

  if (!has(linear.labels.enabled)) reasons.push(`missing label ${linear.labels.enabled}`);
  if (issue.state.name.toLowerCase() !== linear.statuses.readyForSpecification.toLowerCase()) {
    reasons.push(`status is "${issue.state.name}", not "${linear.statuses.readyForSpecification}"`);
  }
  if (has(linear.labels.blocked)) reasons.push(`has label ${linear.labels.blocked}`);
  if (!project.enabled || project.autonomy === "off") reasons.push(`project ${project.id} is disabled or autonomy is off`);
  if (!ctx.projectRunnable) reasons.push(`project ${project.id} has not passed validation`);
  if (ctx.existingJobStatus && ctx.existingJobStatus !== "cancelled") reasons.push(`already has a ${ctx.existingJobStatus} job`);

  const kinds = (["bugfix", "maintenance", "feature"] as const).filter((k) => has(linear.labels[k]));
  if (kinds.length > 1) reasons.push(`conflicting type labels: ${kinds.join(", ")}`);

  // Autonomy needs both the issue's opt-in and the project's configuration.
  const autonomous = has(linear.labels.autonomous) && project.autonomy === "full";
  return { eligible: reasons.length === 0, reasons, workflow: kinds[0] ?? "feature", autonomous };
}
