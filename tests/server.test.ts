import { describe, expect, it } from "vitest";
import pino from "pino";
import { openDb } from "../src/db/client.js";
import { buildServer, requestLogLevel } from "../src/server/app.js";

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

describe("request logging", () => {
  const capture = () => {
    const lines: { level: number; msg: string; method?: string; url?: string; statusCode?: number }[] = [];
    const logger = pino({ level: "info" }, { write: (s: string) => { lines.push(JSON.parse(s)); } });
    return { lines, app: buildServer({ db: openDb(":memory:").db, logger, port: 4780 }) };
  };
  const req = (app: ReturnType<typeof buildServer>, method: "GET" | "POST", url: string, host = "127.0.0.1:4780") => app.inject({ method, url, headers: { host }, remoteAddress: "127.0.0.1" });

  it("keeps routine polling out of the info log, but logs changes and errors without query strings", async () => {
    const { lines, app } = capture();
    for (let i = 0; i < 5; i++) await req(app, "GET", "/health");
    expect(lines.filter((l) => l.msg === "request" || l.msg === "incoming request" || l.msg === "request completed")).toEqual([]);
    await req(app, "POST", "/api/control/pause"); // no token: 401
    await req(app, "GET", "/health?code=secret", "evil.example.com"); // 403
    const logged = lines.filter((l) => l.msg === "request");
    expect(logged.map((l) => [l.method, l.url, l.statusCode])).toEqual([["POST", "/api/control/pause", 401], ["GET", "/health", 403]]);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });
  it("chooses the level from method and status", () => {
    expect(requestLogLevel("GET", 200)).toBe("debug");
    expect(requestLogLevel("HEAD", 204)).toBe("debug");
    expect(requestLogLevel("GET", 304)).toBe("info");
    expect(requestLogLevel("GET", 500)).toBe("info");
    expect(requestLogLevel("POST", 200)).toBe("info");
    expect(requestLogLevel("DELETE", 204)).toBe("info");
  });
});

describe("request error logging", () => {
  it("still logs a server error with its stack when request logging is off", async () => {
    const lines: { level: number; msg: string; err?: { message: string; stack?: string } }[] = [];
    const app = buildServer({ db: openDb(":memory:").db, logger: pino({ level: "info" }, { write: (s: string) => { lines.push(JSON.parse(s)); } }), port: 4780 });
    app.get("/boom", async () => { throw new Error("kaboom"); });
    const res = await app.inject({ method: "GET", url: "/boom", headers: { host: "127.0.0.1:4780" }, remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(500);
    const err = lines.find((l) => l.msg === "request failed");
    expect(err?.level).toBe(50); expect(err?.err?.message).toBe("kaboom"); expect(err?.err?.stack).toContain("kaboom");
    expect(lines.find((l) => l.msg === "request")).toMatchObject({ statusCode: 500 });
  });
});
