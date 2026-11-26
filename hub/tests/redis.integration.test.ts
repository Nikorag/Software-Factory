import { describe, expect, it } from "vitest";
import { createBullQueue, createRedisBus, createRedisRateLimiter } from "../src/infra.js";
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
});
