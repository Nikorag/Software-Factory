import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { BitbucketConfig, BUILTIN_TRACKER_IDS, connectionNames, FactoryConfig, GithubIssuesConfig, JiraConfig, LinearConfig, ModelsConfig, ProjectsConfig, ProjectsFile, TrackersFile, WorkflowsConfig, type LoadedConfig, type TrackerConnection } from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// Secrets must come from the environment. Reject config files that embed them.
const SECRET_KEY = /(api[_-]?key|token|secret|password)$/i;
export function assertNoSecrets(value: unknown, file: string, path = ""): void {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && typeof v === "string" && v.length > 0) {
        throw new ConfigError(`${file}: "${path}${k}" looks like a secret. Supply secrets via environment variables, not config files.`);
      }
      assertNoSecrets(v, file, `${path}${k}.`);
    }
  }
}

function readYaml<T extends z.ZodType>(dir: string, name: string, schema: T, required: boolean): z.infer<T> {
  let file = join(dir, name);
  // A user's own config dir only needs the files they changed: anything else comes from the shipped defaults.
  if (!existsSync(file) && existsSync(join(BUNDLED_CONFIG_DIR, name)) && resolve(dir) === resolve(homeConfigDir())) file = join(BUNDLED_CONFIG_DIR, name);
  if (!existsSync(file)) {
    if (required) throw new ConfigError(`Missing required config file: ${file}`);
    return schema.parse({});
  }
  const raw: unknown = parse(readFileSync(file, "utf8")) ?? {};
  assertNoSecrets(raw, name);
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid ${name}:\n${issues}`);
  }
  return result.data;
}

/** The factory's own code (the install dir). Never allowed as a project: a job must not be able to modify the factory. */
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
/** Defaults shipped with the code: generic, no projects. Read-only; user settings live in the home config dir. */
export const BUNDLED_CONFIG_DIR = join(PACKAGE_ROOT, "config");
export const factoryHome = () => expandHome(process.env.FACTORY_HOME ?? "~/.software-factory");
export const homeConfigDir = () => join(factoryHome(), "config");

/** FACTORY_CONFIG_DIR, else the user's config in the home dir once it exists (the wizard/settings create it), else the shipped defaults. */
export function defaultConfigDir(): string {
  if (process.env.FACTORY_CONFIG_DIR) return process.env.FACTORY_CONFIG_DIR;
  const home = homeConfigDir();
  return ["factory.yaml", "projects.yaml", "linear.yaml", "models.yaml"].some((f) => existsSync(join(home, f))) ? home : BUNDLED_CONFIG_DIR;
}

export function loadConfig(configDir = defaultConfigDir()): LoadedConfig {
  const dir = resolve(configDir);
  const factory = readYaml(dir, "factory.yaml", FactoryConfig, false);
  const models = readYaml(dir, "models.yaml", ModelsConfig, true);
  const projectsFile = readYaml(dir, "projects.yaml", ProjectsFile, false);
  // The default data dir follows FACTORY_HOME (a second install, or a test, must never share the real one).
  if (process.env.FACTORY_HOME && factory.dataDir === "~/.software-factory") factory.dataDir = factoryHome();
  const dataDir = expandHome(factory.dataDir);
  const projects = ProjectsConfig.parse({
    projects: projectsFile.projects.map((p) => ({
      ...p,
      github: { ...p.github, account: p.github.account ?? factory.githubAccount },
      managed: !p.repository,
      repository: p.repository ? expandHome(p.repository) : join(dataDir, "projects", p.id),
    })),
  });
  const workflows = readYaml(dir, "workflows.yaml", WorkflowsConfig, false);
  const jira = readYaml(dir, "jira.yaml", JiraConfig, false);
  const bitbucket = readYaml(dir, "bitbucket.yaml", BitbucketConfig, false);
  const githubIssues = readYaml(dir, "github-issues.yaml", GithubIssuesConfig, false);
  const linearFile = readYaml(dir, "linear.yaml", LinearConfig, false);
  // The built-in connections are the three legacy files; any others are named in trackers.yaml. A profile may use any of them, per project.
  const extra = readYaml(dir, "trackers.yaml", TrackersFile, false).connections;
  for (const id of Object.keys(extra)) if (BUILTIN_TRACKER_IDS.includes(id)) throw new ConfigError(`trackers.yaml: "${id}" is a built-in tracker (set up in ${id === "linear" ? "linear.yaml" : id === "jira" ? "jira.yaml" : "github-issues.yaml"}); give the new connection another id`);
  const connections: Record<string, TrackerConnection> = { linear: { kind: "linear", ...linearFile }, jira: { kind: "jira", ...jira }, github: { kind: "github", ...githubIssues }, ...extra };
  const credentialOwner = new Map<string, string>();
  for (const [id, c] of Object.entries(connections)) {
    if (c.kind === "github") continue; // gh holds those credentials
    const where = c.kind === "linear" ? `${c.keychainService} / ${c.apiKeyEnv}` : c.keychainService;
    const key = `${c.kind}:${where}`;
    if (credentialOwner.has(key)) throw new ConfigError(`trackers.yaml: "${id}" and "${credentialOwner.get(key)}" would share the same credentials (${where}); each ${c.kind} connection needs its own keychain service${c.kind === "linear" ? " and key variable" : ""}`);
    credentialOwner.set(key, id);
  }
  if (!connections[factory.tracker]) throw new ConfigError(`factory.yaml: tracker "${factory.tracker}" is not a tracker connection (have: ${Object.keys(connections).join(", ")})`);
  for (const p of projects.projects) if (p.tracker && !connections[p.tracker]) throw new ConfigError(`projects.yaml: "${p.id}" uses tracker "${p.tracker}", which is not a tracker connection (have: ${Object.keys(connections).join(", ")})`);
  const linear = connectionNames(connections[factory.tracker]!);

  const ids = new Set<string>();
  const bindings = new Map<string, string>();
  const repos = new Map<string, string>();
  for (const p of projects.projects) {
    if (ids.has(p.id)) throw new ConfigError(`projects.yaml: duplicate project id "${p.id}"`);
    ids.add(p.id);
    const repo = resolve(expandHome(p.repository));
    if (repo === PACKAGE_ROOT || repo === resolve(dir, "..")) throw new ConfigError(`projects.yaml: "${p.id}" is the factory's own repository; the factory must never modify itself through a job`);
    if (repos.has(repo)) throw new ConfigError(`projects.yaml: "${p.id}" and "${repos.get(repo)}" use the same repository (${repo}); repositories must never be shared`);
    repos.set(repo, p.id);
    if (p.linear) {
      // Each tracker project (or team-wide fallback) maps to exactly one repo.
      const key = `${p.tracker ?? factory.tracker}:${p.linear.teamKey}/${(p.linear.projectId ?? p.linear.projectName ?? "*").toLowerCase()}`;
      if (bindings.has(key)) throw new ConfigError(`projects.yaml: "${p.id}" and "${bindings.get(key)}" are bound to the same Linear target (${key}); each Linear project must map to a different repository`);
      bindings.set(key, p.id);
    }
  }
  return { linear, jira, githubIssues, connections, bitbucket, factory: { ...factory, dataDir: expandHome(factory.dataDir) }, models, projects, workflows, configDir: dir };
}
