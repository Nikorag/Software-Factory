import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR, ConfigError, homeConfigDir, loadConfig } from "./load.js";
import { ProjectInput, type LoadedConfig } from "./schema.js";

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
  commands: z.object({ install: z.string().max(500).optional(), build: z.string().max(500).optional(), test: z.string().max(500).optional(), lint: z.string().max(500).optional(), typecheck: z.string().max(500).optional() }).default({}),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

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
  const node = doc.createNode(clean({ ...p, linear: p.linear && clean(p.linear), github: clean(p.github), commands: clean(p.commands) }));
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
