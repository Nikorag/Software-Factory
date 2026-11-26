import { describe, expect, it } from "vitest";
import { createBullQueue, createRedisBus, createRedisRateLimiter, createRedisTunnel } from "../src/infra.js";
import { testConfig } from "./helpers.js";

// Runs against a real Redis only when REDIS_URL is set, e.g.:  REDIS_URL=redis://127.0.0.1:6379 pnpm test
const url = process.env.REDIS_URL;
describe.skipIf(!url)("redis adapters (real Redis)", () => {
  const cfg = () => testConfig({ REDIS_URL: url!, REDIS_KEY_PREFIX: `sftest${Date.now()}`, RATE_LIMIT_PER_MINUTE: "2" });

  it("bus: publish/subscribe/unsubscribe and ping", async () => {
    const bus = createRedisBus(cfg()); await bus.ping();
    const got: string[] = []; const un = await bus.subscribe("c1", (m) => got.push(m));
    await bus.publish("c1", "a"); await new Promise((r) => setTimeout(r, 100));
    await un(); await bus.publish("c1", "b"); await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual(["a"]); await bus.close();
  });

  it("queue: one job per command id, handler runs, and the id can be re-enqueued afterwards", async () => {
    const q = createBullQueue(cfg()); const seen: string[] = [];
    q.startWorker(async (id) => { seen.push(id); });
    await q.enqueue("cmd-1"); await q.enqueue("cmd-1");
    await new Promise((r) => setTimeout(r, 1000));
    expect(seen).toEqual(["cmd-1"]);
    await q.enqueue("cmd-1"); await new Promise((r) => setTimeout(r, 1000));
    expect(seen).toEqual(["cmd-1", "cmd-1"]);
    await q.close();
  });

  it("rate limiter: blocks past the limit", async () => {
    const l = createRedisRateLimiter(cfg());
    expect([await l.allow("k"), await l.allow("k"), await l.allow("k")]).toEqual([true, true, false]); await l.close();
  });

  it("tunnel: at-most-once take, single response, round trip across two connections, expiry", async () => {
    const c = cfg(); const busA = createRedisBus(c), busB = createRedisBus(c);
    const browserSide = createRedisTunnel(c, busA), factorySide = createRedisTunnel(c, busB);
    const req = { id: "11111111-1111-4111-8111-111111111111", method: "GET", path: "/api/overview", headers: {}, expiresAt: new Date(Date.now() + 5000).toISOString() };
    expect(await browserSide.push("f1", req)).toBe(true);
    const waiting = browserSide.awaitResponse(req.id, 5000);
    const [t1, t2] = await Promise.all([factorySide.take("f1", 10), factorySide.take("f1", 10)]);
    expect(t1.length + t2.length).toBe(1);
    expect(await factorySide.respond(req.id, { status: 200, headers: {}, bodyBase64: "e30=" })).toBe(true);
    expect(await factorySide.respond(req.id, { status: 200, headers: {}, bodyBase64: "e30=" })).toBe(false);
    expect(await waiting).toMatchObject({ status: 200 });
    // unanswered: times out, and a late answer is refused
    const late = { ...req, id: "22222222-2222-4222-8222-222222222222" };
    await browserSide.push("f1", late);
    expect(await browserSide.awaitResponse(late.id, 600)).toBeNull();
    expect(await factorySide.respond(late.id, { status: 200, headers: {}, bodyBase64: "" })).toBe(false);
    await busA.close(); await busB.close();
  });
});
