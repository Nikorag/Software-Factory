import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "../config/schema.js";
import { expandHome } from "../config/load.js";
import { git as realGit, type GitFn } from "./git.js";
import { ghEnv, GhAccountError } from "./gh.js";

const exec = promisify(execFile);

export type Severity = "error" | "warn" | "info";
export interface Finding { severity: Severity; code: string; message: string }
export type Protection = { status: "protected"; requiredChecks: string[]; requiresReviews: boolean } | { status: "unprotected" } | { status: "unavailable"; reason: string } | { status: "unknown"; reason: string };

export interface RepoReport {
  projectId: string;
  path: string;
  ok: boolean; // no error-severity findings
  isGitRepo: boolean;
  clean: boolean | null;
  currentBranch: string | null;
  defaultBranch: string | null;
  remote: { url: string; github: { owner: string; repo: string } | null } | null;
  hasClaudeMd: boolean;
  hasSpecKit: boolean; // Spec Kit is on the default branch (as pushed to origin): what jobs will actually start from
  onboardingBranchPushed?: boolean; // the factory/onboard-speckit branch exists on origin: its pull request is waiting to be merged
  hasSubmodules: boolean;
  buildSystems: string[];
  detectedCommands: { test?: string; lint?: string; typecheck?: string };
  ciWorkflows: string[];
  branchProtection: Protection;
  findings: Finding[];
}

/** Read-only GitHub API access. Injected so tests never touch the network. */
export type GhApi = (path: string) => Promise<{ status: number; body: unknown }>;

/** Read-only GitHub API access via gh, as the project's configured account (or gh's active login). */
export const createGhApi = (account?: string): GhApi => async (path) => {
  try {
    const { stdout } = await exec("gh", ["api", path], { timeout: 20_000, env: await ghEnv(account) });
    return { status: 200, body: JSON.parse(stdout) };
  } catch (e) {
    if (e instanceof GhAccountError) return { status: 0, body: e.message };
    const msg = ((e as { stderr?: string }).stderr ?? "") + String((e as Error).message);
    const m = /HTTP (\d{3})/.exec(msg);
    return { status: m ? Number(m[1]) : 0, body: msg };
  }
};

/** Strips credentials from URLs and extracts the GitHub owner/repo. */
export function parseRemote(raw: string): { url: string; github: { owner: string; repo: string } | null } {
  const url = raw.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com(?:-[\w.-]+)?:|ssh:\/\/git@github\.com(?:-[\w.-]+)?\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return { url, github: m ? { owner: m[1]!, repo: m[2]! } : null };
}

function detectBuild(dir: string): { systems: string[]; commands: RepoReport["detectedCommands"] } {
  const systems: string[] = [];
  const commands: RepoReport["detectedCommands"] = {};
  const has = (f: string) => existsSync(join(dir, f));
  if (has("package.json")) {
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    systems.push(`node(${pm})`);
    try {
      const scripts = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      const run = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
      if (scripts.test && !/no test specified/.test(scripts.test)) commands.test = pm === "npm" ? "npm test" : `${pm} test`;
      if (scripts.lint) commands.lint = run("lint");
      const tc = ["typecheck", "type-check", "tsc"].find((s) => scripts[s]);
      if (tc) commands.typecheck = run(tc);
    } catch { /* malformed package.json: reported by absence of commands */ }
  }
  if (has("Cargo.toml")) { systems.push("cargo"); commands.test ??= "cargo test"; commands.lint ??= "cargo clippy"; }
  if (has("go.mod")) { systems.push("go"); commands.test ??= "go test ./..."; commands.lint ??= "go vet ./..."; }
  if (has("pyproject.toml") || has("requirements.txt")) systems.push("python");
  if (has("Package.swift")) { systems.push("swift"); commands.test ??= "swift test"; }
  if (has("Makefile")) systems.push("make");
  return { systems, commands };
}

export async function checkBranchProtection(remote: { owner: string; repo: string } | null, branch: string, gh: GhApi): Promise<Protection> {
  if (!remote) return { status: "unknown", reason: "no GitHub remote" };
  // GitHub answers 404 for "no protection" AND for "repo invisible to this account". Disambiguate first.
  const repoRes = await gh(`repos/${remote.owner}/${remote.repo}`);
  if (repoRes.status !== 200) {
    return { status: "unknown", reason: `repo ${remote.owner}/${remote.repo} is not accessible to the active gh account (HTTP ${repoRes.status || "no response"}); run \`gh auth switch\`` };
  }
  const res = await gh(`repos/${remote.owner}/${remote.repo}/branches/${encodeURIComponent(branch)}/protection`);
  if (res.status === 200) {
    const b = res.body as { required_status_checks?: { contexts?: string[]; checks?: { context: string }[] }; required_pull_request_reviews?: unknown };
    const checks = [...(b.required_status_checks?.contexts ?? []), ...(b.required_status_checks?.checks?.map((c) => c.context) ?? [])];
    return { status: "protected", requiredChecks: [...new Set(checks)], requiresReviews: Boolean(b.required_pull_request_reviews) };
  }
  if (res.status === 404) return { status: "unprotected" };
  if (res.status === 403 && /upgrade to github pro|make this repository public/i.test(String(typeof res.body === "string" ? res.body : JSON.stringify(res.body)))) {
    return { status: "unavailable", reason: "GitHub plan does not offer branch protection for private repositories" };
  }
  return { status: "unknown", reason: `GitHub API returned ${res.status || "no response"} (private repo on a free plan, or insufficient access)` };
}

