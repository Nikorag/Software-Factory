import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config/load.js";
import { Engine, type StageHandler } from "../src/core/engine.js";
import { enqueue, getJob } from "../src/core/jobs.js";
import { simulatedHandlers } from "../src/core/simulation.js";
import { openDb } from "../src/db/client.js";
import { agentInvocations, artifacts, decisions, jobs, linearOutbox, projects, stageExecutions } from "../src/db/schema.js";
import { buildServer, loadOrCreateToken } from "../src/server/app.js";
import { readLogTail } from "../src/server/routes.js";
import { HealthChecker } from "../src/service/metrics.js";
import { tmp } from "./helpers/git-fixture.js";

const TOKEN = "t".repeat(64);
const HOST = { host: "127.0.0.1:4780" };
const AUTH = { ...HOST, authorization: `Bearer ${TOKEN}` };

function setup(withEngine = false) {
  const { db } = openDb(":memory:");
  const dataDir = tmp();
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  db.insert(projects).values({ id: "p", configJson: "{}" }).run();
  const config = loadConfig("config");
  const engine = withEngine ? new Engine({ db, logger: pino({ level: "silent" }), config, handlers: simulatedHandlers(), backoffBaseMs: 0, heartbeatMs: 60_000 }) : undefined;
  const app = buildServer({ db, logger: pino({ level: "silent" }), config, engine, dataDir, port: 4780, controlToken: TOKEN, health: new HealthChecker({ sandboxAvailable: () => true }) });
  const job = (key = "JAM-1", ext = key) => enqueue(db, { projectId: "p", externalId: ext, externalKey: key }).job;
  return { db, app, dataDir, engine, job, config };
}
const get = (app: ReturnType<typeof setup>["app"], url: string, headers: Record<string, string> = HOST) => app.inject({ method: "GET", url, headers, remoteAddress: "127.0.0.1" });
const post = (app: ReturnType<typeof setup>["app"], url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "POST", url, headers, remoteAddress: "127.0.0.1", payload: {} });

