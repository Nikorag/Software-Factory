import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneAgentLogs } from "../src/service/retention.js";
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
