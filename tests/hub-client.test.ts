import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { openDb } from "../src/db/client.js";
import { decisions, jobs, projects, stageExecutions } from "../src/db/schema.js";
import type { FetchLike } from "../src/hub/client.js";
import { connectHub, disconnectHub, hubStatus } from "../src/hub/commands.js";
import { backoffMs, HubReporter, readState, stateFile } from "../src/hub/reporter.js";
import { readHubSettings, writeHubSettings } from "../src/hub/settings.js";
import { fixtureConfigDir } from "./helpers/config.js";

const KEY = "sfh_0b1d2c3e-1111-4222-8333-444455556666.SuperSecretValueSuperSecretValue123";
const OTHER_KEY = "sfh_0b1d2c3e-1111-4222-8333-444455556666.AnotherSecretValueAnotherSecretValue99";
const log = pino({ level: "silent" });

interface Call { path: string; auth: string | undefined; body: Record<string, unknown> }
/** A fake hub: records every request; `respond` decides the status (default 200). */
function fakeHub(respond: (path: string, n: number) => number = () => 200) {
  const calls: Call[] = []; let n = 0;
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname; n++;
    calls.push({ path, auth: init.headers.authorization, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    const status = respond(path, n);
    return { ok: status < 300, status, text: async () => "{}" };
  };
  const eventIds = () => calls.filter((c) => c.path.endsWith("/events")).flatMap((c) => (c.body.events as Array<{ id: string }>).map((e) => e.id));
  return { fetch, calls, eventIds };
}

function seed() {
  const { db } = openDb(":memory:");
  db.insert(projects).values({ id: "web", configJson: JSON.stringify({ repository: "/Users/me/secret-repo", token: "PROJECT_SECRET" }) }).run();
  db.insert(jobs).values({ id: "j1", projectId: "web", externalId: "lin-1", externalKey: "ENG-1", status: "running", stage: "SPECIFY", workflow: "feature",
    prUrl: "https://github.com/o/r/pull/9", lastError: "LAST_ERROR_SECRET /Users/me/secret-repo/.env", }).run();
  return db;
}
const exec = (db: ReturnType<typeof seed>, n: number, outcome: "succeeded" | "started" | "failed" = "succeeded") =>
  db.insert(stageExecutions).values({ jobId: "j1", stage: "SPECIFY", attempt: n, outcome, idempotencyKey: `j1:SPECIFY:${n}`, startedAt: new Date(1_700_000_000_000 + n * 1000),
    finishedAt: outcome === "started" ? null : new Date(1_700_000_000_500 + n * 1000),
    inputJson: JSON.stringify({ ticket: "TICKET_TEXT_SECRET" }), outputJson: JSON.stringify({ diff: "DIFF_SECRET" }), error: "STACK_SECRET at /Users/me/x.ts",
}).returning({ id: stageExecutions.id }).get().id;

const dir = () => mkdtempSync(join(tmpdir(), "factory-hub-"));
function reporter(db: ReturnType<typeof seed>, dataDir: string, hub: ReturnType<typeof fakeHub>, o: { enabled?: boolean; key?: string | undefined; now?: () => number; getKey?: () => string | undefined } = {}) {
  let getSettingsCalls = 0, getKeyCalls = 0;
  const r = new HubReporter({
    db, dataDir, logger: log, fetch: hub.fetch, now: o.now, version: "1.2.3", tracker: "linear",
    getSettings: () => { getSettingsCalls++; return { enabled: o.enabled ?? true, url: "https://hub.example.test", reportIntervalSeconds: 30, remoteAccess: false }; },
    getKey: o.getKey ?? (() => { getKeyCalls++; return "key" in o ? o.key : KEY; }),
  });
  return { r, counts: () => ({ getSettingsCalls, getKeyCalls }) };
}

describe("hub reporting is off by default", () => {
  it("the shipped config has it disabled with no URL", () => {
    const hub = loadConfig(fixtureConfigDir()).factory.hub;
    expect(hub).toMatchObject({ enabled: false, url: "" });
  });
  it("a disabled reporter sends nothing, and does not even look up a key", async () => {
    const hub = fakeHub(), db = seed(); exec(db, 1);
    const { r, counts } = reporter(db, dir(), hub, { enabled: false });
    await r.tick(); await r.tick();
    expect(hub.calls).toHaveLength(0);
    expect(counts().getKeyCalls).toBe(0);
  });
  it("enabled without a key sends nothing and says why", async () => {
    const hub = fakeHub(), d = dir(), db = seed();
    await reporter(db, d, hub, { key: undefined }).r.tick();
    expect(hub.calls).toHaveLength(0);
    expect(readState(d).lastError).toBe("no API key");
  });
  it("rejects a non-https hub URL in config (localhost excepted)", () => {
    const d = fixtureConfigDir();
    writeFileSync(join(d, "factory.yaml"), "hub: { enabled: true, url: 'http://hub.example.com' }\n");
    expect(() => loadConfig(d)).toThrow(/https/);
    writeFileSync(join(d, "factory.yaml"), "hub: { enabled: true, url: 'http://localhost:8080' }\n");
    expect(loadConfig(d).factory.hub.enabled).toBe(true);
  });
});

describe("factory hub connect / disconnect / status", () => {
  const setup = () => ({ configDir: fixtureConfigDir(), dataDir: dir() });

  it("validates the key with a heartbeat, stores it outside config, then enables reporting", async () => {
    const hub = fakeHub(), d = setup(); let saved = "";
    const r = await connectHub({ url: "https://hub.example.test/some/path/", key: KEY }, { ...d, fetch: hub.fetch, env: {}, save: (k) => { saved = k; } });
    expect(r.url).toBe("https://hub.example.test");
    expect(hub.calls.map((c) => c.path)).toEqual(["/v1/factory/heartbeat"]);
    expect(hub.calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(saved).toBe(KEY);
    expect(readHubSettings(d.configDir)).toMatchObject({ enabled: true, url: "https://hub.example.test" });
    expect(readFileSync(join(d.configDir, "factory.yaml"), "utf8")).not.toContain("SuperSecret"); // the key is never in config
  });
  it("does not copy a key that came from the environment into the keychain", async () => {
    const hub = fakeHub(), d = setup(); let saved = false;
    await connectHub({ url: "https://hub.example.test", key: KEY }, { ...d, fetch: hub.fetch, env: { FACTORY_HUB_KEY: KEY }, save: () => { saved = true; } });
    expect(saved).toBe(false);
  });
  it("enables nothing when the hub rejects the key, is unreachable, or the key cannot be stored", async () => {
    const d = setup();
    await expect(connectHub({ url: "https://hub.example.test", key: KEY }, { ...d, fetch: fakeHub(() => 401).fetch, env: {}, save: () => { throw new Error("must not save"); } })).rejects.toThrow(/rejected/);
    await expect(connectHub({ url: "https://hub.example.test", key: KEY }, { ...d, fetch: async () => { throw new Error("boom"); }, env: {}, save: () => undefined })).rejects.toThrow(/could not reach/);
    await expect(connectHub({ url: "https://hub.example.test", key: KEY }, { ...d, fetch: fakeHub().fetch, env: {}, save: () => { throw new Error("no keychain"); } })).rejects.toThrow(/FACTORY_HUB_KEY/);
    expect(readHubSettings(d.configDir).enabled).toBe(false);
  });
  it("refuses plain http (except localhost) and malformed keys, before any network call", async () => {
    const hub = fakeHub(), d = setup();
    await expect(connectHub({ url: "http://hub.example.test", key: KEY }, { ...d, fetch: hub.fetch, env: {}, save: () => undefined })).rejects.toThrow(/https/);
    await expect(connectHub({ url: "https://hub.example.test", key: "not-a-key" }, { ...d, fetch: hub.fetch, env: {}, save: () => undefined })).rejects.toThrow(/does not look like/);
    expect(hub.calls).toHaveLength(0);
    await connectHub({ url: "http://localhost:8080", key: KEY }, { ...d, fetch: hub.fetch, env: {}, save: () => undefined });
    expect(readHubSettings(d.configDir).url).toBe("http://localhost:8080");
  });
  it("disconnect turns reporting off, deletes the key and the cursor", async () => {
    const d = setup(); let deleted = false;
    writeHubSettings({ enabled: true, url: "https://hub.example.test" }, d.configDir);
    writeFileSync(stateFile(d.dataDir), JSON.stringify({ stageCursor: 5 }));
    disconnectHub({ ...d, deleteKey: () => { deleted = true; } });
    expect(readHubSettings(d.configDir).enabled).toBe(false);
    expect(deleted).toBe(true);
    expect(existsSync(stateFile(d.dataDir))).toBe(false);
  });
  it("status reports state and never contains the key", async () => {
    const d = setup(), db = seed(); exec(db, 1);
    writeHubSettings({ enabled: true, url: "https://hub.example.test" }, d.configDir);
    await reporter(db, d.dataDir, fakeHub(() => 500), {}).r.tick();
    const s = hubStatus({ ...d, getKey: () => KEY });
    expect(s).toMatchObject({ enabled: true, url: "https://hub.example.test", keyPresent: true, lastSuccessAt: null, lastError: "hub returned 500" });
    expect(JSON.stringify(s)).not.toContain("SuperSecret");
    expect(hubStatus({ ...setup() }).enabled).toBe(false);
  });
});

describe("reporting", () => {
  it("sends heartbeat, sync, then events with the bearer key, and only changes after that", async () => {
    const hub = fakeHub(), d = dir(), db = seed(); exec(db, 1);
    const { r } = reporter(db, d, hub);
    await r.tick();
    expect(hub.calls.map((c) => c.path)).toEqual(["/v1/factory/heartbeat", "/v1/factory/sync", "/v1/factory/events"]);
    expect(hub.calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    expect(hub.calls[0]!.body).toMatchObject({ version: "1.2.3", metadata: { paused: false, tracker: "linear", jobs: { running: 1 } } });
    const sync = hub.calls[1]!.body as { projects: unknown[]; jobs: Array<Record<string, unknown>>; workflows: unknown[] };
    expect(sync.projects).toEqual([{ id: "web", name: "web" }]);
    expect(sync.jobs[0]).toMatchObject({ id: "j1", projectId: "web", title: "ENG-1", stage: "SPECIFY", status: "running", workflowId: "feature", metadata: { prUrl: "https://github.com/o/r/pull/9" } });
    expect(sync.workflows).toEqual([{ id: "feature", name: "feature" }]);
    const ev = (hub.calls[2]!.body.events as Array<Record<string, unknown>>)[0]!;
    expect(ev).toMatchObject({ id: "stage_execution:1", type: "stage.finished", jobId: "j1", payload: { stage: "SPECIFY", attempt: 1, outcome: "succeeded" } });
    expect(readState(d).lastSuccessAt).not.toBeNull();

    hub.calls.length = 0; await r.tick(); // nothing changed: just a heartbeat
    expect(hub.calls.map((c) => c.path)).toEqual(["/v1/factory/heartbeat"]);
  });

  it("resumes from the durable cursor after a restart, with no gaps and no resends", async () => {
    const hub = fakeHub(), d = dir(), db = seed(); exec(db, 1); exec(db, 2);
    await reporter(db, d, hub).r.tick();
    expect(hub.eventIds()).toEqual(["stage_execution:1", "stage_execution:2"]);
    exec(db, 3);
    hub.calls.length = 0;
    await reporter(db, d, hub).r.tick(); // a brand new reporter = a restarted service
    expect(hub.eventIds()).toEqual(["stage_execution:3"]);
  });

  it("does not advance the cursor when the hub fails, so the same deterministic ids are resent", async () => {
    let failEvents = true; const hub = fakeHub((p) => (p.endsWith("/events") && failEvents ? 503 : 200));
    let t = 1_000_000; const d = dir(), db = seed(); exec(db, 1);
    const { r } = reporter(db, d, hub, { now: () => t });
    await r.tick();
    expect(readState(d).stageCursor).toBe(0);
    failEvents = false; t += 10 * 60_000; await r.tick();
    expect(hub.eventIds()).toEqual(["stage_execution:1", "stage_execution:1"]); // idempotent on the hub by id
    expect(readState(d).stageCursor).toBe(1);
  });

  it("a still-running attempt holds the cursor back so it is reported when it finishes", async () => {
    const hub = fakeHub(), d = dir(), db = seed(); const now = 1_700_000_100_000;
    const running = exec(db, 1, "started"); exec(db, 2);
    const { r } = reporter(db, d, hub, { now: () => now });
    await r.tick();
    expect(hub.eventIds()).toEqual([]); // 2 is finished but 1 is not: wait
    db.update(stageExecutions).set({ outcome: "succeeded", finishedAt: new Date(now) }).run();
    await r.tick();
    expect(hub.eventIds()).toEqual([`stage_execution:${running}`, "stage_execution:2"]);
  });

  it("reports decisions (kind/actor/short decision) and not their rationale", async () => {
    const hub = fakeHub(), d = dir(), db = seed();
    db.insert(decisions).values({ jobId: "j1", kind: "job.release", decision: "released at SPECIFY", rationale: "RATIONALE_SECRET", actor: "factory" }).run();
    await reporter(db, d, hub).r.tick();
    const ev = hub.calls.find((c) => c.path.endsWith("/events"))!.body.events as Array<Record<string, unknown>>;
    expect(ev[0]).toMatchObject({ id: "decision:1", type: "decision", jobId: "j1", payload: { kind: "job.release", actor: "factory", decision: "released at SPECIFY" } });
  });

  it("batches at most 500 events per request", async () => {
    const hub = fakeHub(), d = dir(), db = seed();
    for (let i = 0; i < 1100; i++) db.insert(decisions).values({ kind: "k", decision: "d", actor: "a" }).run();
    await reporter(db, d, hub).r.tick();
    const sizes = hub.calls.filter((c) => c.path.endsWith("/events")).map((c) => (c.body.events as unknown[]).length);
    expect(sizes).toEqual([500, 500, 100]);
    expect(new Set(hub.eventIds()).size).toBe(1100);
  });

  it("skips a batch the hub calls invalid (400) instead of wedging forever", async () => {
    const hub = fakeHub((p) => (p.endsWith("/events") ? 400 : 200)), d = dir(), db = seed(); exec(db, 1);
    await reporter(db, d, hub).r.tick();
    expect(readState(d).stageCursor).toBe(1);
  });

  it("never throws into the caller, even if the database is closed", async () => {
    const hub = fakeHub(), db = seed(); const { r } = reporter(db, dir(), hub);
    (db as unknown as { $client: { close(): void } }).$client.close();
    await expect(r.tick()).resolves.toBeUndefined();
  });
});

describe("backoff", () => {
  it("grows exponentially, is capped, and waits before retrying", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 12].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 900_000]);
    const hub = fakeHub(() => 500), d = dir(), db = seed(); let t = 5_000_000;
    const { r } = reporter(db, d, hub, { now: () => t });
    await r.tick(); expect(readState(d)).toMatchObject({ failures: 1, nextAttemptAt: t + 30_000 });
    const n = hub.calls.length;
    t += 10_000; await r.tick(); expect(hub.calls.length).toBe(n); // too early: no request
    t += 30_000; await r.tick(); expect(readState(d)).toMatchObject({ failures: 2 });
    expect(hub.calls.length).toBeGreaterThan(n);
  });
  it("resets after a success", async () => {
    let fail = true; const hub = fakeHub(() => (fail ? 500 : 200)), d = dir(), db = seed(); let t = 9_000_000;
    const { r } = reporter(db, d, hub, { now: () => t });
    await r.tick(); fail = false; t += 60_000; await r.tick();
    expect(readState(d)).toMatchObject({ failures: 0, lastError: null, nextAttemptAt: 0 });
  });
});