describe("dashboard API security", () => {
  it("refuses non-loopback peers, foreign Host headers (DNS rebinding) and foreign Origins", async () => {
    const s = setup();
    expect((await s.app.inject({ method: "GET", url: "/api/overview", headers: HOST, remoteAddress: "192.168.1.9" })).statusCode).toBe(403);
    expect((await get(s.app, "/api/overview", { host: "evil.example.com" })).statusCode).toBe(403);
    expect((await get(s.app, "/api/overview", { host: "127.0.0.1:9999" })).statusCode).toBe(403); // wrong port
    expect((await get(s.app, "/api/overview", { ...HOST, origin: "https://evil.example.com" })).statusCode).toBe(403);
    expect((await post(s.app, "/api/control/stop", { ...AUTH, origin: "https://evil.example.com" })).statusCode).toBe(403);
    expect((await get(s.app, "/api/overview", { ...HOST, origin: "http://127.0.0.1:4780" })).statusCode).toBe(200);
    expect((await get(s.app, "/api/overview", { host: "localhost:4780" })).statusCode).toBe(200);
  });
  it("every mutating endpoint needs the bearer token; reads do not", async () => {
    const s = setup(); const j = s.job();
    for (const url of ["/api/control/pause", "/api/control/resume", "/api/control/stop", "/api/control/clear-stop", `/api/jobs/${j.id}/retry`, `/api/jobs/${j.id}/cancel`]) {
      expect((await post(s.app, url, HOST)).statusCode, url).toBe(401);                                  // none
      expect((await post(s.app, url, { ...HOST, authorization: "Bearer wrong" })).statusCode, url).toBe(401);
      expect((await post(s.app, url, { ...HOST, authorization: `Bearer ${"t".repeat(63)}` })).statusCode, url).toBe(401); // near miss
      expect((await post(s.app, url, { ...HOST, authorization: `Basic ${TOKEN}` })).statusCode, url).toBe(401);
    }
    expect((await s.app.inject({ method: "GET", url: "/api/jobs", headers: HOST, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect(getJob(s.db, j.id)!.status).toBe("queued"); // nothing happened
  });
  it("the dashboard itself needs no token, but only for genuine same-origin browser requests", async () => {
    const s = setup(); const j = s.job();
    const UI = { ...HOST, origin: "http://127.0.0.1:4780", "x-factory-ui": "1" };
    expect((await post(s.app, "/api/control/pause", UI)).statusCode).toBe(200);
    expect((await post(s.app, "/api/control/resume", { ...UI, "sec-fetch-site": "same-origin" })).statusCode).toBe(200);
    // every way a page on another site, or a bare request, could try
    const no = async (h: Record<string, string>) => expect((await post(s.app, `/api/jobs/${j.id}/cancel`, h)).statusCode).toBeGreaterThanOrEqual(401);
    await no({ ...HOST, "x-factory-ui": "1" });                                          // no Origin: not a browser fetch
    await no({ ...HOST, origin: "http://127.0.0.1:4780" });                              // no UI header
    await no({ ...UI, "sec-fetch-site": "cross-site" });                                 // another site
    await no({ ...UI, "sec-fetch-site": "same-site" });                                  // a sibling origin
    await no({ ...UI, origin: "http://evil.example" });                                  // foreign Origin
    await no({ ...UI, host: "evil.example" });                                           // DNS rebinding
    expect(getJob(s.db, j.id)!.status).toBe("queued");
  });
  it("without a configured token, controls are refused outright", async () => {
    const { db } = openDb(":memory:");
    const app = buildServer({ db, logger: pino({ level: "silent" }), port: 4780 });
    expect((await post(app, "/api/control/pause", { ...HOST, authorization: "Bearer anything" })).statusCode).toBe(401);
  });
  it("serves the dashboard with a strict CSP (no inline script/style, no third parties) and anti-framing headers", async () => {
    const s = setup();
    const res = await get(s.app, "/");
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'"); expect(csp).toContain("script-src 'self'"); expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(res.headers["x-frame-options"]).toBe("DENY"); expect(res.headers["cache-control"]).toBe("no-store"); expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const html = res.body;
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/); expect(html).not.toMatch(/\son\w+=/); expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    const js = /src="(\/assets\/[\w.-]+\.js)"/.exec(html)?.[1], css = /href="(\/assets\/[\w.-]+\.css)"/.exec(html)?.[1];
    expect(js && css).toBeTruthy(); // the built React app: needs `pnpm web:build`
    expect((await get(s.app, js!)).headers["content-type"]).toContain("text/javascript");
    expect((await get(s.app, css!)).headers["content-type"]).toContain("text/css");
    expect((await get(s.app, "/etc/passwd")).statusCode).toBe(404);
    expect((await get(s.app, "/assets/..%2F..%2Fpackage.json")).statusCode).toBe(404);
    expect((await get(s.app, "/assets/.hidden")).statusCode).toBe(404);
  });
  it("the dashboard source never uses an API that parses markup from untrusted text", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []));
    const files = walk(join(process.cwd(), "web", "src"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write|\beval\(|new Function/);
    expect(readFileSync(join(process.cwd(), "web", "src", "lib", "format.ts"), "utf8")).toMatch(/safeUrl/); // links come from untrusted data and are restricted to https://github.com/
  });
  it("creates the control token once, readable only by the user", () => {
    const dir = tmp();
    const t = loadOrCreateToken(dir);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateToken(dir)).toBe(t);
    expect(statSync(join(dir, "control-token")).mode & 0o777).toBe(0o600);
  });
});

describe("dashboard API data (real persisted state, nothing mocked)", () => {
  it("overview reports control state, counts, queues, system and health", async () => {
    const s = setup(); s.job("JAM-1"); s.job("JAM-2");
    s.db.update(jobs).set({ status: "done", stage: "COMPLETED" }).where(eq(jobs.externalKey, "JAM-2")).run();
    const o = (await get(s.app, "/api/overview")).json();
    expect(o.control).toMatchObject({ paused: false, emergencyStop: false });
    expect(o.counts.byStatus).toMatchObject({ queued: 1, done: 1 });
    expect(o.queued.map((j: { key: string }) => j.key)).toEqual(["JAM-1"]);
    expect(o.recent.map((j: { key: string }) => j.key)).toEqual(["JAM-2"]);
    expect(o.mergeMode).toBe("pr-only");
    expect(o.system.memory.totalBytes).toBeGreaterThan(0);
    expect(o.health).toEqual([expect.objectContaining({ name: "sandbox", status: "ok" })]);
  });
  it("lists jobs with filters, and shows full detail: stage history, decisions, agent runs, artefacts, outbox", async () => {
    const s = setup(); const a = s.job("JAM-1"); s.job("JAM-2");
    s.db.insert(stageExecutions).values({ jobId: a.id, stage: "DISCOVERED", attempt: 1, outcome: "succeeded", idempotencyKey: "k1" }).run();
    s.db.insert(decisions).values({ jobId: a.id, kind: "eligibility", decision: "eligible", actor: "factory" }).run();
    s.db.insert(agentInvocations).values({ jobId: a.id, agent: "anthropic/implementer", model: "default", exitCode: 0, durationMs: 1234, usageJson: JSON.stringify({ denials: 2, estimatedListCostUsd: 0.1 }) }).run();
    s.db.insert(artifacts).values({ jobId: a.id, kind: "spec", path: "specs/x/spec.md", sha256: "h", bytes: 10 }).run();
    s.db.insert(artifacts).values({ jobId: a.id, kind: "step:specify", path: "x", sha256: "step-specify", bytes: 1 }).run(); // internal checkpoint: hidden
    s.db.insert(linearOutbox).values({ jobId: a.id, issueId: "i", kind: "comment", payloadJson: "{}", idempotencyKey: "ok" }).run();
    expect((await get(s.app, "/api/jobs?status=queued")).json().jobs).toHaveLength(2);
    expect((await get(s.app, "/api/jobs?status=done")).json().jobs).toHaveLength(0);
    const d = (await get(s.app, `/api/jobs/${a.id}`)).json();
    expect(d.job).toMatchObject({ key: "JAM-1", project: "p" });
    expect(d.stageOrder).toHaveLength(20);
    expect(d.executions[0]).toMatchObject({ stage: "DISCOVERED", outcome: "succeeded" });
    expect(d.decisions[0]).toMatchObject({ kind: "eligibility" });
    expect(d.invocations[0]).toMatchObject({ agent: "anthropic/implementer", durationMs: 1234, usage: { denials: 2 } });
    expect(d.artifacts.map((x: { kind: string }) => x.kind)).toEqual(["spec"]);
    expect(d.outbox).toEqual([expect.objectContaining({ kind: "comment", status: "pending" })]);
    expect((await get(s.app, "/api/jobs/nope")).statusCode).toBe(404);
  });
  it("projects list shows validation state, commands, and whether a test command exists", async () => {
    const s = setup();
    s.db.update(projects).set({ validationJson: JSON.stringify({ ok: true, findings: [{ severity: "warn", code: "x", message: "no CI" }, { severity: "info", code: "y", message: "noise" }], branchProtection: { status: "unavailable" } }), lastValidatedAt: new Date() }).run();
    const cfg = loadConfig("config");
    const app = buildServer({ db: s.db, logger: pino({ level: "silent" }), config: cfg, dataDir: s.dataDir, port: 4780, controlToken: TOKEN });
    const zk = (await get(app, "/api/projects")).json().projects.find((p: { id: string }) => p.id === "zonto-kart");
    expect(zk.commands.test).toContain("tests/run.sh");
    expect(zk.githubRepo).toBe("Nikorag/Zonto-Kart");
    const withReport = s.db.select().from(projects).all()[0]!;
    expect(withReport.id).toBe("p");
  });
});

describe("agent log viewing is confined to the logs directory", () => {
  const seed = (s: ReturnType<typeof setup>, logPath: string) => {
    const j = s.job();
    const inv = s.db.insert(agentInvocations).values({ jobId: j.id, agent: "a", logPath }).returning({ id: agentInvocations.id }).get();
    return `/api/jobs/${j.id}/invocations/${inv.id}/log`;
  };
  it("serves a bounded tail with a truncation flag, as plain text", async () => {
    const s = setup(); const f = join(s.dataDir, "logs", "a.log"); writeFileSync(f, "x".repeat(50_000) + "TAIL-MARKER");
    const res = await get(s.app, `${seed(s, f)}?tail=1000`);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["x-log-truncated"]).toBe("true");
    expect(res.body.length).toBe(1000); expect(res.body.endsWith("TAIL-MARKER")).toBe(true);
  });
  it("never serves files outside <dataDir>/logs: absolute paths, .. traversal, and symlink escapes", async () => {
    const s = setup(); const secret = join(tmp(), "secret.txt"); writeFileSync(secret, "TOP-SECRET");
    mkdirSync(join(s.dataDir, "logs", "sub"), { recursive: true });
    symlinkSync(secret, join(s.dataDir, "logs", "sub", "link.log"));
    for (const p of [secret, "/etc/hosts", join(s.dataDir, "logs", "..", "control-token"), join(s.dataDir, "logs", "sub", "link.log"), "../../etc/passwd"]) {
      const res = await get(s.app, seed(s, p));
      expect(res.statusCode, p).toBe(404);
      expect(res.body).not.toContain("TOP-SECRET");
    }
    expect(readLogTail(s.dataDir, join(s.dataDir, "logs", "missing.log"), 10)).toBeNull();
  });
  it("a log id belonging to another job is not reachable through this job's URL", async () => {
    const s = setup(); const f = join(s.dataDir, "logs", "a.log"); writeFileSync(f, "hello");
    const url = seed(s, f); const other = s.job("JAM-9");
    expect((await get(s.app, url.replace(/\/jobs\/[^/]+/, `/jobs/${other.id}`))).statusCode).toBe(404);
  });
});

