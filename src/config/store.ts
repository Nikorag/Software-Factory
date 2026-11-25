import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR, ConfigError, homeConfigDir, loadConfig } from "./load.js";
import { ProjectInput, ProjectOverrides, type LoadedConfig } from "./schema.js";

const FILES = ["factory.yaml", "linear.yaml", "models.yaml", "workflows.yaml", "projects.yaml"];

/**
 * The settings UI edits the user's own copy of the config, never the shipped defaults. The first edit seeds it from the defaults.
 * Edits go through the `yaml` Document API so comments and ordering in a hand-edited file survive.
 */
export function seedHomeConfig(dir = homeConfigDir(), from = BUNDLED_CONFIG_DIR): string {
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) if (!existsSync(join(dir, f)) && existsSync(join(from, f))) copyFileSync(join(from, f), join(dir, f));
  return dir;
}

/** What the settings UI may set on a project. Never accepts secrets: there are no such fields. */
export const ProjectSettings = z.object({
  id: ProjectInput.shape.id,
  name: z.string().min(1).max(100),
  repository: z.string().max(500).optional(),
  defaultBranch: z.string().min(1).max(100).default("main"),
  enabled: z.boolean().default(true),
  autonomy: ProjectInput.shape.autonomy,
  linear: z.object({ teamKey: z.string().min(1), projectName: z.string().optional() }).optional(),
  github: z.object({ account: z.string().optional(), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional() }).default({}),
  overrides: ProjectOverrides.optional(),
  commands: z.object({ install: z.string().max(500).optional(), build: z.string().max(500).optional(), test: z.string().max(500).optional(), lint: z.string().max(500).optional(), typecheck: z.string().max(500).optional() }).default({}),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** Drops unset, empty and empty-object values at any depth, so a project with no overrides writes no `overrides:` block at all. */
const deepClean = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(deepClean);
  if (v && typeof v === "object") {
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepClean(x)]).filter(([, x]) => x !== undefined && x !== "" && !(typeof x === "object" && x !== null && Object.keys(x).length === 0)));
    return Object.keys(o).length ? o : undefined;
  }
  return v;
};
const clean = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "" && !(typeof v === "object" && v !== null && Object.keys(v).length === 0))) as Partial<T>;

function readDoc(dir: string): Document {
  const file = join(dir, "projects.yaml");
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "projects: []\n");
  if (!isMap(doc.contents)) doc.contents = doc.createNode({ projects: [] }) as never;
  if (!doc.has("projects") || !doc.get("projects")) doc.set("projects", doc.createNode([]));
  return doc;
}

