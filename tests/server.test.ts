import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb } from "../src/db/client.js";
import { buildServer } from "../src/server/app.js";

describe("server", () => {
  const make = () => buildServer({ db: openDb(":memory:").db, logger: pino({ level: "silent" }) });
  it("serves health from loopback", async () => {
    const res = await make().inject({ method: "GET", url: "/health", remoteAddress: "127.0.0.1" });
    expect(res.json()).toEqual({ status: "ok", paused: false, emergencyStop: false });
  });
  it("rejects non-loopback peers", async () => {
    const res = await make().inject({ method: "GET", url: "/health", remoteAddress: "192.168.1.20" });
    expect(res.statusCode).toBe(403);
  });
});
