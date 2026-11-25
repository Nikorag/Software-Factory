import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectConfig } from "../src/config/schema.js";
import { inspectRepository, type GhApi } from "../src/repo/inspect.js";
import { makeRepo, sh } from "./helpers/git-fixture.js";

const proj = (repo: string, over: Record<string, unknown> = {}) => ProjectConfig.parse({ id: "p", name: "P", repository: repo, ...over });
// Answers the repo-visibility probe with 200, and everything else (protection) with the given response.
const gh = (status: number, body: unknown = {}): GhApi => async (path) => (/\/branches\//.test(path) ? { status, body } : { status: 200, body: {} });
const codes = (r: Awaited<ReturnType<typeof inspectRepository>>) => r.findings.map((f) => f.code);

describe("inspectRepository", () => {
  it("reports a missing path and a non-repo without throwing", async () => {
    expect(codes(await inspectRepository(proj("/nonexistent/xyz"), { gh: gh(404) }))).toContain("path-missing");
    const { base } = makeRepo();
    expect(codes(await inspectRepository(proj(base), { gh: gh(404) }))).toContain("not-a-git-repo");
  });
  it("detects build system, commands, CI, CLAUDE.md and SpecKit without modifying anything", async () => {
    const { repo } = makeRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc" } }),
      "pnpm-lock.yaml": "", "CLAUDE.md": "x", ".specify/memory/constitution.md": "x", ".github/workflows/ci.yml": "on: push",
    });
    const before = sh(repo, "status", "--porcelain");
    const r = await inspectRepository(proj(repo), { gh: gh(404) });
    expect(r).toMatchObject({ isGitRepo: true, clean: true, hasClaudeMd: true, hasSpecKit: true, buildSystems: ["node(pnpm)"], ciWorkflows: ["ci.yml"] });
    expect(r.detectedCommands).toEqual({ test: "pnpm test", lint: "pnpm lint", typecheck: "pnpm typecheck" });
    expect(sh(repo, "status", "--porcelain")).toBe(before);
  });
  it("does not report configured commands as missing", async () => {
    const { repo } = makeRepo();
    const r = await inspectRepository(proj(repo, { commands: { test: "make t" } }), { gh: gh(404) });
    expect(codes(r)).not.toContain("no-test-command");
  });
  it("flags a dirty checkout and an absent origin", async () => {
    const { repo } = makeRepo();
    writeFileSync(join(repo, "x"), "dirty");
    const r = await inspectRepository(proj(repo), { gh: gh(404) });
    expect(r.clean).toBe(false);
    expect(codes(r)).toContain("dirty-checkout");
    expect(codes(r)).toContain("not-github"); // local bare origin
    expect(r.ok).toBe(false);
  });
  describe("full autonomy and branch protection", () => {
    const withGithub = () => { const m = makeRepo(); sh(m.repo, "remote", "set-url", "origin", "git@github.com:acme/app.git"); return m.repo; };
    it("errors when the default branch is unprotected", async () => {
      const r = await inspectRepository(proj(withGithub(), { autonomy: "full" }), { gh: gh(404) });
      expect(codes(r)).toContain("no-branch-protection");
      expect(r.ok).toBe(false);
    });
    it("errors when protection has no required checks", async () => {
      const r = await inspectRepository(proj(withGithub(), { autonomy: "full" }), { gh: gh(200, { required_status_checks: { contexts: [] } }) });
      expect(codes(r)).toContain("no-required-checks");
    });
    it("passes with required checks, and surfaces them", async () => {
      const r = await inspectRepository(proj(withGithub(), { autonomy: "full" }), { gh: gh(200, { required_status_checks: { contexts: ["ci"] }, required_pull_request_reviews: {} }) });
      expect(r.branchProtection).toEqual({ status: "protected", requiredChecks: ["ci"], requiresReviews: true });
      expect(r.ok).toBe(true);
    });
    it("warns (not errors) when protection cannot be verified", async () => {
      const r = await inspectRepository(proj(withGithub(), { autonomy: "full" }), { gh: gh(403) });
      expect(codes(r)).toContain("protection-unverified");
      expect(r.ok).toBe(true);
    });
    it("does NOT call a repo unprotected when it is merely invisible to the active gh account", async () => {
      const invisible: GhApi = async () => ({ status: 404, body: "Not Found" });
      const r = await inspectRepository(proj(withGithub(), { autonomy: "full" }), { gh: invisible });
      expect(r.branchProtection.status).toBe("unknown");
      expect(codes(r)).not.toContain("no-branch-protection");
      expect(codes(r)).toContain("protection-unverified");
    });
    it("recognises the GitHub free-plan limitation on private repos as 'unavailable', not 'unprotected'", async () => {
      const plan: GhApi = async (path) => (/\/branches\//.test(path) ? { status: 403, body: "Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" } : { status: 200, body: {} });
      const r = await inspectRepository(proj(withGithub(), { autonomy: "full" }), { gh: plan });
      expect(r.branchProtection.status).toBe("unavailable");
      expect(codes(r)).toContain("protection-unavailable");
      expect(codes(r)).not.toContain("no-branch-protection");
      expect(r.ok).toBe(true); // a warning, but the project must not auto-merge (enforced by the delivery stages)
    });
    it("does not require protection for supervised projects", async () => {
      const r = await inspectRepository(proj(withGithub()), { gh: gh(404) });
      expect(codes(r)).not.toContain("no-branch-protection");
    });
  });
});
