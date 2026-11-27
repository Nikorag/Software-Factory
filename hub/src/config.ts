import { createECDH } from "node:crypto";
import { z } from "zod";

// All configuration comes from the environment (ConfigMap + Secret in Kubernetes).
// Nothing here has a default that is a credential.
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  PORT: int(8080, 1),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PUBLIC_URL: z.url(),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: int(10, 1),
  DATABASE_IDLE_TIMEOUT_MS: int(30_000),
  DATABASE_CONNECT_TIMEOUT_MS: int(5_000, 1),
  DATABASE_STATEMENT_TIMEOUT_MS: int(15_000),
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_SSL_CA: z.string().optional(),

  REDIS_URL: z.string().min(1), // redis:// or rediss:// (TLS)
  REDIS_PASSWORD: z.string().optional(),
  REDIS_USERNAME: z.string().optional(),
  REDIS_TLS_CA: z.string().optional(),
  REDIS_TLS_REJECT_UNAUTHORIZED: bool.default(true),
  REDIS_KEY_PREFIX: z.string().default("sfhub"),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  // One-time secret that authorises creating the FIRST user (passkey enrolment). No other sign-up exists.
  SETUP_TOKEN: z.string().min(24, "SETUP_TOKEN must be at least 24 characters"),
  SESSION_TTL_SECONDS: int(60 * 60 * 24 * 14, 60),
  FACTORY_TOKEN_PEPPER: z.string().min(32, "FACTORY_TOKEN_PEPPER must be at least 32 characters"),

  WEBAUTHN_RP_ID: z.string().min(1),
  WEBAUTHN_RP_NAME: z.string().default("Software Factory Hub"),
  WEBAUTHN_ORIGIN: z.url(),

  // Web Push (VAPID) is optional: set all three to turn notifications on, or none to leave them off (generate with `node dist/cli.js vapid-generate`).
  // Keep the pair stable: browsers subscribe against the public key, so changing it ends every existing subscription.
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/, "VAPID_SUBJECT must be mailto: or https:").optional(),

  COMMAND_DEFAULT_TTL_SECONDS: int(3600, 10),
  COMMAND_LEASE_SECONDS: int(60, 5),
  COMMAND_MAX_DELIVERY_ATTEMPTS: int(5, 1),
  POLL_MAX_WAIT_SECONDS: int(25, 1),
  RATE_LIMIT_PER_MINUTE: int(300, 1),
  RECONCILE_INTERVAL_MS: int(15_000, 100),
  OUTBOX_INTERVAL_MS: int(1_000, 50),
  SHUTDOWN_DRAIN_MS: int(5_000),
  SHUTDOWN_TIMEOUT_MS: int(25_000, 1000),
  WEB_DIST_DIR: z.string().optional(), // built web/ dashboard to serve per factory; default: <app>/web
  TUNNEL_TIMEOUT_SECONDS: int(25, 1),
  TUNNEL_RATE_LIMIT_PER_MINUTE: int(1500, 1),
  RUN_BACKGROUND: bool.default(true), // false = API-only replica (no outbox relay / workers)
}).refine((c) => [c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY, c.VAPID_SUBJECT].filter(Boolean).length % 3 === 0, {
  path: ["VAPID_PUBLIC_KEY"], message: "set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together, or none of them",
});

/** Why the configured VAPID keys cannot be used (push then stays off; the hub runs on), or null when they are fine or not set. */
export const vapidConfigProblem = (c: Pick<Config, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY">): string | null =>
  c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY ? vapidProblem(c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY) : null;

const b64url = (s: string): Buffer | null => (/^[A-Za-z0-9_-]+={0,2}$/.test(s) ? Buffer.from(s, "base64url") : null);

/**
 * Why a VAPID key pair is unusable, or null. Browsers reject a bad public key only when someone turns notifications on, with
 * "Invalid raw ECDSA P-256 public key", so the hub checks it itself and says why (push stays off; nothing else is affected): base64url, a 65-byte uncompressed P-256 point for the public
 * key, 32 bytes for the private key, and the two belonging together. Never echoes the values.
 */
export function vapidProblem(publicKey: string, privateKey: string): string | null {
  const pub = b64url(publicKey.trim()), priv = b64url(privateKey.trim());
  if (publicKey !== publicKey.trim() || privateKey !== privateKey.trim()) return "a VAPID key has spaces or a line break around it (or quotes inside the value): remove them";
  if (!pub) return "VAPID_PUBLIC_KEY is not base64url (quotes, or standard base64 with + and /?)";
  if (!priv) return "VAPID_PRIVATE_KEY is not base64url (quotes, or standard base64 with + and /?)";
  if (pub.length === 32 && priv.length === 65) return "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY look swapped (the public key is 65 bytes, the private key 32)";
  if (pub.length !== 65 || pub[0] !== 4) return `VAPID_PUBLIC_KEY must be an uncompressed P-256 public key (65 bytes starting 0x04), but it is ${pub.length} bytes: generate a pair with \`node dist/cli.js vapid-generate\``;
  if (priv.length !== 32) return `VAPID_PRIVATE_KEY must be a 32-byte P-256 private key, but it is ${priv.length} bytes`;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) return "VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY: set both from the same `vapid-generate` run";
  } catch { return "VAPID_PRIVATE_KEY is not a valid P-256 private key"; }
  return null;
}

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names and reasons only: never echo values (they may be secrets).
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export class ConfigError extends Error {}
