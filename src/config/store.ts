import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR, ConfigError, homeConfigDir, loadConfig } from "./load.js";
import { BUILTIN_TRACKER_IDS, GithubIssuesConfig, JIRA_LABEL_KEYS, JIRA_STATUS_KEYS, KIND_NAME, ProjectInput, TrackerId, TrackerKind, ProjectOverrides, type LoadedConfig } from "./schema.js";

const FILES = ["factory.yaml", "linear.yaml", "models.yaml", "workflows.yaml", "projects.yaml"];
/** Files that describe tracker connections: every validation copy needs them, or a project naming one would look unknown. */
const TRACKER_FILES = ["jira.yaml", "github-issues.yaml", "trackers.yaml"];

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
  tracker: TrackerId.optional(),
  linear: z.object({ teamKey: z.string().min(1), projectName: z.string().optional(), projectId: z.string().optional() }).optional(),
  host: z.enum(["github", "bitbucket"]).default("github"),
  github: z.object({ account: z.string().optional(), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional() }).default({}),
  bitbucket: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(), credential: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional() }).default({}),
  overrides: ProjectOverrides.optional(),
  specKit: z.boolean().optional(), // run the SpecKit specification workflow for this project (default true)
  allowLoopback: z.boolean().optional(), // sandbox: let test/lint/build commands use TCP on this machine only
  agentBashAllow: z.array(z.string().max(200)).max(50).optional(), // extra shell prefixes for the restricted implementer (edited in projects.yaml)
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
    for (const f of [...FILES, ...TRACKER_FILES]) if (existsSync(join(dir, f)) && f !== "projects.yaml") copyFileSync(join(dir, f), join(scratch, f));
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
  if (!p.repository && !(p.host === "bitbucket" ? p.bitbucket.repo : p.github.repo)) throw new ConfigError(`set a ${p.host === "bitbucket" ? "Bitbucket" : "GitHub"} repo (${p.host === "bitbucket" ? "workspace/slug" : "owner/name"}) for a factory-managed clone, or the path of an existing checkout`);
  const doc = readDoc(dir);
  const list = doc.get("projects", true) as { items: { toJSON(): { id?: string } }[]; set: (i: number, v: unknown) => void; add: (v: unknown) => void };
  if (isSeq(list)) list.flow = false; // an empty `projects: []` is flow style: a project list should read as a normal block list
  const at = list.items.findIndex((x) => x.toJSON().id === p.id);
  // Fields the form does not edit survive a save: an absent value keeps what the file already has.
  const before = at >= 0 ? (list.items[at]!.toJSON() as { allowLoopback?: boolean; agentBashAllow?: string[] }) : {};
  const keep = { allowLoopback: p.allowLoopback ?? before.allowLoopback, agentBashAllow: p.agentBashAllow ?? before.agentBashAllow };
  const node = doc.createNode(clean({ ...p, specKit: p.specKit === false ? false : undefined, allowLoopback: keep.allowLoopback || undefined, agentBashAllow: keep.agentBashAllow, linear: p.linear && clean(p.linear), host: p.host === "bitbucket" ? "bitbucket" : undefined, github: clean(p.github), bitbucket: clean(p.bitbucket), commands: clean(p.commands), overrides: deepClean(p.overrides) }));
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
  maxImplementationPasses: z.number().int().min(1).max(10).optional(),
  planningMode: z.enum(["haiku_prompt", "speckit"]).optional(),
  routes: z.object({ classification: Route, specification: Route, implementation: Route, independent_review: Route, final_review: Route, prompt_generation: Route.optional() }),
});
export type GlobalSettings = z.infer<typeof GlobalSettings>;

export const globalSettingsOf = (c: LoadedConfig): GlobalSettings => ({ githubAccount: c.factory.githubAccount ?? "", pickupMode: c.factory.pickupMode, maxConcurrentJobs: c.factory.maxConcurrentJobs, maxRemediationAttempts: c.factory.maxRemediationAttempts, maxImplementationPasses: c.factory.maxImplementationPasses, planningMode: c.factory.workflow.planning_mode, routes: c.models.routes });

