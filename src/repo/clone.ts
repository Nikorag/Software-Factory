import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectConfig } from "../config/schema.js";
import { git as realGit, type GitFn } from "./git.js";
import { gitAuthEnv } from "./gh.js";
import { parseRemote } from "./inspect.js";
import type { Hosts } from "../host/index.js";

export type CloneOutcome = { status: "cloned" | "present"; path: string } | { status: "skipped"; reason: string } | { status: "error"; error: string };

/**
 * Ensure a factory-managed project has its clone. Never touches an existing checkout, never overwrites a
 * non-empty directory, and refuses a clone whose origin is a different repository than configured.
 */
export async function ensureClone(
  project: ProjectConfig, deps: { git?: GitFn; remoteUrl?: string; authEnv?: NodeJS.ProcessEnv | null; hosts?: Hosts } = {},
): Promise<CloneOutcome> {
  if (!project.managed) return { status: "skipped", reason: "not factory-managed (uses an existing checkout)" };
  const repo = project.host === "bitbucket" ? project.bitbucket.repo : project.github.repo;
  if (!repo) return { status: "error", error: `${project.id}: ${project.host}.repo is required for a managed clone` };
  const git = deps.git ?? realGit;
  const path = project.repository;

  if (existsSync(path) && readdirSync(path).length > 0) {
    const origin = await git(path, ["remote", "get-url", "origin"]).catch(() => null);
    const parsed = origin ? parseRemote(origin) : null;
    const slug = project.host === "bitbucket" ? parsed?.bitbucket : parsed?.github;
    if (slug && `${slug.owner}/${slug.repo}`.toLowerCase() === repo.toLowerCase()) return { status: "present", path };
    return { status: "error", error: `${path} exists but is not a clone of ${repo} (origin: ${origin ?? "none"}); refusing to touch it` };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const env = deps.authEnv === undefined ? (deps.hosts ? await deps.hosts.gitAuth(project) : await gitAuthEnv(project.github.account)) : (deps.authEnv ?? undefined);
    await git(dirname(path), ["clone", "--quiet", deps.remoteUrl ?? (deps.hosts ? deps.hosts.cloneUrl(project) : `https://github.com/${repo}.git`), path], { timeoutMs: 600_000, env });
    return { status: "cloned", path };
  } catch (e) {
    return { status: "error", error: (e as Error).message.replace(/AUTHORIZATION: basic \S+/gi, "AUTHORIZATION: [REDACTED]") };
  }
}
