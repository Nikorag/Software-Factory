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

describe("linear config", () => {
  it("fills every status and label default when linear.yaml is absent", () => {
    const c = loadConfig(dir({ "models.yaml": MODELS }));
    expect(c.linear.statuses.readyForSpecification).toBe("Ready for specification");
    expect(c.linear.labels.enabled).toBe("factory:enabled");
    expect(c.linear.apiKeyEnv).toBe("LINEAR_API_KEY");
  });
  it("lets individual names be overridden without losing the rest", () => {
    const c = loadConfig(dir({ "models.yaml": MODELS, "linear.yaml": "statuses: { done: Shipped }" }));
    expect(c.linear.statuses.done).toBe("Shipped");
    expect(c.linear.statuses.blocked).toBe("Blocked");
  });
  it("rejects an embedded api key", () => {
    expect(() => loadConfig(dir({ "models.yaml": MODELS, "linear.yaml": "apiKey: lin_api_x" }))).toThrow(/secret/);
  });
});

describe("project bindings", () => {
  const P = (...entries: string[]) => `projects:\n${entries.join("\n")}`;
  const e = (id: string, repo: string, linear = "") => `  - { id: ${id}, name: ${id}, repository: ${repo}${linear ? `, linear: ${linear}` : ""} }`;
  const load = (y: string) => loadConfig(dir({ "models.yaml": MODELS, "projects.yaml": y }));
  it("accepts different Linear projects mapped to different repos", () => {
    const c = load(P(e("a", "/r/a", "{ teamKey: JAM, projectName: Alpha }"), e("b", "/r/b", "{ teamKey: JAM, projectName: Beta }")));
    expect(c.projects.projects).toHaveLength(2);
  });
  it("rejects two repos bound to the same Linear project (case-insensitive)", () => {
    expect(() => load(P(e("a", "/r/a", "{ teamKey: JAM, projectName: Alpha }"), e("b", "/r/b", "{ teamKey: JAM, projectName: alpha }")))).toThrow(/same Linear target/);
  });
  it("rejects two team-wide bindings for one team", () => {
    expect(() => load(P(e("a", "/r/a", "{ teamKey: JAM }"), e("b", "/r/b", "{ teamKey: JAM }")))).toThrow(/same Linear target/);
  });
  it("rejects one repository enrolled twice", () => {
    expect(() => load(P(e("a", "/r/a"), e("b", "/r/a")))).toThrow(/same repository/);
  });
  it("allows a team-wide fallback alongside project-specific bindings", () => {
    expect(() => load(P(e("a", "/r/a", "{ teamKey: JAM, projectName: Alpha }"), e("b", "/r/b", "{ teamKey: JAM }")))).not.toThrow();
  });
  it("reads github.account", () => {
    const c = load(P("  - { id: a, name: a, repository: /r/a, github: { account: Nikorag } }"));
    expect(c.projects.projects[0]!.github.account).toBe("Nikorag");
  });
});

describe("managed clones", () => {
  const load = (y: string, f = "") => loadConfig(dir({ "models.yaml": MODELS, "projects.yaml": y, ...(f ? { "factory.yaml": f } : {}) }));
  it("resolves a repository-less project to <dataDir>/projects/<id> and marks it managed", () => {
    const c = load("projects:\n  - { id: kart, name: Kart, github: { repo: Nikorag/Zonto-Kart, account: Nikorag } }", "dataDir: /data");
    expect(c.projects.projects[0]).toMatchObject({ repository: "/data/projects/kart", managed: true });
  });
  it("keeps an explicit repository path unmanaged", () => {
    const c = load("projects:\n  - { id: a, name: A, repository: /r/a }");
    expect(c.projects.projects[0]).toMatchObject({ repository: "/r/a", managed: false });
  });
  it("requires either repository or github.repo", () => {
    expect(() => load("projects:\n  - { id: a, name: A }")).toThrow(/repository.*github\.repo/);
  });
  it("rejects malformed github.repo", () => {
    expect(() => load("projects:\n  - { id: a, name: A, github: { repo: not-a-slug } }")).toThrow(ConfigError);
  });
});

describe("stage timeout budgets", () => {
  it("never lets a configured timeout undercut a stage's own work, for every workflow in the shipped config", async () => {
    const { stageBudgetSeconds, effectiveStageTimeoutSeconds } = await import("../src/config/stage-budgets.js");
    const c = loadConfig("config");
    const inputs = { commandTimeoutSeconds: c.factory.commandTimeoutSeconds, implementationPasses: c.factory.maxImplementationPasses };
    for (const wf of ["feature", "bugfix", "maintenance"]) {
      for (const stage of ["IMPLEMENTATION_PREPARATION", "IMPLEMENTATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW", "CLAUDE_REVIEW", "REMEDIATION", "FINAL_VALIDATION", "SPECIFICATION_GENERATION"] as const) {
        const configured = { ...c.workflows.defaults, ...(c.workflows.workflows[wf]?.stages[stage] ?? {}) }.timeoutSeconds;
        expect(effectiveStageTimeoutSeconds(stage, configured, inputs)).toBeGreaterThanOrEqual(stageBudgetSeconds(stage, inputs)!);
      }
    }
  });
  it("covers the handlers' own agent timeouts plus their project commands", async () => {
    const { stageBudgetSeconds } = await import("../src/config/stage-budgets.js");
    const i = { commandTimeoutSeconds: 900, implementationPasses: 3 };
    expect(stageBudgetSeconds("REMEDIATION", i)).toBeGreaterThan(40 * 60);
    expect(stageBudgetSeconds("FINAL_VALIDATION", i)).toBeGreaterThan(4 * 900 + 25 * 60);
    expect(stageBudgetSeconds("LOCAL_MODEL_REVIEW", i)).toBeGreaterThan(2 * 15 * 60);
    expect(stageBudgetSeconds("IMPLEMENTATION_PREPARATION", i)).toBeGreaterThan(5 * 900);
    expect(stageBudgetSeconds("DISCOVERED", i)).toBeUndefined(); // short stages use the configured timeout
  });
  it("scales IMPLEMENTATION with the configured passes, so every pass can complete", async () => {
    const { stageBudgetSeconds } = await import("../src/config/stage-budgets.js");
    const at = (passes: number) => stageBudgetSeconds("IMPLEMENTATION", { commandTimeoutSeconds: 900, implementationPasses: passes })!;
    expect(at(1)).toBeGreaterThan(70 * 60);
    expect(at(5)).toBeGreaterThan(5 * 70 * 60);
    expect(at(5) - at(4)).toBe(70 * 60);
  });
});
