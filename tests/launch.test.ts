import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isUp, pidOf, stopService } from "../src/service/launch.js";
import type { Profile } from "../src/config/profiles.js";
import { tmp } from "./helpers/git-fixture.js";

const profile = (port: number): Profile => { const home = tmp(); mkdirSync(home, { recursive: true }); return { name: "t", home, port }; };

describe("background service helpers", () => {
  it("isUp tells a live factory from nothing at all", async () => {
    const srv = createServer((req, res) => { res.statusCode = req.url === "/health" ? 200 : 404; res.end("{}"); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    expect(await isUp(profile(port))).toBe(true);
    srv.close();
    expect(await isUp(profile(port))).toBe(false);
  });
  it("reads the pid from the lock file, and ignores garbage", () => {
    const p = profile(1); writeFileSync(join(p.home, "factory.lock"), "4242");
    expect(pidOf(p)).toBe(4242);
    writeFileSync(join(p.home, "factory.lock"), "not a pid");
    expect(pidOf(p)).toBeNull();
    expect(pidOf(profile(1))).toBeNull();                      // no lock file
  });
  it("stops the process named in the lock file, and says so when nothing is running", async () => {
    const p = profile(1);
    expect(await stopService(p)).toBe("not-running");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    writeFileSync(join(p.home, "factory.lock"), String(child.pid));
    expect(await stopService(p, 5000)).toBe("stopped");
    expect(child.signalCode ?? child.exitCode).not.toBeNull();  // really gone (it was SIGTERMed)
    expect(await stopService(p)).toBe("not-running");
  });
});
