import { describe, expect, it } from "vitest";
import { createECDH } from "node:crypto";
import { ConfigError, loadConfig, vapidConfigProblem, vapidProblem } from "../src/config.js";
import { createWebPushSender } from "../src/push.js";
import { TEST_ENV, TEST_VAPID, testConfig } from "./helpers.js";

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
  it("checks the VAPID keys (browsers otherwise fail later with \"Invalid raw ECDSA P-256 public key\")", () => {
    const { publicKey: pub, privateKey: priv } = TEST_VAPID;
    expect(vapidProblem(pub, priv)).toBeNull();
    expect(vapidProblem(priv, pub)).toMatch(/look swapped/);
    expect(vapidProblem(`"${pub}"`, priv)).toMatch(/not base64url/);
    expect(vapidProblem(`${pub}\n`, priv)).toMatch(/spaces or a line break/);
    expect(vapidProblem(Buffer.from(pub, "base64url").toString("base64"), priv)).toMatch(/base64url|belong/); // standard base64 (+ and /) is a different key
    expect(vapidProblem(pub.slice(0, 40), priv)).toMatch(/65 bytes starting 0x04/);
    const other = createECDH("prime256v1"); other.generateKeys();
    expect(vapidProblem(other.getPublicKey().toString("base64url"), priv)).toMatch(/does not belong/);
    // A bad key turns push off with a reason; the hub itself still starts (push is optional).
    const swapped = testConfig({ VAPID_PUBLIC_KEY: priv, VAPID_PRIVATE_KEY: pub });
    expect(vapidConfigProblem(swapped)).toMatch(/look swapped/);
    expect(vapidConfigProblem(swapped)).not.toContain(priv); // never echoes a key
    expect(createWebPushSender(swapped)).toBeNull();
    expect(createWebPushSender(testConfig())).not.toBeNull();
  });
  it("rejects a bad VAPID subject", () => { expect(() => testConfig({ VAPID_SUBJECT: "ops@example.test" })).toThrow(/VAPID_SUBJECT/); });
});
