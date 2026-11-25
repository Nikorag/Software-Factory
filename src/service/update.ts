import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { PACKAGE_ROOT } from "../config/load.js";
import { ensureNativeModules, recordNode } from "./native.js";

const exec = promisify(execFile);
export type Run = (file: string, args: string[], cwd: string) => Promise<string>;
const defaultRun: Run = async (file, args, cwd) => (await exec(file, args, { cwd, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

/** An update that moved the code but did not finish installing what that code needs (dependencies, native module, dashboard). */
export interface PendingUpdate { /** the last commit whose dependencies were fully installed: where a failed update rolls back to */ from: string; fromBranch: string | null; to: string; startedAt: number }

export interface UpdatePlan {
  current: string; currentSha: string; target: string; targetSha: string; targetIsTag: boolean;
  behind: number; upToDate: boolean; dirty: boolean; latestTag: string | null;
  /** set when an earlier update did not finish: `update` finishes it (or rolls it back) even when there are no new commits */
  pending: PendingUpdate | null;
}

const BRANCHES = "+refs/heads/*:refs/remotes/origin/*";

// The marker lives in the git dir, so it never shows up as a local change and survives any checkout.
const markerFile = async (git: (...a: string[]) => Promise<string>) => join(await git("rev-parse", "--absolute-git-dir"), "factory-update.json");
const readMarker = (file: string): PendingUpdate | null => { try { return JSON.parse(readFileSync(file, "utf8")) as PendingUpdate; } catch { return null; } };

/** Where updates come from: the newest release tag (v*) if there is one, else the tip of main. `ref` overrides (a tag, branch, or main). */
export async function planUpdate(opts: { ref?: string; root?: string; run?: Run } = {}): Promise<UpdatePlan> {
  const root = opts.root ?? PACKAGE_ROOT, run = opts.run ?? defaultRun;
  const git = (...a: string[]) => run("git", a, root);
  // An install cloned from a tag (`git clone --branch v0.x`) only fetches that tag: teach it to fetch branches too, so origin/main exists.
  const specs = await git("config", "--get-all", "remote.origin.fetch").catch(() => "");
  if (!specs.split("\n").some((s) => s.replace(/^\+/, "") === BRANCHES.slice(1))) await git("config", "--add", "remote.origin.fetch", BRANCHES);
  await git("fetch", "--tags", "--quiet", "origin");
  const latestTag = (await git("tag", "-l", "v*", "--sort=-v:refname")).split("\n")[0] || null;
  const wanted = opts.ref ?? latestTag ?? "main";
  const isTag = (await git("tag", "-l", wanted)) === wanted;
  const target = isTag ? wanted : `origin/${wanted.replace(/^origin\//, "")}`;
  const currentSha = await git("rev-parse", "HEAD"), targetSha = await git("rev-parse", `${target}^{commit}`);
  const current = (await git("describe", "--tags", "--always").catch(() => currentSha.slice(0, 7)));
  const behind = Number(await git("rev-list", "--count", `HEAD..${target}`));
  const pending = readMarker(await markerFile(git));
  // upToDate = nothing new to bring in: never move sideways or backwards (e.g. a dev checkout ahead of the newest release)
  return { current, currentSha, target: isTag ? wanted : target, targetSha, targetIsTag: isTag, behind, upToDate: behind === 0 && !pending, dirty: (await git("status", "--porcelain")).length > 0, latestTag, pending };
}

export interface ApplyOptions { root?: string; run?: Run; skipBuild?: boolean; log?: (l: string) => void; /** the Node the service runs on (default: this one) */ node?: string }

/**
 * Moves the install to the target, then reinstalls dependencies, checks the native SQLite module loads (rebuilding it for this Node if
 * needed) and rebuilds the dashboard. Refuses to touch an install with local changes and never rewrites history (fast-forward only for
 * branches; a tag is checked out detached). Settings and data live outside the install dir.
 *
 * Retryable: a marker records the update before the code moves and is only cleared once everything is installed, so a failure is never
 * reported as "up to date" later. On failure the code goes back to the last fully installed commit and that commit's dependencies are
 * reinstalled; if even that fails the marker stays and the next `update` finishes the job.
 */
export async function applyUpdate(plan: UpdatePlan, opts: ApplyOptions = {}): Promise<void> {
  const root = opts.root ?? PACKAGE_ROOT, run = opts.run ?? defaultRun, log = opts.log ?? (() => {});
  const git = (...a: string[]) => run("git", a, root);
  if (plan.dirty) throw new Error(`${root} has local changes: commit or discard them first (nothing was changed)`);
  const marker = await markerFile(git);
  const fromBranch = plan.pending ? plan.pending.fromBranch : (await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")) || null;
  const from = plan.pending?.from ?? plan.currentSha;
  const mark = () => writeFileSync(marker, JSON.stringify({ from, fromBranch, to: plan.targetSha, startedAt: Date.now() } satisfies PendingUpdate));
  mark();

  if (plan.behind > 0) {
    if (plan.targetIsTag) await git("checkout", "--quiet", "--detach", plan.target);
    else {
      const branch = plan.target.replace(/^origin\//, "");
      await git("checkout", "--quiet", branch);
      await git("merge", "--ff-only", "--quiet", plan.target).catch(() => { throw new Error(`${branch} has diverged from ${plan.target}: it cannot be fast-forwarded. Resolve that by hand (nothing was overwritten)`); });
    }
  }
  if (opts.skipBuild) { rmSync(marker, { force: true }); return; }

  const install = async () => {
    log("installing dependencies…");
    await run("pnpm", ["install", "--frozen-lockfile", "--silent"], root);
    await ensureNativeModules({ root, run, node: opts.node, log });
    log("building the dashboard…");
    await run("pnpm", ["web:build"], root);
    recordNode(root, opts.node);
  };
  try {
    await install();
    rmSync(marker, { force: true });
  } catch (e) {
    const why = firstLine(e);
    if ((await git("rev-parse", "HEAD")) === from) throw new Error(`could not install the dependencies (${why}). Run \`software-factory update\` again to retry.`);
    log(`the update failed (${why}): rolling back to ${from.slice(0, 7)}…`);
    if (fromBranch) await git("checkout", "--quiet", "-B", fromBranch, from);
    else await git("checkout", "--quiet", "--detach", from);
    try { await install(); } catch (e2) {
      mark(); // HEAD is back at `from` but its dependencies are not installed: the next update installs them (or moves forward)
      throw new Error(`the update failed (${why}) and reinstalling the previous version failed too (${firstLine(e2)}). Run \`software-factory update\` again to retry.`);
    }
    rmSync(marker, { force: true });
    throw new Error(`the update failed and was rolled back to ${from.slice(0, 7)} (${why}). Run \`software-factory update\` to try again.`);
  }
}

/** One line saying why a step failed: the last line of its stderr if it has one (that is where pnpm and git say what went wrong). */
const firstLine = (e: unknown) => {
  const lines = (t: unknown) => String(t ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines((e as { stderr?: unknown })?.stderr).pop() ?? lines((e as Error)?.message ?? e)[0] ?? "unknown error";
};