/** Writes factory.yaml and models.yaml (comments preserved) only if the resulting config loads; both files or neither. */
export function updateGlobalSettings(input: unknown, dir = seedHomeConfig()): LoadedConfig {
  const g = GlobalSettings.parse(input);
  const read = (f: string) => parseDocument(existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "{}\n");
  const factory = read("factory.yaml"), models = read("models.yaml");
  if (!isMap(factory.contents)) factory.contents = factory.createNode({}) as never;
  factory.set("maxConcurrentJobs", g.maxConcurrentJobs);
  if (g.pickupMode) factory.set("pickupMode", g.pickupMode);
  factory.set("maxRemediationAttempts", g.maxRemediationAttempts);
  if (g.maxImplementationPasses) factory.set("maxImplementationPasses", g.maxImplementationPasses);
  if (g.planningMode) factory.setIn(["workflow", "planning_mode"], g.planningMode);
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
  live.factory.maxImplementationPasses = fresh.factory.maxImplementationPasses;
  live.factory.githubAccount = fresh.factory.githubAccount;
  live.factory.pickupMode = fresh.factory.pickupMode;
  live.factory.workflow.planning_mode = fresh.factory.workflow.planning_mode; // the next stage of every job follows it
  applyProjects(live, fresh); // projects that follow the profile's default GitHub account pick up the change
  Object.assign(live.models.routes, fresh.models.routes);
}

