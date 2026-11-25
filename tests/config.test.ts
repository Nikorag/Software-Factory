import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/load.js";

const MODELS = `routes:
  classification: { provider: local, model: q }
  specification: { provider: anthropic, model: c }
  implementation: { provider: anthropic, model: c }
  independent_review: { provider: local, model: q }
  final_review: { provider: anthropic, model: c }
`;
function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "factory-cfg-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}

describe("loadConfig", () => {
  it("loads the repository's shipped config", () => {
    const c = loadConfig("config");
    expect(c.factory.maxRemediationAttempts).toBe(3);
    expect(c.factory.server.host).toBe("127.0.0.1");
  });
  it("applies defaults and expands ~", () => {
    const c = loadConfig(dir({ "models.yaml": MODELS }));
    expect(c.factory.dataDir.startsWith("~")).toBe(false);
    expect(c.factory.maxConcurrentJobs).toBe(1);
  });
  it("requires models.yaml", () => {
    expect(() => loadConfig(dir({}))).toThrow(/Missing required/);
  });
  it("rejects non-loopback server hosts", () => {
    expect(() => loadConfig(dir({ "models.yaml": MODELS, "factory.yaml": "server: { host: 0.0.0.0 }" }))).toThrow(ConfigError);
  });
  it("rejects secrets embedded in config", () => {
    expect(() => loadConfig(dir({ "models.yaml": MODELS, "factory.yaml": "linear: { apiKey: lin_abc }" }))).toThrow(/secret/);
  });
  it("rejects duplicate project ids", () => {
    const p = "projects:\n  - { id: a, name: A, repository: /x }\n  - { id: a, name: B, repository: /y }";
    expect(() => loadConfig(dir({ "models.yaml": MODELS, "projects.yaml": p }))).toThrow(/duplicate/);
  });
});
