import type { Hosts } from "../host/index.js";
import { onboardingOf, type CheckRecord, type Onboarding } from "./readiness.js";
import { eq } from "drizzle-orm";
import { expandHome } from "../config/load.js";
import type { ProjectConfig } from "../config/schema.js";
import type { FactoryDb } from "../db/client.js";
import { projects } from "../db/schema.js";
import { inspectRepository, type GhApi, type RepoReport } from "./inspect.js";
import type { GitFn } from "./git.js";

/** Upserts configured projects so jobs can reference them. Never touches the repositories themselves. */
export function syncProjects(db: FactoryDb, configured: ProjectConfig[]): void {
  db.transaction((tx) => {
    for (const p of configured) {
      const configJson = JSON.stringify(p);
      tx.insert(projects).values({ id: p.id, configJson }).onConflictDoUpdate({ target: projects.id, set: { configJson } }).run();
    }
  });
}

export function getProjectConfig(db: FactoryDb, id: string): ProjectConfig | undefined {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  return row ? (JSON.parse(row.configJson) as ProjectConfig) : undefined;
}

/** Validate (read-only) and persist the report. Disabled projects are skipped. */
export async function validateProjects(
  db: FactoryDb, configured: ProjectConfig[], deps: { git?: GitFn; gh?: GhApi; now?: () => Date; hosts?: Hosts } = {},
): Promise<RepoReport[]> {
  const reports: RepoReport[] = [];
  for (const p of configured.filter((c) => c.enabled)) {
    const report = await inspectRepository(p, { ...deps, bitbucketProtection: deps.hosts && p.host === "bitbucket" ? (slug) => deps.hosts!.protection(p, slug) : undefined });
    db.update(projects).set({ lastValidatedAt: (deps.now ?? (() => new Date()))(), validationJson: JSON.stringify(report) }).where(eq(projects.id, p.id)).run();
    reports.push(report);
  }
  return reports;
}

/** Only projects whose latest validation passed may receive jobs. */
export function isRunnable(db: FactoryDb, id: string): boolean {
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row?.validationJson) return false;
  const cfg = JSON.parse(row.configJson) as ProjectConfig;
  return cfg.enabled && cfg.autonomy !== "off" && (JSON.parse(row.validationJson) as RepoReport).ok;
}

export const repoPathOf = (db: FactoryDb, id: string): string => {
  const cfg = getProjectConfig(db, id);
  if (!cfg) throw new Error(`unknown project ${id}`);
  return expandHome(cfg.repository);
};

/** The project's onboarding status from what the factory has recorded (its last validation and last command check). */
export function onboardingFor(db: FactoryDb, project: ProjectConfig): Onboarding {
  const row = db.select().from(projects).where(eq(projects.id, project.id)).get();
  return onboardingOf(project, row?.validationJson ? (JSON.parse(row.validationJson) as RepoReport) : null, row?.checkJson ? (JSON.parse(row.checkJson) as CheckRecord) : null);
}
