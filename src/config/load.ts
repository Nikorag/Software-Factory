import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { FactoryConfig, ModelsConfig, ProjectsConfig, WorkflowsConfig, type LoadedConfig } from "./schema.js";

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
  const projects = readYaml(dir, "projects.yaml", ProjectsConfig, false);
  const workflows = readYaml(dir, "workflows.yaml", WorkflowsConfig, false);

  const ids = new Set<string>();
  for (const p of projects.projects) {
    if (ids.has(p.id)) throw new ConfigError(`projects.yaml: duplicate project id "${p.id}"`);
    ids.add(p.id);
  }
  return { factory: { ...factory, dataDir: expandHome(factory.dataDir) }, models, projects, workflows };
}