/** Writes only if the whole resulting config still loads (duplicate ids, shared repos, shared Linear targets...) - validated on a scratch copy first. */
function commit(dir: string, doc: Document): LoadedConfig {
  const text = doc.toString();
  const scratch = mkdtempSync(join(tmpdir(), "factory-cfg-"));
  try {
    for (const f of FILES) if (existsSync(join(dir, f)) && f !== "projects.yaml") copyFileSync(join(dir, f), join(scratch, f));
    writeFileSync(join(scratch, "projects.yaml"), text);
    loadConfig(scratch); // throws ConfigError with a readable list
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const file = join(dir, "projects.yaml");
  writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
  renameSync(`${file}.tmp`, file); // atomic: a crash never leaves a half-written projects.yaml
  return loadConfig(dir);
}

export function upsertProject(input: unknown, dir = seedHomeConfig()): LoadedConfig {
  const p = ProjectSettings.parse(input);
  if (!p.repository && !p.github.repo) throw new ConfigError("set a GitHub repo (owner/name) for a factory-managed clone, or the path of an existing checkout");
  const doc = readDoc(dir);
  const list = doc.get("projects", true) as { items: { toJSON(): { id?: string } }[]; set: (i: number, v: unknown) => void; add: (v: unknown) => void };
  if (isSeq(list)) list.flow = false; // an empty `projects: []` is flow style: a project list should read as a normal block list
  const node = doc.createNode(clean({ ...p, linear: p.linear && clean(p.linear), github: clean(p.github), commands: clean(p.commands), overrides: deepClean(p.overrides) }));
  (node as YAMLMap).flow = false;
  const i = list.items.findIndex((x) => x.toJSON().id === p.id);
  if (i >= 0) list.set(i, node); else list.add(node);
  return commit(dir, doc);
}

export function removeProject(id: string, dir = seedHomeConfig()): LoadedConfig {
  const doc = readDoc(dir);
  const list = doc.get("projects", true) as { items: { toJSON(): { id?: string } }[] };
  const i = list.items.findIndex((x) => x.toJSON().id === id);
  if (i < 0) throw new ConfigError(`no such project: ${id}`);
  list.items.splice(i, 1);
  return commit(dir, doc);
}

/** Swap the project list inside the object the running service already holds, so engine, scheduler and server all see the change without a restart. */
export function applyProjects(live: LoadedConfig, fresh: LoadedConfig): void {
  live.projects.projects.splice(0, live.projects.projects.length, ...fresh.projects.projects);
}

// ---- global workflow settings (concurrency, fix-cycle limit, models per task) ----
const Route = z.object({ provider: z.enum(["anthropic", "local"]), model: z.string().min(1).max(100) });
export const GlobalSettings = z.object({
  githubAccount: z.string().regex(/^[A-Za-z0-9-]{1,39}$/).or(z.literal("")).optional(), // "" = none
  pickupMode: z.enum(["automatic", "manual"]).optional(),
  maxConcurrentJobs: z.number().int().min(1).max(8),
  maxRemediationAttempts: z.number().int().min(0).max(10),
  routes: z.object({ classification: Route, specification: Route, implementation: Route, independent_review: Route, final_review: Route }),
});
export type GlobalSettings = z.infer<typeof GlobalSettings>;

export const globalSettingsOf = (c: LoadedConfig): GlobalSettings => ({ githubAccount: c.factory.githubAccount ?? "", pickupMode: c.factory.pickupMode, maxConcurrentJobs: c.factory.maxConcurrentJobs, maxRemediationAttempts: c.factory.maxRemediationAttempts, routes: c.models.routes });

/** Writes factory.yaml and models.yaml (comments preserved) only if the resulting config loads; both files or neither. */
export function updateGlobalSettings(input: unknown, dir = seedHomeConfig()): LoadedConfig {
  const g = GlobalSettings.parse(input);
  const read = (f: string) => parseDocument(existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "{}\n");
  const factory = read("factory.yaml"), models = read("models.yaml");
  if (!isMap(factory.contents)) factory.contents = factory.createNode({}) as never;
  factory.set("maxConcurrentJobs", g.maxConcurrentJobs);
  if (g.pickupMode) factory.set("pickupMode", g.pickupMode);
  factory.set("maxRemediationAttempts", g.maxRemediationAttempts);
  if (g.githubAccount) factory.set("githubAccount", g.githubAccount); else if (g.githubAccount === "") factory.delete("githubAccount");
  for (const [task, route] of Object.entries(g.routes)) {
    const node = models.createNode(route) as YAMLMap; node.flow = true;
    models.setIn(["routes", task], node);
  }
  const scratch = mkdtempSync(join(tmpdir(), "factory-cfg-"));
  try {
    for (const f of FILES) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(scratch, f));
    writeFileSync(join(scratch, "factory.yaml"), factory.toString()); writeFileSync(join(scratch, "models.yaml"), models.toString());
    loadConfig(scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  for (const [f, doc] of [["factory.yaml", factory], ["models.yaml", models]] as const) { writeFileSync(join(dir, `${f}.tmp`), doc.toString()); renameSync(join(dir, `${f}.tmp`), join(dir, f)); }
  return loadConfig(dir);
}

/** Apply new global settings to the config object the running service holds (the engine and router read it live). */
export function applyGlobal(live: LoadedConfig, fresh: LoadedConfig): void {
  live.factory.maxConcurrentJobs = fresh.factory.maxConcurrentJobs;
  live.factory.maxRemediationAttempts = fresh.factory.maxRemediationAttempts;
  live.factory.githubAccount = fresh.factory.githubAccount;
  live.factory.pickupMode = fresh.factory.pickupMode;
  applyProjects(live, fresh); // projects that follow the profile's default GitHub account pick up the change
  Object.assign(live.models.routes, fresh.models.routes);
}
