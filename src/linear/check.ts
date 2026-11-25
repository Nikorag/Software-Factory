import type { LinearConfig } from "../config/schema.js";
import type { LinearClient } from "./client.js";

type StatusKey = keyof LinearConfig["statuses"];
type LabelKey = keyof LinearConfig["labels"];

/** What the factory writes today. Anything else in config is reserved for later milestones or only refines behaviour. */
export const REQUIRED_STATUSES: StatusKey[] = ["readyForSpecification", "specificationReview", "inProgress", "readyForReview", "merging", "done", "blocked"];
export const REQUIRED_LABELS: LabelKey[] = ["enabled", "blocked"];

/** Linear workflow-state type to pick when creating each status by hand (Linear asks for one). */
export const SUGGESTED_STATUS_TYPE: Record<StatusKey, string> = {
  readyForSpecification: "Unstarted (Todo)", specificationReview: "Started", readyForDevelopment: "Unstarted (Todo)", inProgress: "Started",
  readyForReview: "Started", changesRequested: "Started", merging: "Started", done: "Completed", blocked: "Started",
};

export interface Gap { key: string; name: string; required: boolean }
export interface TeamAudit {
  team: { key: string; name: string };
  statuses: Gap[]; // missing only
  labels: Gap[];
  existingStatuses: string[];
  existingLabels: string[];
  ok: boolean; // nothing *required* is missing
}

/** Read-only: compares what config names with what the team actually has. */
export async function auditTeam(client: LinearClient, config: LinearConfig, team: { id: string; key: string; name: string }): Promise<TeamAudit> {
  const states = (await client.workflowStates(team.id)).map((s) => s.name);
  const labels = (await client.labels(team.id)).map((l) => l.name);
  const has = (list: string[], n: string) => list.some((x) => x.toLowerCase() === n.toLowerCase());
  const statuses = (Object.keys(config.statuses) as StatusKey[])
    .filter((k) => !has(states, config.statuses[k])).map((k) => ({ key: k, name: config.statuses[k], required: REQUIRED_STATUSES.includes(k) }));
  const lbls = (Object.keys(config.labels) as LabelKey[])
    .filter((k) => !has(labels, config.labels[k])).map((k) => ({ key: k, name: config.labels[k], required: REQUIRED_LABELS.includes(k) }));
  return {
    team: { key: team.key, name: team.name }, statuses, labels: lbls,
    existingStatuses: states, existingLabels: labels.filter((l) => /^factory/i.test(l) || labels.length <= 30),
    ok: ![...statuses, ...lbls].some((g) => g.required),
  };
}
