import type { ProjectConfig } from "../config/schema.js";
import type { RepoReport } from "./inspect.js";

export interface CheckRecord { ok: boolean; at: number; missingTest?: boolean }
export interface OnboardingStep { id: string; label: string; ok: boolean; detail: string }
export interface Onboarding { status: "ready" | "in-progress" | "not-started"; steps: OnboardingStep[] }

/**
 * Is this project onboarded, i.e. will a ticket in it actually get built? Derived from facts about the repository and what the factory has
 * observed (never from a flag someone has to remember to set), so it cannot drift: merge the onboarding PR and the next validation sees it.
 */
export function onboardingOf(project: ProjectConfig, report: RepoReport | null, check: CheckRecord | null): Onboarding {
  const steps: OnboardingStep[] = [
    { id: "repo", label: "Repository reachable", ok: Boolean(report?.isGitRepo && report.remote?.github),
      detail: !report ? "not validated yet: press Validate" : report.isGitRepo ? (report.remote?.github ? `${report.remote.github.owner}/${report.remote.github.repo}` : "origin is not a GitHub repository") : "not cloned yet" },
    { id: "speckit", label: "Spec Kit set up on the default branch", ok: Boolean(report?.hasSpecKit),
      detail: !report ? "unknown until validated" : report.hasSpecKit ? "present" : report.onboardingBranchPushed ? "onboarding pull request is open: merge it, then press Validate" : "press Onboard Spec Kit" },
    { id: "test", label: "Test command configured", ok: Boolean(project.commands.test), detail: project.commands.test ? project.commands.test : "set one in Commands: the factory will not implement changes without it" },
    { id: "linear", label: "Linked to a Linear project", ok: Boolean(project.linear), detail: project.linear ? `${project.linear.teamKey}${project.linear.projectName ? ` / ${project.linear.projectName}` : ""}` : "choose a team and project under Linear" },
    { id: "checks", label: "Commands verified", ok: Boolean(check?.ok),
      detail: !check ? "press Run checks to prove the commands work in the sandbox" : check.ok ? `passed ${new Date(check.at).toLocaleDateString()}` : "the last run failed: see Run checks" },
  ];
  const ok = steps.filter((s) => s.ok).length;
  const essential = ["repo", "speckit", "test", "linear"].every((id) => steps.find((s) => s.id === id)!.ok);
  return { steps, status: ok === steps.length ? "ready" : essential || ok > 1 ? "in-progress" : "not-started" };
}