// ---- tracker: which one this profile uses, and the Jira connection and mapping ----
const editYaml = (dir: string, file: string, edit: (doc: Document) => void): void => {
  const f = join(dir, file);
  const doc = parseDocument(existsSync(f) ? readFileSync(f, "utf8") : "{}\n");
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  edit(doc);
  const scratch = mkdtempSync(join(tmpdir(), "factory-cfg-"));
  try {
    for (const x of FILES.concat(TRACKER_FILES)) if (existsSync(join(dir, x))) copyFileSync(join(dir, x), join(scratch, x));
    writeFileSync(join(scratch, file), doc.toString());
    loadConfig(scratch); // refuse anything that would leave the config unloadable
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  writeFileSync(`${f}.tmp`, doc.toString()); renameSync(`${f}.tmp`, f);
};

/** Chooses the profile's DEFAULT tracker connection (by id). Projects that name no tracker of their own follow it. */
export function updateTracker(id: string, dir = seedHomeConfig()): LoadedConfig {
  editYaml(dir, "factory.yaml", (d) => { d.set("tracker", id); }); // loadConfig refuses an id that is not a connection
  return loadConfig(dir);
}

/** Where a connection's settings live: the built-in three in their own files (so existing setups keep working), the rest in trackers.yaml. */
const LEGACY_FILE: Record<string, string> = { linear: "linear.yaml", jira: "jira.yaml", github: "github-issues.yaml" };
interface Scope { set(k: string, v: unknown): void; delete(k: string): void; node(v: unknown): unknown }
function editConnection(dir: string, id: string, edit: (s: Scope) => void): void {
  const builtin = BUILTIN_TRACKER_IDS.includes(id);
  editYaml(dir, builtin ? LEGACY_FILE[id]! : "trackers.yaml", (d) => {
    const path = builtin ? [] : ["connections", id];
    if (!builtin && !d.hasIn(path)) throw new ConfigError(`there is no tracker connection "${id}"`);
    edit({ set: (k, v) => d.setIn([...path, k], v), delete: (k) => { d.deleteIn([...path, k]); }, node: (v) => d.createNode(v) });
  });
}

const DEFAULT_KEYCHAIN: Record<string, string> = { linear: "software-factory-linear", jira: "software-factory-jira" };
/** Adds a named tracker connection (a second Jira, a third Linear...). It gets its own keychain entry (and, for Linear, its own key variable) so credentials never mix. */
export function createConnection(input: { id: string; kind: string; label?: string; account?: string }, dir = seedHomeConfig()): LoadedConfig {
  const id = TrackerId.parse(input.id), kind = TrackerKind.parse(input.kind);
  if (BUILTIN_TRACKER_IDS.includes(id)) throw new ConfigError(`"${id}" is a built-in tracker: choose another id`);
  const cur = loadConfig(dir);
  if (cur.connections[id]) throw new ConfigError(`there is already a tracker connection "${id}"`);
  const base = kind === "linear" ? cur.connections.linear : kind === "jira" ? cur.connections.jira : undefined;
  const entry: Record<string, unknown> = { kind, label: input.label?.trim() || `${KIND_NAME[kind]} (${id})` };
  if (kind === "linear") { entry.apiKeyEnv = `LINEAR_API_KEY_${id.toUpperCase().replace(/-/g, "_")}`; entry.keychainService = `${(base as { keychainService: string }).keychainService}-${id}`; }
  if (kind === "jira") entry.keychainService = `${(base as { keychainService: string }).keychainService ?? DEFAULT_KEYCHAIN.jira}-${id}`;
  if (kind === "github" && input.account) entry.account = input.account;
  editYaml(dir, "trackers.yaml", (d) => {
    if (!d.hasIn(["connections"])) d.set("connections", d.createNode({}));
    d.setIn(["connections", id], d.createNode(entry));
  });
  return loadConfig(dir);
}

/** Removes a connection that nothing uses. (Its keychain entries are left alone: delete them in Keychain Access if you want them gone.) */
export function removeConnection(id: string, dir = seedHomeConfig()): LoadedConfig {
  if (BUILTIN_TRACKER_IDS.includes(id)) throw new ConfigError(`"${id}" is a built-in tracker and cannot be removed`);
  const cur = loadConfig(dir);
  if (!cur.connections[id]) throw new ConfigError(`there is no tracker connection "${id}"`);
  if (cur.factory.tracker === id) throw new ConfigError(`"${id}" is the profile's default tracker: choose another default first`);
  const users = cur.projects.projects.filter((p) => p.tracker === id).map((p) => p.id);
  if (users.length) throw new ConfigError(`${users.join(", ")} still use${users.length === 1 ? "s" : ""} "${id}": move them to another tracker first`);
  editYaml(dir, "trackers.yaml", (d) => { d.deleteIn(["connections", id]); });
  return loadConfig(dir);
}

export function renameConnection(id: string, label: string, dir = seedHomeConfig()): LoadedConfig {
  editConnection(dir, id, (s) => s.set("label", label.trim().slice(0, 60)));
  return loadConfig(dir);
}

export const JiraMapping = z.object({
  statuses: z.partialRecord(z.enum(JIRA_STATUS_KEYS), z.string().max(255)).default({}),
  // Jira labels cannot contain spaces
  labels: z.partialRecord(z.enum(JIRA_LABEL_KEYS), z.string().max(255).regex(/^\S*$/, "a Jira label cannot contain spaces")).default({}),
});

export interface JiraPatch { clientId?: string; site?: { cloudId: string; url: string; name: string } | null; mapping?: z.input<typeof JiraMapping> }
/** Writes jira.yaml (comments preserved). The OAuth client secret and tokens are never written here: they live in the keychain. */
export function updateJiraConfig(patch: JiraPatch, dir = seedHomeConfig(), id = "jira"): LoadedConfig {
  const mapping = patch.mapping ? JiraMapping.parse(patch.mapping) : null;
  editConnection(dir, id, (d) => {
    if (patch.clientId !== undefined) d.set("clientId", patch.clientId);
    if (patch.site === null) d.delete("site"); else if (patch.site) d.set("site", d.node(patch.site));
    if (mapping) {
      d.set("statuses", d.node(Object.fromEntries(Object.entries(mapping.statuses).filter(([, v]) => v !== undefined))));
      d.set("labels", d.node(Object.fromEntries(Object.entries(mapping.labels).filter(([, v]) => v !== undefined))));
    }
  });
  return loadConfig(dir);
}

export const GithubIssuesMapping = z.object({
  statusPrefix: z.string().min(1).max(40).optional(),
  statuses: GithubIssuesConfig.shape.statuses.optional(),
  labels: GithubIssuesConfig.shape.labels.optional(),
});
/** Writes github-issues.yaml (comments preserved): the status-label prefix and the names of the factory's statuses and labels. */
export function updateGithubIssuesConfig(patch: z.input<typeof GithubIssuesMapping> & { account?: string | null }, dir = seedHomeConfig(), id = "github"): LoadedConfig {
  const m = GithubIssuesMapping.parse(patch);
  editConnection(dir, id, (d) => {
    if (m.statusPrefix !== undefined) d.set("statusPrefix", m.statusPrefix);
    if (m.statuses) d.set("statuses", d.node(m.statuses));
    if (m.labels) d.set("labels", d.node(m.labels));
    if (patch.account === null) d.delete("account"); else if (patch.account) d.set("account", patch.account);
  });
  return loadConfig(dir);
}

/** Apply a new tracker setup to the config object the running service holds (in place: handlers captured these objects). */
export function applyTracker(live: LoadedConfig, fresh: LoadedConfig): void {
  live.factory.tracker = fresh.factory.tracker;
  live.connections = fresh.connections;
  live.jira = fresh.jira;
  live.githubIssues = fresh.githubIssues;
  Object.assign(live.linear.statuses, fresh.linear.statuses);
  Object.assign(live.linear.labels, fresh.linear.labels);
  live.linear.keychainService = fresh.linear.keychainService;
  live.linear.apiKeyEnv = fresh.linear.apiKeyEnv;
}

// ---- Bitbucket credentials (the token itself is in the keychain; this file only says what kind it is) ----
export const BitbucketCredentialInput = z.object({
  kind: z.enum(["access-token", "api-token"]),
  email: z.string().email().optional(),
  token: z.string().min(8).max(500).optional(), // omitted when only changing the kind or email
}).refine((c) => c.kind !== "api-token" || Boolean(c.email), { message: "an API token needs the Atlassian account email it belongs to" });

export function setBitbucketCredential(name: string, meta: { kind: "access-token" | "api-token"; email?: string }, dir = seedHomeConfig()): LoadedConfig {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new ConfigError("a credential name is lowercase letters, numbers and hyphens");
  editYaml(dir, "bitbucket.yaml", (d) => { d.setIn(["credentials", name], d.createNode(meta.email ? { kind: meta.kind, email: meta.email } : { kind: meta.kind })); });
  return loadConfig(dir);
}
export function removeBitbucketCredential(name: string, dir = seedHomeConfig()): LoadedConfig {
  editYaml(dir, "bitbucket.yaml", (d) => { d.deleteIn(["credentials", name]); });
  return loadConfig(dir);
}
/** Apply to the running config (the host dispatcher reads `config.bitbucket` live). */
export function applyBitbucket(live: LoadedConfig, fresh: LoadedConfig): void {
  live.bitbucket.credentials = fresh.bitbucket.credentials;
  live.bitbucket.keychainService = fresh.bitbucket.keychainService;
}

// ---- advanced factory settings: safety and housekeeping keys of factory.yaml. Local only (never reachable from a hub session). ----
export const AdvancedSettings = z.object({
  agentAccess: z.enum(["restricted", "unrestricted"]),
  dryRun: z.boolean(),
  sandboxRequired: z.boolean(),
  commandTimeoutSeconds: z.number().int().min(10).max(86_400),
  pollIntervalSeconds: z.number().int().min(10).max(86_400),
  logRetentionDays: z.number().int().min(0).max(3650),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]),
  protectedPaths: z.array(z.string().min(1).max(200)).max(200),
});
export type AdvancedSettings = z.infer<typeof AdvancedSettings>;

