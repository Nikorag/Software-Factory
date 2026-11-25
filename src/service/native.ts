import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { PACKAGE_ROOT } from "../config/load.js";
import type { Run } from "./update.js";

/**
 * better-sqlite3 is a native module: it only loads in the Node it was built for. The install records that Node here (bin/factory runs
 * the CLI with it), and when it has to change anyway (the recorded Node was removed, an old launcher used another one) the module is
 * rebuilt for the Node that is running, once, instead of failing on every start.
 */
export const nodeRecordFile = (root = PACKAGE_ROOT) => join(root, "node_modules", ".factory-node");

/** The Node to record: a stable Homebrew symlink (/opt/homebrew/bin/node) instead of the versioned Cellar path it points to, when it does. */
export function stableNodePath(execPath = process.execPath, candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]): string {
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  const target = real(execPath);
  for (const c of candidates) if (target && existsSync(c) && real(c) === target) return c;
  return execPath;
}

export function recordNode(root = PACKAGE_ROOT, node = stableNodePath()): void {
  if (!existsSync(join(root, "node_modules"))) return;
  writeFileSync(nodeRecordFile(root), `${node}\n`);
}

/** "was compiled against a different Node.js version … NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137." */
export const isAbiMismatch = (e: unknown): boolean => /NODE_MODULE_VERSION|compiled against a different Node\.js version/.test(String((e as Error | undefined)?.message ?? e));

/** PATH with the given Node's directory first, so pnpm and the build scripts it runs target that Node. */
export const pathFor = (node: string, path = process.env.PATH ?? "") => [dirname(node), path].filter(Boolean).join(delimiter);

const PROBE = "new (require('better-sqlite3'))(':memory:').close()";

/**
 * For `update`: after installing dependencies, make sure the native module loads in `node` (the Node the service will run on), rebuilding it
 * if it was built for another one. Throws if it still does not load.
 */
export async function ensureNativeModules(o: { root: string; run: Run; node?: string; log?: (l: string) => void }): Promise<"ok" | "rebuilt"> {
  const node = o.node ?? process.execPath;
  const probe = () => o.run(node, ["-e", PROBE], o.root);
  try { await probe(); return "ok"; } catch (e) {
    if (!isAbiMismatch(e)) throw e;
  }
  o.log?.(`rebuilding better-sqlite3 for Node ${node}…`);
  await o.run("pnpm", ["rebuild", "better-sqlite3"], o.root);
  await probe();
  return "rebuilt";
}

export interface StartupRepair { load?: () => void; rebuild?: (root: string) => void; root?: string; log?: (l: string) => void }

/**
 * At CLI startup (before anything opens the database): if better-sqlite3 was built for a different Node, rebuild it for this one and
 * record it. Returns "rebuilt" when the caller must start again in a fresh process (a native module that failed to load cannot be
 * reloaded in the same one). Any other load error is left for the real use to report.
 */
export function repairNativeModules(o: StartupRepair = {}): "ok" | "rebuilt" {
  const root = o.root ?? PACKAGE_ROOT;
  const load = o.load ?? (() => { const D = createRequire(import.meta.url)("better-sqlite3") as new (f: string) => { close(): void }; new D(":memory:").close(); });
  try { load(); return "ok"; } catch (e) {
    if (!isAbiMismatch(e)) return "ok";
  }
  const log = o.log ?? ((l: string) => console.error(l));
  log(`software-factory: the SQLite module was built for a different Node.js than this one (${process.version}, ${process.execPath}). Rebuilding it once…`);
  const rebuild = o.rebuild ?? ((r: string) => { execFileSync("pnpm", ["rebuild", "better-sqlite3"], { cwd: r, stdio: ["ignore", 2, 2], env: { ...process.env, PATH: pathFor(process.execPath) }, timeout: 600_000 }); });
  try { rebuild(root); } catch (e) {
    throw new Error(`the SQLite module (better-sqlite3) does not match Node ${process.version} and rebuilding it failed (${(e as Error).message.split("\n")[0]}). Fix it with:  pnpm --dir "${root}" rebuild better-sqlite3`);
  }
  try { recordNode(root); } catch { /* best effort: bin/factory falls back to node on PATH */ }
  return "rebuilt";
}
