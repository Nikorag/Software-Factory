import type { Context } from "../app/context.js";
import type { ProjectConfig } from "../config/schema.js";
import { createGhClient } from "../github/client.js";
import { checkProject } from "../repo/check.js";
import { ensureClone } from "../repo/clone.js";
import { syncProjects, validateProjects } from "../repo/registry.js";
import { onboardProject, raiseOnboardingPr } from "../speckit/onboard.js";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { git as realGit } from "../repo/git.js";

export type ActionKind = "sync" | "validate" | "check" | "onboard" | "onboard-pr";
export const ACTIONS: Record<ActionKind, string> = {
  sync: "Clone the repository", validate: "Validate the repository", check: "Run the project's commands (sandboxed)",
  onboard: "Add Spec Kit on a local review branch", "onboard-pr": "Add Spec Kit and open a pull request",
};
export type ActionFn = (p: ProjectConfig, log: (l: string) => void) => Promise<boolean>;
export type ProjectActions = Record<ActionKind, ActionFn>;

/** The same operations as the project:* CLI commands, for the settings UI. Nothing here merges anything: onboarding raises a PR for a human. */
export function createProjectActions(ctx: Pick<Context, "config" | "handle" | "runner">): ProjectActions {
  const { config } = ctx;
  const clone = async (p: ProjectConfig, log: (l: string) => void): Promise<boolean> => {
    if (!p.managed) return true;
    const r = await ensureClone(p);
    log(r.status === "error" ? `✗ clone failed: ${r.error}` : `✓ clone ${r.status}${"path" in r ? ` (${r.path})` : ""}`);
    return r.status !== "error";
  };
  const onboard = (pr: boolean): ActionFn => async (p, log) => {
    if (!(await clone(p, log))) return false;
    const r = await onboardProject(p, { runner: ctx.runner, dataDir: config.factory.dataDir });
    log(r.status === "already-initialised" ? "✓ Spec Kit is already set up" : `✓ created branch ${r.branch} (${r.commits.join(", ")})`);
    if (pr && r.status !== "already-initialised") {
      const o = await raiseOnboardingPr(p, { github: createGhClient({ account: p.github.account }), worktree: r.worktree });
      log(`${o.reused ? "PR already open" : "PR raised"}: ${o.pr.url} (not merged: a human reviews and merges it)`);
    }
    return true;
  };
  return {
    sync: async (p, log) => clone(p, log),
    validate: async (p, log) => {
      if (!(await clone(p, log))) return false;
      syncProjects(ctx.handle.db, config.projects.projects);
      // Managed clones are the factory's own, so it may fetch to see a just-merged onboarding PR. A checkout of yours is never touched.
      if (p.managed) await realGit(p.repository, ["fetch", "--quiet", "origin"]).catch(() => { /* offline: validate what we have */ });
      const [r] = await validateProjects(ctx.handle.db, [p]);
      if (!r) return false;
      log(`${r.ok ? "✓" : "✗"} default branch ${r.defaultBranch ?? "?"}, build: ${r.buildSystems.join(", ") || "none"}, protection: ${r.branchProtection.status}`);
      for (const f of r.findings) log(`  ${f.severity} ${f.code}: ${f.message}`);
      return r.ok;
    },
    check: async (p, log) => {
      if (!(await clone(p, log))) return false;
      const report = await checkProject(p, {
        dataDir: config.factory.dataDir, sandbox: config.factory.sandbox, timeoutMs: config.factory.commandTimeoutSeconds * 1000,
        onResult: (r) => log(`${r.ok ? "✓" : "✗"} ${r.kind} (${Math.round(r.durationMs / 1000)}s${r.sandboxed ? "" : ", UNSANDBOXED"}): ${r.command}${r.ok ? "" : `\n${r.tail.slice(-1500)}`}`),
      });
      ctx.handle.db.update(projects).set({ checkJson: JSON.stringify({ ok: report.ok, at: Date.now(), missingTest: report.missingTest }) }).where(eq(projects.id, p.id)).run(); // feeds the project's onboarding status
      if (report.missingTest) log("! no `test` command is set: the factory will not implement changes for this project");
      log(report.ok ? `✓ all configured commands pass on ${report.baseRef}` : "✗ not ready");
      return report.ok;
    },
    onboard: onboard(false),
    "onboard-pr": onboard(true),
  };
}