describe("key rejected (401)", () => {
  it("stops reporting, records why, and resumes only with a different key", async () => {
    let status = 401; const hub = fakeHub(() => status), d = dir(), db = seed(); let t = 1_000;
    let key = KEY;
    const { r } = reporter(db, d, hub, { now: () => t, getKey: () => key });
    await r.tick();
    expect(readState(d)).toMatchObject({ keyRejected: true });
    expect(readState(d).lastError).toMatch(/key rejected/);
    const n = hub.calls.length;
    t += 3600_000; await r.tick(); await r.tick();
    expect(hub.calls.length).toBe(n); // no hammering the hub with a dead key
    status = 200; key = OTHER_KEY; await r.tick();
    expect(readState(d)).toMatchObject({ keyRejected: false, lastError: null });
    expect(hub.calls.length).toBeGreaterThan(n);
    expect(readFileSync(stateFile(d), "utf8")).not.toContain("SuperSecret"); // only a fingerprint is kept
  });
});

describe("privacy: only whitelisted metadata leaves the machine", () => {
  it("never sends transcripts, diffs, ticket text, paths, errors, rationale, snapshots or the key itself in any body", async () => {
    const hub = fakeHub(), d = dir(), db = seed(); exec(db, 1); exec(db, 2, "failed");
    db.insert(decisions).values({ jobId: "j1", kind: "x", decision: "ok", rationale: "RATIONALE_SECRET /Users/me/secret-repo", actor: "factory" }).run();
    await reporter(db, d, hub).r.tick();
    const wire = JSON.stringify(hub.calls.map((c) => c.body));
    for (const secret of ["TICKET_TEXT_SECRET", "DIFF_SECRET", "STACK_SECRET", "TRACE_SECRET", "REASON_SECRET", "RATIONALE_SECRET", "LAST_ERROR_SECRET", "SNAPSHOT_SECRET", "WORKFLOW_PROMPT_SECRET", "PROJECT_SECRET", "/Users/me", "secret-repo", "SuperSecret"])
      expect(wire, secret).not.toContain(secret);
    expect(hub.calls.some((c) => c.path.endsWith("/events"))).toBe(true);
  });
});