export const advancedSettingsOf = (c: LoadedConfig): AdvancedSettings => ({
  agentAccess: c.factory.agentAccess, dryRun: c.factory.dryRun, sandboxRequired: c.factory.sandbox.required, commandTimeoutSeconds: c.factory.commandTimeoutSeconds,
  pollIntervalSeconds: c.factory.pollIntervalSeconds, logRetentionDays: c.factory.logRetentionDays, logLevel: c.factory.logLevel, protectedPaths: c.factory.protectedPaths,
});

/** Writes these keys into factory.yaml (comments kept) only if the whole config still loads. They take effect when the factory restarts. */
export function updateAdvancedSettings(input: unknown, dir = seedHomeConfig()): LoadedConfig {
  const a = AdvancedSettings.parse(input);
  const file = join(dir, "factory.yaml");
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "{}\n");
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  doc.set("agentAccess", a.agentAccess); doc.set("dryRun", a.dryRun); doc.setIn(["sandbox", "required"], a.sandboxRequired);
  doc.set("commandTimeoutSeconds", a.commandTimeoutSeconds); doc.set("pollIntervalSeconds", a.pollIntervalSeconds);
  doc.set("logRetentionDays", a.logRetentionDays); doc.set("logLevel", a.logLevel); doc.set("protectedPaths", doc.createNode(a.protectedPaths));
  const scratch = mkdtempSync(join(tmpdir(), "factory-cfg-"));
  try {
    for (const f of FILES) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(scratch, f));
    writeFileSync(join(scratch, "factory.yaml"), doc.toString());
    loadConfig(scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  writeFileSync(`${file}.tmp`, doc.toString()); renameSync(`${file}.tmp`, file);
  return loadConfig(dir);
}
