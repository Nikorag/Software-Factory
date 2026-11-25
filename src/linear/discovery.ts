import { and, desc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { LinearConfig, ProjectConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { decisions, jobs } from "../db/schema.js";
import { enqueue } from "../core/jobs.js";
import { isRunnable, onboardingFor } from "../repo/registry.js";
import type { LinearClient, LinearIssue } from "./client.js";
import { enqueueOutbox } from "./outbox.js";
import { evaluateEligibility } from "./eligibility.js";

export interface DiscoveryReport {
  enqueued: { key: string; jobId: string; projectId: string; workflow: string; autonomous: boolean }[];
  skipped: { key: string; projectId?: string; reasons: string[] }[];
  errors: { projectId: string; error: string }[];
}

const specificity = (p: ProjectConfig) => (p.linear?.projectId || p.linear?.projectName ? 2 : 1);

/**
 * One polling pass. Reads Linear, decides eligibility, creates idempotent jobs. Never changes issue state
 * itself (status writes go through the outbox once a job starts). Safe to run repeatedly and concurrently.
 */
export async function discoverIssues(deps: {
  db: FactoryDb; client: LinearClient; linear: LinearConfig; projects: ProjectConfig[]; logger: Logger; dryRun?: boolean;
  /** Skip tickets of projects whose onboarding is not complete (the service turns this on). */
  requireOnboarding?: boolean;
}): Promise<DiscoveryReport> {
  const { db, client, linear, logger } = deps;
  const report: DiscoveryReport = { enqueued: [], skipped: [], errors: [] };
  const bound = deps.projects.filter((p) => p.enabled && p.linear);

  // Collect candidates per project; an issue may match several project bindings.
  const matches = new Map<string, { issue: LinearIssue; projects: ProjectConfig[] }>();
  for (const p of bound) {
    try {
      const issues = await client.listIssues({
        teamKey: p.linear!.teamKey, projectId: p.linear!.projectId, projectName: p.linear!.projectName,
        stateName: linear.statuses.readyForSpecification, labelName: linear.labels.enabled,
      });
      for (const issue of issues) {
        const m = matches.get(issue.id) ?? { issue, projects: [] };
        m.projects.push(p);
        matches.set(issue.id, m);
      }
    } catch (e) {
      report.errors.push({ projectId: p.id, error: (e as Error).message });
      logger.error({ projectId: p.id, err: (e as Error).message }, "linear discovery failed for project");
    }
  }

  for (const { issue, projects } of matches.values()) {
    // Most specific binding wins (team+project beats team-only); a tie is ambiguous and is not guessed at.
    const top = Math.max(...projects.map(specificity));
    const best = projects.filter((p) => specificity(p) === top);
    if (best.length > 1) {
      report.skipped.push({ key: issue.identifier, reasons: [`ambiguous project mapping: ${best.map((p) => p.id).join(", ")}`] });
      continue;
    }
    const project = best[0]!;
    const prior = db.select().from(jobs).where(and(eq(jobs.projectId, project.id), eq(jobs.externalId, issue.id))).orderBy(desc(jobs.createdAt)).limit(1).get();
    const verdict = evaluateEligibility(issue, project, linear, { projectRunnable: isRunnable(db, project.id), existingJobStatus: prior?.status });
    if (verdict.eligible && deps.requireOnboarding) {
      const ob = onboardingFor(db, project);
      if (ob.status !== "ready") {
        const todo = ob.steps.filter((x) => !x.ok).map((x) => x.label.toLowerCase());
        if (!prior) report.skipped.push({ key: issue.identifier, projectId: project.id, reasons: [`project ${project.id} is not onboarded yet (still to do: ${todo.join("; ")}): finish it in Settings > Projects`] });
        continue;
      }
    }
    if (!verdict.eligible) {
      // An issue already being processed is expected on every poll; only report genuinely new rejections.
      if (!prior || prior.status === "cancelled") report.skipped.push({ key: issue.identifier, projectId: project.id, reasons: verdict.reasons });
      continue;
    }
    const { job, created } = enqueue(db, {
      projectId: project.id, externalId: issue.id, externalKey: issue.identifier,
      workflow: verdict.workflow, autonomous: verdict.autonomous, dryRun: deps.dryRun ?? false,
    });
    if (!created) continue;
    db.insert(decisions).values({
      jobId: job.id, kind: "discovery.accept", actor: "factory",
      decision: `accepted ${issue.identifier} as ${verdict.workflow}${verdict.autonomous ? " (autonomous)" : ""}`,
      rationale: `${issue.url} -> project ${project.id}`,
    }).run();
    if (!deps.dryRun) {
      enqueueOutbox(db, job.id, issue.id, { kind: "comment", body: `**Software factory** picked this up as a \`${verdict.workflow}\` job${verdict.autonomous ? " (autonomous)" : ""}.` }, `${job.id}:pickup`);
    }
    report.enqueued.push({ key: issue.identifier, jobId: job.id, projectId: project.id, workflow: verdict.workflow, autonomous: verdict.autonomous });
  }
  return report;
}
