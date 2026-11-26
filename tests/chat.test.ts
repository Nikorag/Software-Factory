import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
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
    const res = await chat(s.app, s.job.id, { message: "Why did it fail?", history: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi there" }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ reply: "It failed because of the build." });
    expect(seen!.projectId).toBe("p");
    expect(seen!.prompt).toContain("status=failed");
    expect(seen!.prompt).toContain("give up after 3 attempts");
    expect(seen!.prompt).toContain("Developer: hello");
    expect(seen!.prompt).toContain("Assistant: hi there");
    expect(seen!.prompt).toContain("Developer: Why did it fail?");
    expect(seen!.prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
    expect(seen!.cwd.endsWith("/chat")).toBe(true);
  });

  it("reports an agent failure as a 502 with its reason", async () => {
    const s = setup(async () => ({ ok: false, text: "", error: "not logged in" }));
    const res = await chat(s.app, s.job.id, { message: "why?" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("not logged in");
  });
});
