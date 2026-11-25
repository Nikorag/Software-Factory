import { describe, expect, it } from "vitest";
import { forgetGhTokens, ghEnv, GhAccountError } from "../src/repo/gh.js";
import { createGhApi } from "../src/repo/inspect.js";

describe("gh account scoping", () => {
  it("uses gh's active login (no injected token) when no account is configured", async () => {
    const before = process.env.GH_TOKEN;
    delete process.env.GH_TOKEN;
    const env = await ghEnv(undefined);
    expect(env.GH_TOKEN).toBeUndefined();
    if (before) process.env.GH_TOKEN = before;
  });
  it("fails loudly for an account gh has no login for, instead of silently using another account", async () => {
    forgetGhTokens();
    await expect(ghEnv("no-such-account-zzz-factory-test")).rejects.toBeInstanceOf(GhAccountError);
    // ...and the API wrapper reports it as an inaccessible repo (status 0) rather than throwing or falling back
    const res = await createGhApi("no-such-account-zzz-factory-test")("repos/x/y");
    expect(res.status).toBe(0);
    expect(String(res.body)).toContain("no-such-account-zzz-factory-test");
  });
});
