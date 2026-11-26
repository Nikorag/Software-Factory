import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { TEST_ENV, testConfig } from "./helpers.js";

describe("config", () => {
  it("applies documented defaults", () => {
    const c = testConfig(); expect(c.PORT).toBe(8080); expect(c.DATABASE_POOL_MAX).toBe(10); expect(c.REDIS_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });
  it("fails fast listing missing names but never values", () => {
    const rest: Record<string, string> = { ...TEST_ENV }; delete rest.SESSION_SECRET; delete rest.VAPID_PRIVATE_KEY;
    try { loadConfig({ ...rest, FACTORY_TOKEN_PEPPER: "short-secret-value" }); expect.unreachable(); }
    catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const m = (e as Error).message; expect(m).toContain("SESSION_SECRET"); expect(m).toContain("VAPID_PRIVATE_KEY"); expect(m).toContain("FACTORY_TOKEN_PEPPER");
      expect(m).not.toContain("short-secret-value");
    }
  });
  it("rejects a bad VAPID subject", () => { expect(() => testConfig({ VAPID_SUBJECT: "ops@example.test" })).toThrow(/VAPID_SUBJECT/); });
});
