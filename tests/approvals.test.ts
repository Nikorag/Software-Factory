import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideRequest, listRequests, neverGrantable, readRequest, WAITING } from "../src/core/approvals.js";
import { JobError } from "../src/core/jobs.js";
import { buildClaudeArgs } from "../src/agents/claude.js";
import { readRules } from "../src/agents/permissions.js";
import { sandboxAvailable } from "../src/exec/sandbox.js";
import { defaults } from "./helpers/impl-agent.js";
import { decisionKinds, harness, impl, job, type H } from "./helpers/impl-harness.js";

const home = homedir();
const read = (file_path: string) => ({ tool: "Read", input: JSON.stringify({ file_path }) });

describe("what can be granted", () => {
  it("never the whole disk, the home folder, anything containing it, or credential stores and the factory's data", () => {
    expect(neverGrantable("/")).toMatch(/whole disk/);
    expect(neverGrantable(home)).toMatch(/whole home folder/);
    expect(neverGrantable(join(home, ".."))).toMatch(/contains your home folder/);
    for (const p of [".ssh", ".aws/credentials", ".claude", ".config/gh/hosts.yml", ".software-factory/database", "Library/Keychains"]) expect(neverGrantable(join(home, p))).toMatch(/credentials or the factory's own data/);
    expect(neverGrantable(join(home, ".config"))).toMatch(/contains ~\/\.config\/gh/);
    expect(neverGrantable(join(home, "projects", "other-repo"))).toBeNull();
    expect(neverGrantable(mkdtempSync(join(tmpdir(), "ref-")))).toBeNull();
  });

  it("turns a refused read outside the worktree into a request for its folder; ignores reads inside it and anything that is not a read", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-")), ref = mkdtempSync(join(tmpdir(), "ref-"));
    writeFileSync(join(ref, "worker.ts"), "x");
    expect(readRequest(read(join(ref, "worker.ts")), wt)).toEqual({ path: join(ref, "worker.ts"), grantPath: `${ref}/**` });
    expect(readRequest({ tool: "Grep", input: JSON.stringify({ pattern: "x", path: ref }) }, wt)).toEqual({ path: ref, grantPath: `${ref}/**` });
    expect(readRequest(read(join(wt, "src", "a.ts")), wt)).toBeNull();
    expect(readRequest({ tool: "Bash", input: JSON.stringify({ command: "cat /etc/hosts" }) }, wt)).toBeNull();
    expect(readRequest({ tool: "Grep", input: JSON.stringify({ pattern: "x" }) }, wt)).toBeNull(); // no path: the worktree
  });

  it("a file straight in the home folder is granted alone; a credential file is refused, with the reason", () => {
    const wt = mkdtempSync(join(tmpdir(), "wt-"));
    expect(readRequest(read(join(home, "notes.md")), wt)).toEqual({ path: join(home, "notes.md"), grantPath: join(home, "notes.md") });
    expect(readRequest(read(join(home, ".ssh", "id_ed25519")), wt)).toMatchObject({ refused: expect.stringMatching(/credentials/) });
  });

  it("an approval becomes a path-scoped Read rule for Claude Code (covering Read, Grep and Glob, never writing), and never a bare Read", () => {
    const ref = mkdtempSync(join(tmpdir(), "ref-"));
    expect(readRules([`${ref}/**`])).toContain(`Read(//${ref.replace(/^\//, "")}/**)`);
    const args = buildClaudeArgs({ role: "implementer", profile: "implementer", prompt: "x", cwd: mkdtempSync(join(tmpdir(), "wt-")), timeoutMs: 1, readPaths: [`${ref}/**`] });
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    expect(allowed.some((a) => a.startsWith("Read(//") && a.endsWith("/**)"))).toBe(true);
    expect(allowed).not.toContain("Read");
    expect(allowed.some((a) => /^(Edit|Write)\(\/\/.*ref-/.test(a))).toBe(false);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(h: H, cond: () => boolean, ticks = 60) { for (let i = 0; i < ticks && !cond(); i++) { await h.engine.tick(); if (!cond()) await sleep(10); } }
const db = (h: H) => h.ctx.handle.db;

describe.skipIf(!sandboxAvailable())("asking a person instead of failing (KPS-19: port code from a folder outside the worktree)", () => {
  const setup = async () => {
    const ref = mkdtempSync(join(tmpdir(), "reference-"));
    mkdirSync(join(ref, "worker"), { recursive: true });
    writeFileSync(join(ref, "worker", "index.ts"), "export default {};\n");
    const h = await harness();
    let asked = false;
    // The implementer is refused the read once (as Claude Code reports it), and does nothing that time, like the live job.
    h.claude.b.denials = (req) => (req.role === "implementer" && !asked && !req.readPaths?.length ? (asked = true, [read(join(ref, "worker", "index.ts"))]) : []);
    const real = defaults().implement;
    h.claude.b.implement = (cwd, dir, n, req) => { if (req.readPaths?.length || n > 1) real(cwd, dir, n, req); };
    return { h, ref };
  };

  it("stops at Needs your permission; Approve resumes the same step with read access to that folder, and the job carries on", async () => {
    const { h, ref } = await setup();
    await settle(h, () => job(h).stage === "NEEDS_ATTENTION");
    expect(job(h)).toMatchObject({ stage: "NEEDS_ATTENTION", heldFromStage: "IMPLEMENTATION" });
    expect(job(h).lastError).toMatch(new RegExp(`^${WAITING}`));
    const [req] = listRequests(db(h), job(h).id);
    expect(req).toMatchObject({ status: "pending", tool: "Read", grantPath: `${join(ref, "worker")}/**` });

    const r = decideRequest(db(h), job(h).id, req!.id, "approve", "dashboard");
    expect(r.resumed).toBe(true);
    expect(job(h)).toMatchObject({ stage: "IMPLEMENTATION", status: "queued" });
    await settle(h, () => ["MERGING", "NEEDS_ATTENTION", "FAILED"].includes(job(h).stage));
    const next = impl(h).find((c) => c.readPaths?.length)!;
    expect(next.readPaths).toEqual([`${join(ref, "worker")}/**`]);
    expect(next.systemPrompt).toMatch(/allowed you to READ these folders/);
    expect(next.prompt).toMatch(/You may now read .*worker\/ \(read-only/);
    expect(next.resumeSessionId).toBe("sess-impl"); // the same conversation
    expect(job(h).stage).toBe("MERGING");
    expect(decisionKinds(h)).toContain("permission.approved");
  });

  it("Deny resumes too, telling the agent to carry on without it; a decided request is never asked again", async () => {
    const { h } = await setup();
    await settle(h, () => job(h).stage === "NEEDS_ATTENTION");
    const [req] = listRequests(db(h), job(h).id);
    decideRequest(db(h), job(h).id, req!.id, "deny", "dashboard");
    await settle(h, () => ["MERGING", "NEEDS_ATTENTION", "FAILED"].includes(job(h).stage));
    expect(impl(h).at(-1)!.readPaths ?? []).toEqual([]);
    expect(impl(h).some((c) => /A person denied reading .*index\.ts/.test(c.prompt))).toBe(true);
    expect(() => decideRequest(db(h), job(h).id, req!.id, "approve", "dashboard")).toThrow(/already denied/);
    expect(listRequests(db(h), job(h).id)).toHaveLength(1);
  });

  it("something that can never be granted does not stop the job: it is recorded as refused, with the reason", async () => {
    const h = await harness();
    h.claude.b.denials = (req) => (req.role === "implementer" ? [read(join(home, ".ssh", "id_ed25519"))] : []);
    await settle(h, () => ["MERGING", "NEEDS_ATTENTION", "FAILED"].includes(job(h).stage));
    expect(job(h).stage).toBe("MERGING");
    const [req] = listRequests(db(h), job(h).id);
    expect(req).toMatchObject({ status: "refused", reason: expect.stringMatching(/credentials/) });
    expect(() => decideRequest(db(h), job(h).id, req!.id, "approve", "dashboard")).toThrow(JobError);
  });
});
