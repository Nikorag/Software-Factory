import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRunner } from "../agents/runner.js";
import type { ProjectConfig } from "../config/schema.js";
import { git as realGit, type GitFn } from "../repo/git.js";
import { gitAuthEnv } from "../repo/gh.js";
import { skillPrompt } from "./prompts.js";
import { commitPaths, initSpecKit, isInitialised, type InitDeps } from "./tools.js";

export interface OnboardResult { status: "created" | "already-initialised"; branch: string; worktree: string; commits: string[] }

const CONSTITUTION_PROMPT = [
  "Create this project's constitution from evidence in the repository: README, CLAUDE.md, CONTRIBUTING, architecture docs, CI configuration, lint/test configuration and the code's existing conventions.",
  "Include only principles that are already true for this repository or are directly implied by its tooling; do not invent standards or aspirations. Each principle must be specific and checkable (for example the exact test command that must pass).",
  "If the repository gives no evidence for a section, say so briefly rather than filling it with generic advice.",
].join(" ");

/**
 * Prepares a reviewable branch that adds Spec Kit (`specify init`, run by the factory) and an evidence-based
 * constitution (written by an agent). It never touches the original checkout, never overwrites an existing
 * `.specify/`, and does not push: the constitution is project policy and must be reviewed by a human first.
 */
export async function onboardProject(
  project: ProjectConfig,
  d: { runner: AgentRunner; dataDir: string; init?: InitDeps; git?: GitFn; timeoutMs?: number },
): Promise<OnboardResult> {
  const git = d.git ?? realGit;
  const repo = project.repository;
  const branch = "factory/onboard-speckit";
  const worktree = join(d.dataDir, "workspaces", project.id, "_onboard-speckit");

  if (!existsSync(worktree)) {
    mkdirSync(join(d.dataDir, "workspaces", project.id), { recursive: true });
    await git(repo, ["fetch", "--quiet", "origin", project.defaultBranch], { env: await gitAuthEnv(project.github.account), timeoutMs: 120_000 }).catch(() => undefined);
    const base = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${project.defaultBranch}`]).then(() => `origin/${project.defaultBranch}`, () => project.defaultBranch);
    const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
    await git(repo, exists ? ["worktree", "add", worktree, branch] : ["worktree", "add", "-b", branch, worktree, base]);
  }
  // Done already if the default branch had Spec Kit all along, or this branch already carries the constitution commit.
  const ahead = await git(worktree, ["log", "--format=%s", `${project.defaultBranch}..HEAD`]).catch(() => "");
  const baseHadIt = isInitialised(worktree) && ahead === "";
  if (baseHadIt || /add project constitution/.test(ahead)) return { status: "already-initialised", branch, worktree, commits: [] };
  const commits: string[] = [];
  if (!isInitialised(worktree)) {
    await initSpecKit(worktree, d.init);
    if (await commitPaths(worktree, [".specify", ".claude"], "chore: initialise Spec Kit (claude integration)", git)) commits.push("initialise Spec Kit");
  }
  // The boundary check must cover only what the *agent* changes. The factory's own init commit legitimately adds
  // .claude/ and .specify/ (protected paths), so the agent's baseline is the commit it starts from, not the default branch.
  const agentBase = await git(worktree, ["rev-parse", "HEAD"]);
  const r = await d.runner.run({
    task: "specification", role: "spec-writer", cwd: worktree, timeoutMs: d.timeoutMs ?? 15 * 60_000,
    prompt: skillPrompt("constitution", "specs/_unused", CONSTITUTION_PROMPT), baseRef: agentBase,
  });
  if (!r.ok) throw new Error(`constitution step failed (${r.failure}): ${r.error}`);
  if (await commitPaths(worktree, [".specify/memory"], "docs: add project constitution (for review)", git)) commits.push("constitution");
  return { status: "created", branch, worktree, commits };
}
