import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { FactoryConfig, LinearConfig, ModelsConfig, ProjectsConfig, ProjectsFile, WorkflowsConfig, type LoadedConfig } from "./schema.js";

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
function assertNoSecrets(value: unknown, file: string, path = ""): void {
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
  const file = join(dir, name);
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

export function loadConfig(configDir = process.env.FACTORY_CONFIG_DIR ?? "config"): LoadedConfig {
  const dir = resolve(configDir);
  const factory = readYaml(dir, "factory.yaml", FactoryConfig, false);
  const models = readYaml(dir, "models.yaml", ModelsConfig, true);
  const projectsFile = readYaml(dir, "projects.yaml", ProjectsFile, false);
  const dataDir = expandHome(factory.dataDir);
  const projects = ProjectsConfig.parse({
    projects: projectsFile.projects.map((p) => ({
      ...p,
      managed: !p.repository,
      repository: p.repository ? expandHome(p.repository) : join(dataDir, "projects", p.id),
    })),
  });
  const workflows = readYaml(dir, "workflows.yaml", WorkflowsConfig, false);
  const linear = readYaml(dir, "linear.yaml", LinearConfig, false);

  const ids = new Set<string>();
  const bindings = new Map<string, string>();
  const repos = new Map<string, string>();
  for (const p of projects.projects) {
    if (ids.has(p.id)) throw new ConfigError(`projects.yaml: duplicate project id "${p.id}"`);
    ids.add(p.id);
    const repo = resolve(expandHome(p.repository));
    if (repo === resolve(dir, "..")) throw new ConfigError(`projects.yaml: "${p.id}" is the factory's own repository; the factory must never modify itself through a job`);
    if (repos.has(repo)) throw new ConfigError(`projects.yaml: "${p.id}" and "${repos.get(repo)}" use the same repository (${repo}); repositories must never be shared`);
    repos.set(repo, p.id);
    if (p.linear) {
      // Each Linear project (or team-wide fallback) maps to exactly one repo.
      const key = `${p.linear.teamKey}/${(p.linear.projectId ?? p.linear.projectName ?? "*").toLowerCase()}`;
      if (bindings.has(key)) throw new ConfigError(`projects.yaml: "${p.id}" and "${bindings.get(key)}" are bound to the same Linear target (${key}); each Linear project must map to a different repository`);
      bindings.set(key, p.id);
    }
  }
  return { linear, factory: { ...factory, dataDir: expandHome(factory.dataDir) }, models, projects, workflows };
}
