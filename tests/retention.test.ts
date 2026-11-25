import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneAgentLogs, rotateLogs, SERVICE_LOGS } from "../src/service/retention.js";
import { tmp } from "./helpers/git-fixture.js";

const age = (f: string, days: number) => { const t = (Date.now() - days * 86_400_000) / 1000; utimesSync(f, t, t); };
describe("log retention", () => {
  it("removes logs older than the limit and their emptied folders, keeps recent ones", () => {
    const dir = tmp();
    mkdirSync(join(dir, "old-job"), { recursive: true }); mkdirSync(join(dir, "new-job"), { recursive: true });
    writeFileSync(join(dir, "old-job", "a.log"), "x"); age(join(dir, "old-job", "a.log"), 40);
    writeFileSync(join(dir, "new-job", "b.log"), "x"); age(join(dir, "new-job", "b.log"), 2);
    expect(pruneAgentLogs(dir, 30)).toBe(1);
    expect(existsSync(join(dir, "old-job"))).toBe(false);
    expect(existsSync(join(dir, "new-job", "b.log"))).toBe(true);
  });
  it("keeps everything when set to 0, and never follows a symlink out of the directory", () => {
    const dir = tmp(), outside = tmp();
    writeFileSync(join(outside, "precious.txt"), "x"); age(join(outside, "precious.txt"), 400);
    symlinkSync(outside, join(dir, "escape"));
    mkdirSync(join(dir, "j")); writeFileSync(join(dir, "j", "a.log"), "x"); age(join(dir, "j", "a.log"), 400);
    expect(pruneAgentLogs(dir, 0)).toBe(0);
    expect(pruneAgentLogs(dir, 30)).toBe(1);
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
  });
});

describe("log rotation", () => {
  it("rotates every service log over the size limit, keeps K old copies, and leaves small ones alone", () => {
    const dir = tmp();
    expect(SERVICE_LOGS).toEqual(expect.arrayContaining(["factory.log", "service.out", "launchd.out.log", "launchd.err.log"]));
    writeFileSync(join(dir, "small.log"), "x".repeat(10));
    for (let gen = 1; gen <= 4; gen++) {
      writeFileSync(join(dir, "big.log"), `gen${gen}`.padEnd(200, "."));
      expect(rotateLogs(dir, ["big.log", "small.log", "missing.log"], 100, 2)).toEqual(["big.log"]);
    }
    expect(statSync(join(dir, "big.log")).size).toBe(0);
    expect(readFileSync(join(dir, "big.log.1"), "utf8")).toMatch(/^gen4/);
    expect(readFileSync(join(dir, "big.log.2"), "utf8")).toMatch(/^gen3/);
    expect(existsSync(join(dir, "big.log.3"))).toBe(false);
    expect(readFileSync(join(dir, "small.log"), "utf8")).toBe("x".repeat(10));
  });
  it("truncates in place, so a writer holding the file open in append mode carries on in the same file", () => {
    const dir = tmp(), f = join(dir, "service.out");
    const fd = openSync(f, "a"); // like the stdout of a detached service
    writeSync(fd, "y".repeat(500));
    rotateLogs(dir, ["service.out"], 100, 1);
    writeSync(fd, "after"); closeSync(fd);
    expect(readFileSync(f, "utf8")).toBe("after");
    expect(readFileSync(`${f}.1`, "utf8")).toBe("y".repeat(500));
  });
  it("never rotates through a symlink", () => {
    const dir = tmp(), outside = tmp();
    appendFileSync(join(outside, "target.log"), "z".repeat(500));
    symlinkSync(join(outside, "target.log"), join(dir, "factory.log"));
    expect(rotateLogs(dir, ["factory.log"], 100, 1)).toEqual([]);
    expect(statSync(join(outside, "target.log")).size).toBe(500);
  });
});
