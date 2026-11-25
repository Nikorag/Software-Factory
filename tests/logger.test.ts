import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { REDACT_PATHS } from "../src/logging/logger.js";

describe("logger redaction", () => {
  it("never emits secret-bearing fields", () => {
    let out = "";
    const sink = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
    pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, sink).info({ linear: { apiKey: "lin_secret" }, env: { X: "y" } }, "hi");
    expect(out).not.toContain("lin_secret");
    expect(out).toContain("[REDACTED]");
  });
});