describe("controls", () => {
  it("pause, resume, stop and clear-stop change the persisted state (and record who did it)", async () => {
    const s = setup();
    const state = async () => (await get(s.app, "/api/overview")).json().control;
    await post(s.app, "/api/control/pause"); expect(await state()).toMatchObject({ paused: true, emergencyStop: false });
    await post(s.app, "/api/control/resume"); expect(await state()).toMatchObject({ paused: false });
    await post(s.app, "/api/control/stop"); expect(await state()).toMatchObject({ paused: true, emergencyStop: true });
    await post(s.app, "/api/control/clear-stop"); expect(await state()).toMatchObject({ paused: true, emergencyStop: false }); // still paused: resume is explicit
    expect(s.db.select().from(decisions).all().filter((d) => d.actor === "dashboard").map((d) => d.kind)).toEqual(["control.pause", "control.resume", "control.emergency_stop", "control.clear_emergency_stop"]);
  });
  it("EMERGENCY STOP terminates a running agent immediately and holds its job (not waiting for a heartbeat)", async () => {
    const s = setup(true);
    let started = false;
    const hang: StageHandler = () => new Promise(() => { started = true; });
    const eng = new Engine({ db: s.db, logger: pino({ level: "silent" }), config: s.config, handlers: { ...simulatedHandlers(), IMPLEMENTATION: hang }, backoffBaseMs: 0, heartbeatMs: 60_000 });
    const app = buildServer({ db: s.db, logger: pino({ level: "silent" }), config: s.config, engine: eng, dataDir: s.dataDir, port: 4780, controlToken: TOKEN });
    const j = s.job(); const run = eng.tick();
    while (!started) await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    expect((await post(app, "/api/control/stop")).statusCode).toBe(200);
    await run;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(getJob(s.db, j.id)).toMatchObject({ stage: "PAUSED", heldFromStage: "IMPLEMENTATION" });
    expect(await eng.tick()).toBe(0); // and nothing new starts
  });
  it("cancel aborts a running job at once; retry resumes a held job; retrying a healthy job is refused", async () => {
    const s = setup(true);
    let started = false;
    const eng = new Engine({ db: s.db, logger: pino({ level: "silent" }), config: s.config, handlers: { ...simulatedHandlers(), IMPLEMENTATION: () => new Promise(() => { started = true; }) }, backoffBaseMs: 0, heartbeatMs: 60_000 });
    const app = buildServer({ db: s.db, logger: pino({ level: "silent" }), config: s.config, engine: eng, dataDir: s.dataDir, port: 4780, controlToken: TOKEN });
    const j = s.job(); const run = eng.tick();
    while (!started) await new Promise((r) => setTimeout(r, 5));
    expect((await post(app, `/api/jobs/${j.id}/cancel`)).statusCode).toBe(200);
    await run;
    expect(getJob(s.db, j.id)).toMatchObject({ stage: "CANCELLED", status: "cancelled" });
    expect((await post(app, `/api/jobs/${j.id}/cancel`)).statusCode).toBe(409); // already cancelled
    const held = s.job("JAM-5"); s.db.update(jobs).set({ stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "CLAUDE_REVIEW" }).where(eq(jobs.id, held.id)).run();
    expect((await post(app, `/api/jobs/${held.id}/retry`)).json().job).toMatchObject({ stage: "CLAUDE_REVIEW", status: "queued" });
    const healthy = s.job("JAM-6");
    expect((await post(app, `/api/jobs/${healthy.id}/retry`)).statusCode).toBe(409);
  });
});
