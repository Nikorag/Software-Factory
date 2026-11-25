import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PACKAGE_ROOT } from "../config/load.js";

const exec = promisify(execFile);
export type Run = (file: string, args: string[], cwd: string) => Promise<string>;
const defaultRun: Run = async (file, args, cwd) => (await exec(file, args, { cwd, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

export interface UpdatePlan {
  current: string; currentSha: string; target: string; targetSha: string; targetIsTag: boolean;
  behind: number; upToDate: boolean; dirty: boolean; latestTag: string | null;
}

/** Where updates come from: the newest release tag (v*) if there is one, else the tip of main. `ref` overrides (a tag, branch, or main). */
export async function planUpdate(opts: { ref?: string; root?: string; run?: Run } = {}): Promise<UpdatePlan> {
  const root = opts.root ?? PACKAGE_ROOT, run = opts.run ?? defaultRun;
  const git = (...a: string[]) => run("git", a, root);
  await git("fetch", "--tags", "--quiet", "origin");
  const latestTag = (await git("tag", "-l", "v*", "--sort=-v:refname")).split("\n")[0] || null;
  const wanted = opts.ref ?? latestTag ?? "main";
  const isTag = (await git("tag", "-l", wanted)) === wanted;
  const target = isTag ? wanted : `origin/${wanted.replace(/^origin\//, "")}`;
  const currentSha = await git("rev-parse", "HEAD"), targetSha = await git("rev-parse", `${target}^{commit}`);
  const current = (await git("describe", "--tags", "--always").catch(() => currentSha.slice(0, 7)));
  const behind = Number(await git("rev-list", "--count", `HEAD..${target}`));
  // upToDate = nothing new to bring in: never move sideways or backwards (e.g. a dev checkout ahead of the newest release)
  return { current, currentSha, target: isTag ? wanted : target, targetSha, targetIsTag: isTag, behind, upToDate: behind === 0, dirty: (await git("status", "--porcelain")).length > 0, latestTag };
}

/**
 * Moves the install to the target, then reinstalls dependencies and rebuilds the dashboard. Refuses to touch an install with local changes
 * and never rewrites history (fast-forward only for branches; a tag is checked out detached). Settings and data live outside the install dir.
 */
export async function applyUpdate(plan: UpdatePlan, opts: { root?: string; run?: Run; skipBuild?: boolean; log?: (l: string) => void } = {}): Promise<void> {
  const root = opts.root ?? PACKAGE_ROOT, run = opts.run ?? defaultRun, log = opts.log ?? (() => {});
  const git = (...a: string[]) => run("git", a, root);
  if (plan.dirty) throw new Error(`${root} has local changes: commit or discard them first (nothing was changed)`);
  if (plan.targetIsTag) await git("checkout", "--quiet", "--detach", plan.target);
  else {
    const branch = plan.target.replace(/^origin\//, "");
    await git("checkout", "--quiet", branch);
    await git("merge", "--ff-only", "--quiet", plan.target).catch(() => { throw new Error(`${branch} has diverged from ${plan.target}: it cannot be fast-forwarded. Resolve that by hand (nothing was overwritten)`); });
  }
  if (opts.skipBuild) return;
  log("installing dependencies…");
  await run("pnpm", ["install", "--frozen-lockfile", "--silent"], root);
  log("building the dashboard…");
  await run("pnpm", ["web:build"], root);
}
