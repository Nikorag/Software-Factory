// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config/load.js";
import * as control from "../src/core/control.js";
import { enqueue } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { agentInvocations, decisions, jobs, projects, stageExecutions } from "../src/db/schema.js";
import { buildServer } from "../src/server/app.js";
import { HealthChecker } from "../src/service/metrics.js";

const PUBLIC = join(process.cwd(), "public");
const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;

/** Runs the real dashboard (index.html + app.js) in jsdom against the real server, answering fetch via fastify.inject. */
async function boot(seed: (db: ReturnType<typeof openDb>["db"]) => void, hash = "#/", token = "") {
  const { db } = openDb(":memory:"); db.insert(projects).values({ id: "p", configJson: "{}" }).run(); seed(db);
  const app = buildServer({ db, logger: pino({ level: "silent" }), config: loadConfig("config"), dataDir: "/tmp", port: 4780, controlToken: "k".repeat(64), health: new HealthChecker({ sandboxAvailable: () => true }) });
  const dom = new JSDOM(readFileSync(join(PUBLIC, "index.html"), "utf8").replace(/<script src="\/app.js"><\/script>/, ""), { url: `http://127.0.0.1:4780/${hash}`, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window as unknown as Window & { fetch: typeof fetch; __pwned?: number; alert: (m: string) => void; confirm: () => boolean; eval: (s: string) => unknown };
  const calls: { url: string; method: string }[] = [];
  w.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const r = await app.inject({ method: (init?.method ?? "GET") as "GET", url, headers: { host: "127.0.0.1:4780", ...(init?.headers as Record<string, string>) }, remoteAddress: "127.0.0.1", payload: init?.body as string });
    return new Response(r.body, { status: r.statusCode, headers: { "content-type": String(r.headers["content-type"]) } });
  }) as typeof fetch;
  w.alert = () => {}; w.confirm = () => true;
  if (token) w.sessionStorage.setItem("factory-token", token);
  w.eval(readFileSync(join(PUBLIC, "app.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 150));
  return { w, doc: w.document, db, calls, app };
}
const text = (d: Document, sel = "#view") => d.querySelector(sel)!.textContent ?? "";

describe("dashboard UI (real script, real API, jsdom)", () => {
  it("renders the overview: state, mode, counts, system, scheduler and dependency health", async () => {
    const { doc } = await boot((db) => { enqueue(db, { projectId: "p", externalId: "1", externalKey: "JAM-1" }); });
    expect(text(doc, "#state")).toBe("RUNNING");
    expect(text(doc, "#mode")).toContain("PR-only: never merges");
    const v = text(doc);
    expect(v).toContain("Jobs"); expect(v).toContain("This machine"); expect(v).toContain("memory free"); expect(v).toContain("Dashboard only");
    expect(v).toContain("JAM-1"); expect(v).toContain("sandbox");
  });
  it("shows the emergency state loudly and swaps the controls", async () => {
    const { doc } = await boot((db) => control.emergencyStop(db, "t", "disk full"));
    expect(text(doc, "#state")).toBe("EMERGENCY STOP");
    expect(doc.querySelector<HTMLElement>("#banner")!.hidden).toBe(false);
    expect(text(doc, "#banner")).toContain("disk full");
    expect(doc.querySelector<HTMLElement>("#btn-stop")!.hidden).toBe(true);
    expect(doc.querySelector<HTMLElement>("#btn-clear")!.hidden).toBe(false);
    expect(doc.querySelector<HTMLElement>("#btn-pause")!.hidden).toBe(true);
  });
  it("renders hostile ticket/agent-derived text as inert text: no elements created, no script run, no javascript: links", async () => {
    const seeded: { id?: string } = {};
    const { w, doc } = await boot((db) => {
      const j = enqueue(db, { projectId: "p", externalId: "1", externalKey: "JAM-1" }).job; seeded.id = j.id;
      db.update(jobs).set({ lastError: `${XSS} boom`, prUrl: "javascript:window.__pwned=1", stage: "BLOCKED", status: "waiting", heldFromStage: "IMPLEMENTATION" }).where(eq(jobs.id, j.id)).run();
      db.insert(decisions).values({ jobId: j.id, kind: XSS, decision: XSS, rationale: XSS, actor: XSS }).run();
      db.insert(stageExecutions).values({ jobId: j.id, stage: "DISCOVERED", attempt: 1, outcome: "failed", error: XSS, idempotencyKey: "x" }).run();
      db.insert(agentInvocations).values({ jobId: j.id, agent: XSS, model: XSS }).run();
    }, "#/");
    w.location.hash = `#/jobs/${seeded.id}`;
    await new Promise((r) => setTimeout(r, 300));
    const view = doc.querySelector("#view")!;
    expect(view.textContent).toContain("<img src=x onerror=");   // shown literally
    expect(view.querySelectorAll("img, script, iframe, object, embed").length).toBe(0);
    expect(w.__pwned).toBeUndefined();
    expect(view.querySelector('a[href^="javascript:"]')).toBeNull(); // the hostile PR url is not linked at all
    expect([...view.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name)))).toBe(false);
  });
  it("links a real GitHub PR (opening safely) and shows the stage progression with the held stage marked", async () => {
    const { w, doc } = await boot((db) => {
      const j = enqueue(db, { projectId: "p", externalId: "1", externalKey: "JAM-1" }).job;
      db.update(jobs).set({ prUrl: "https://github.com/Nikorag/Zonto-Kart/pull/35", stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "CLAUDE_REVIEW" }).where(eq(jobs.id, j.id)).run();
      db.insert(stageExecutions).values({ jobId: j.id, stage: "DISCOVERED", attempt: 1, outcome: "succeeded", idempotencyKey: "a" }).run();
    });
    w.location.hash = `#/jobs/${(await (await w.fetch("/api/jobs")).json() as { jobs: { id: string }[] }).jobs[0]!.id}`;
    await new Promise((r) => setTimeout(r, 300));
    const a = doc.querySelector<HTMLAnchorElement>('a[href^="https://github.com/"]')!;
    expect(a.getAttribute("rel")).toContain("noopener"); expect(a.target).toBe("_blank");
    expect(doc.querySelectorAll(".stage").length).toBe(20);
    expect(doc.querySelector(".stage.done")!.getAttribute("title")).toBe("DISCOVERED");
    expect(doc.querySelector(".stage.held")!.getAttribute("title")).toBe("CLAUDE_REVIEW"); // marked where it stopped, not at the (non-pipeline) held state
    expect(text(doc)).toContain("Retry resumes there");
  });
  it("controls call the API with the bearer token, and a missing token never sends a request", async () => {
    const tokened = await boot(() => {}, "#/", "k".repeat(64));
    tokened.doc.querySelector<HTMLElement>("#btn-pause")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(tokened.calls.some((c) => c.url === "/api/control/pause" && c.method === "POST")).toBe(true);
    expect(control.getControl(tokened.db).paused).toBe(true);
    expect(text(tokened.doc, "#auth")).toBe("controls enabled");
    const anon = await boot(() => {});
    anon.doc.querySelector<HTMLElement>("#btn-pause")!.click();
    await new Promise((r) => setTimeout(r, 200));
    expect(anon.calls.some((c) => c.method === "POST")).toBe(false);
    expect(text(anon.doc, "#auth")).toContain("read-only");
    expect(control.getControl(anon.db).paused).toBe(false);
  });
  it("takes the token from the URL fragment and removes it from the address bar", async () => {
    const { w } = await boot(() => {}, `#token=${"a".repeat(64)}`);
    expect(w.sessionStorage.getItem("factory-token")).toBe("a".repeat(64));
    expect(w.location.hash).not.toContain("token");
  });
  it("renders the projects table (test-command status, validation, protection) and the health page", async () => {
    const { w, doc } = await boot(() => {});
    w.location.hash = "#/projects"; await new Promise((r) => setTimeout(r, 300));
    const t = text(doc);
    expect(t).toContain("Zonto Kart"); expect(t).toContain("no test command: blocked"); expect(t).toContain("Time Sheriff");
    w.location.hash = "#/health"; await new Promise((r) => setTimeout(r, 300));
    expect(text(doc)).toContain("Memory and disk");
  });
});
