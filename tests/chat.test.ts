import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { enqueue } from "../src/core/jobs.js";
import { openDb } from "../src/db/client.js";
import { decisions, jobs, projects } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { buildServer } from "../src/server/app.js";
import type { ChatRun } from "../src/server/chat.js";
import { fixtureConfig } from "./helpers/config.js";
import { tmp } from "./helpers/git-fixture.js";

const TOKEN = "t".repeat(64);
const AUTH = { host: "127.0.0.1:4780", authorization: `Bearer ${TOKEN}` };

function setup(run?: ChatRun) {
  const { db } = openDb(":memory:");
  const dataDir = tmp();
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  db.insert(projects).values({ id: "p", configJson: "{}" }).run();
  const app = buildServer({ db, logger: pino({ level: "silent" }), config: fixtureConfig(), dataDir, port: 4780, controlToken: TOKEN, ...(run ? { chat: { run } } : {}) });
  const job = enqueue(db, { projectId: "p", externalId: "J-1", externalKey: "J-1" }).job;
  return { db, app, job };
}
const chat = (app: ReturnType<typeof setup>["app"], id: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method: "POST", url: `/api/jobs/${id}/chat`, headers, remoteAddress: "127.0.0.1", payload: payload as object });

const poll = (app: ReturnType<typeof setup>["app"], jobId: string, id: string) =>
  app.inject({ method: "GET", url: `/api/jobs/${jobId}/chat/${id}`, headers: { host: AUTH.host }, remoteAddress: "127.0.0.1" });
/** Start a chat and wait for it to finish, as the dashboard does. */
async function ask(s: ReturnType<typeof setup>, payload: unknown) {
  const start = await chat(s.app, s.job.id, payload);
  expect(start.statusCode, start.body).toBe(202);
  const id = start.json().id as string;
  let last = await poll(s.app, s.job.id, id);
  await vi.waitFor(async () => { last = await poll(s.app, s.job.id, id); expect(last.json().status).not.toBe("running"); });
  return { id, res: last };
}

describe("job chat", () => {
  it("needs the token, a known job and a valid message", async () => {
    const calls: string[] = [];
    const s = setup(async (r) => { calls.push(r.prompt); return { ok: true, text: "hi" }; });
    expect((await chat(s.app, s.job.id, { message: "why?" }, { host: AUTH.host })).statusCode).toBe(401);
    expect((await chat(s.app, "nope", { message: "why?" })).statusCode).toBe(404);
    expect((await chat(s.app, s.job.id, { message: "  " })).statusCode).toBe(400);
    expect((await chat(s.app, s.job.id, { message: "x".repeat(4001) })).statusCode).toBe(400);
    expect((await chat(s.app, s.job.id, { message: "ok", history: Array(21).fill({ role: "user", text: "a" }) })).statusCode).toBe(400);
    expect(calls).toHaveLength(0); // nothing reached the agent
  });

  it("answers 503 when the service has no agent wired", async () => {
    const s = setup();
    expect((await chat(s.app, s.job.id, { message: "why?" })).statusCode).toBe(503);
  });

  it("gives the agent the job's evidence (with secrets redacted) and the conversation so far, in an empty directory", async () => {
    let seen: Parameters<ChatRun>[0] | undefined;
    const s = setup(async (r) => { seen = r; return { ok: true, text: "It failed because of the build." }; });
    s.db.update(jobs).set({ status: "failed", lastError: "build failed with token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" }).where(eq(jobs.id, s.job.id)).run();
    s.db.insert(decisions).values({ jobId: s.job.id, kind: "stage.failed", decision: "give up after 3 attempts", rationale: "tests red", actor: "factory" }).run();
    const { res } = await ask(s, { message: "Why did it fail?", history: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi there" }] });
    expect(res.json()).toEqual({ status: "done", reply: "It failed because of the build." });
    expect(seen!.projectId).toBe("p");
    expect(seen!.prompt).toContain("status=failed");
    expect(seen!.prompt).toContain("give up after 3 attempts");
    expect(seen!.prompt).toContain("Developer: hello");
    expect(seen!.prompt).toContain("Assistant: hi there");
    expect(seen!.prompt).toContain("Developer: Why did it fail?");
    expect(seen!.prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(seen!.cwd.endsWith("/chat")).toBe(true);
  });

  it("returns at once and reports an agent failure, with its reason, when polled", async () => {
    const s = setup(async () => ({ ok: false, text: "", error: "not logged in" }));
    const { res } = await ask(s, { message: "why?" });
    expect(res.json()).toEqual({ status: "error", error: "not logged in" });
  });

  it("answers a still-running chat as running, so a slow answer never blocks a request (the hub tunnel allows seconds)", async () => {
    let release!: () => void;
    const s = setup(() => new Promise((res) => { release = () => res({ ok: true, text: "done" }); }));
    const start = await chat(s.app, s.job.id, { message: "why?" });
    expect(start.statusCode).toBe(202);
    expect((await poll(s.app, s.job.id, start.json().id)).json()).toEqual({ status: "running" });
    release();
    await vi.waitFor(async () => expect((await poll(s.app, s.job.id, start.json().id)).json().status).toBe("done"));
  });

  it("only polls its own job's chats, and an unknown chat is a 404", async () => {
    const s = setup(async () => ({ ok: true, text: "hi" }));
    const { id } = await ask(s, { message: "why?" });
    const other = enqueue(s.db, { projectId: "p", externalId: "J-2", externalKey: "J-2" }).job;
    expect((await poll(s.app, other.id, id)).statusCode).toBe(404);
    expect((await poll(s.app, s.job.id, "00000000-0000-0000-0000-000000000000")).statusCode).toBe(404);
  });

  it("limits how many answers run at once", async () => {
    const s = setup(() => new Promise(() => { /* never finishes */ }));
    expect((await chat(s.app, s.job.id, { message: "one" })).statusCode).toBe(202);
    expect((await chat(s.app, s.job.id, { message: "two" })).statusCode).toBe(202);
    expect((await chat(s.app, s.job.id, { message: "three" })).statusCode).toBe(429);
  });
});
