import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { TEST_ENV, testConfig } from "./helpers.js";

describe("config", () => {
  it("applies documented defaults", () => {
    const c = testConfig(); expect(c.PORT).toBe(8080); expect(c.DATABASE_POOL_MAX).toBe(10); expect(c.REDIS_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });
  it("fails fast listing missing names but never values", () => {
    const rest: Record<string, string> = { ...TEST_ENV }; delete rest.SESSION_SECRET; delete rest.SETUP_TOKEN;
    try { loadConfig({ ...rest, FACTORY_TOKEN_PEPPER: "short-secret-value" }); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const m = (e as Error).message; expect(m).toContain("SESSION_SECRET"); expect(m).toContain("SETUP_TOKEN"); expect(m).toContain("FACTORY_TOKEN_PEPPER");
      expect(m).not.toContain("short-secret-value");
    }
  });
  it("VAPID is optional, but all-or-none", () => {
    const rest: Record<string, string> = { ...TEST_ENV }; for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) delete rest[k];
    expect(loadConfig(rest).VAPID_PRIVATE_KEY).toBeUndefined();
    expect(() => loadConfig({ ...rest, VAPID_PUBLIC_KEY: "pub" })).toThrow(/together/);
  });
  it("rejects a bad VAPID subject", () => { expect(() => testConfig({ VAPID_SUBJECT: "ops@example.test" })).toThrow(/VAPID_SUBJECT/); });
});