export async function inspectRepository(project: ProjectConfig, deps: { git?: GitFn; gh?: GhApi } = {}): Promise<RepoReport> {
  const git = deps.git ?? realGit;
  const gh = deps.gh ?? createGhApi(project.github.account);
  const path = expandHome(project.repository);
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, message: string) => findings.push({ severity, code, message });
  const report: RepoReport = {
    projectId: project.id, path, ok: false, isGitRepo: false, clean: null, currentBranch: null, defaultBranch: null, remote: null,
    hasClaudeMd: false, hasSpecKit: false, hasSubmodules: false, buildSystems: [], detectedCommands: {}, ciWorkflows: [],
    branchProtection: { status: "unknown", reason: "not checked" }, findings,
  };

  if (!existsSync(path)) { add("error", "path-missing", `Repository path does not exist: ${path}`); return report; }
  try {
    const top = await git(path, ["rev-parse", "--show-toplevel"]);
    report.isGitRepo = true;
    report.path = top;
  } catch { add("error", "not-a-git-repo", `${path} is not a git repository`); return report; }
  const root = report.path;

  report.clean = (await git(root, ["status", "--porcelain"])).length === 0;
  if (!report.clean) add("warn", "dirty-checkout", "Checkout has uncommitted changes (the factory never touches it, but it may be stale)");
  report.currentBranch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);

  const originHead = await git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => null);
  report.defaultBranch = originHead ? originHead.replace(/^origin\//, "") : report.currentBranch;
  if (report.defaultBranch && report.defaultBranch !== project.defaultBranch) {
    add("warn", "default-branch-mismatch", `Configured default branch "${project.defaultBranch}" differs from detected "${report.defaultBranch}"`);
  }
  const hasBranch = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${project.defaultBranch}`]).then(() => true, () => false)
    || await git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${project.defaultBranch}`]).then(() => true, () => false);
  if (!hasBranch) add("error", "default-branch-missing", `Default branch "${project.defaultBranch}" does not exist locally or on origin`);

  const remoteRaw = await git(root, ["remote", "get-url", "origin"]).catch(() => null);
  if (remoteRaw) report.remote = parseRemote(remoteRaw);
  if (!report.remote) add("error", "no-remote", "No 'origin' remote: pull requests cannot be created");
  else if (!report.remote.github) add("error", "not-github", "Origin is not a GitHub repository");

  report.hasClaudeMd = existsSync(join(root, "CLAUDE.md"));
  // Judged on origin's default branch, not the working tree: a stale local checkout once made a fully onboarded repository look un-onboarded.
  const onOrigin = await git(root, ["cat-file", "-e", `refs/remotes/origin/${project.defaultBranch}:.specify`]).then(() => true, () => false);
  report.hasSpecKit = onOrigin || existsSync(join(root, ".specify"));
  report.onboardingBranchPushed = await git(root, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/factory/onboard-speckit"]).then(() => true, () => false);
  report.hasSubmodules = existsSync(join(root, ".gitmodules"));
  if (!report.hasClaudeMd) add("info", "no-claude-md", "No CLAUDE.md: agents will have no project instructions (onboarding should propose one, never overwrite)");
  if (project.specKit && !report.hasSpecKit) add("warn", "no-speckit", "specKit is enabled but .specify/ is missing; it must be initialised during onboarding");
  if (report.hasSubmodules) add("info", "submodules", "Repository uses submodules; worktrees will initialise them");

  const build = detectBuild(root);
  report.buildSystems = build.systems;
  report.detectedCommands = build.commands;
  for (const k of ["test", "lint", "typecheck"] as const) {
    if (!project.commands[k]) {
      const d = build.commands[k];
      add(k === "test" ? "warn" : "info", `no-${k}-command`, d ? `No ${k} command configured; detected candidate: ${d}` : `No ${k} command configured or detected`);
    }
  }

  const wfDir = join(root, ".github", "workflows");
  report.ciWorkflows = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (report.ciWorkflows.length === 0) add("warn", "no-ci", "No GitHub Actions workflows found: no CI signal before merging");

  if (project.github.account && report.remote?.github && report.remote.github.owner.toLowerCase() !== project.github.account.toLowerCase()) {
    add("info", "owner-differs-from-account", `Repository owner "${report.remote.github.owner}" differs from gh account "${project.github.account}" (fine for organisation repos)`);
  }
  report.branchProtection = await checkBranchProtection(report.remote?.github ?? null, project.defaultBranch, gh);
  const bp = report.branchProtection;
  if (project.autonomy === "full") {
    if (bp.status === "unprotected") add("error", "no-branch-protection", "Full autonomy requires branch protection on the default branch");
    else if (bp.status === "protected" && bp.requiredChecks.length === 0) add("error", "no-required-checks", "Full autonomy requires at least one required status check");
    else if (bp.status === "unavailable") add("warn", "protection-unavailable", `${bp.reason}. GitHub cannot enforce required checks here, so auto-merge is refused until you upgrade the plan, make the repo public, or explicitly accept factory-side enforcement`);
    else if (bp.status === "unknown") add("warn", "protection-unverified", `Could not verify branch protection (${bp.reason}); auto-merge will be refused until verified`);
  }

  report.ok = !findings.some((f) => f.severity === "error");
  return report;
}
