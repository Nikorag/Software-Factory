import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Queryable } from "./db.js";

const hmac = (key: string, v: string) => createHmac("sha256", key).update(v).digest("hex");
const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// ---- Factory credentials: `sfh_<credentialId>.<secret>`; only HMAC(secret) is stored. ----

export async function issueFactoryCredential(cfg: Config, q: Queryable, factoryId: string, expiresAt?: Date): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  const row = await q.query<{ id: string }>(
    "INSERT INTO factory_credentials (factory_id, secret_hash, expires_at) VALUES ($1,$2,$3) RETURNING id",
    [factoryId, hmac(cfg.FACTORY_TOKEN_PEPPER, secret), expiresAt ?? null]);
  return `sfh_${row.rows[0]!.id}.${secret}`;
}

export interface FactoryPrincipal { factoryId: string; orgId: string; credentialId: string }

export async function authenticateFactory(cfg: Config, q: Queryable, header: string | undefined): Promise<FactoryPrincipal | null> {
  const m = /^Bearer sfh_([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(header ?? "");
  if (!m || !isUuid(m[1])) return null;
  const r = await q.query<{ secret_hash: string; factory_id: string; org_id: string; status: string }>(
    `SELECT c.secret_hash, c.factory_id, f.org_id, f.status FROM factory_credentials c JOIN factories f ON f.id = c.factory_id
      WHERE c.id = $1 AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())`, [m[1]]);
  const row = r.rows[0];
  if (!row || row.status === "disabled" || !safeEq(row.secret_hash, hmac(cfg.FACTORY_TOKEN_PEPPER, m[2]!))) return null;
  await q.query("UPDATE factory_credentials SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [m[1]]);
  return { factoryId: row.factory_id, orgId: row.org_id, credentialId: m[1] };
}

// ---- User sessions (database-backed so any replica can serve any request). Cookie: `<sessionId>.<secret>`. ----
// Passkey login (WebAuthn ceremony) creates these via createSession(); that flow is not part of this module.

export const SESSION_COOKIE = "sfh_session";

export async function createSession(cfg: Config, q: Queryable, userId: string, userAgent?: string): Promise<{ cookie: string; expiresAt: Date }> {
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + cfg.SESSION_TTL_SECONDS * 1000);
  const r = await q.query<{ id: string }>("INSERT INTO sessions (user_id, token_hash, expires_at, user_agent) VALUES ($1,'pending',$2,$3) RETURNING id", [userId, expiresAt, userAgent?.slice(0, 255) ?? null]);
  const id = r.rows[0]!.id;
  await q.query("UPDATE sessions SET token_hash = $2 WHERE id = $1", [id, hmac(cfg.SESSION_SECRET, `${id}.${secret}`)]);
  return { cookie: `${id}.${secret}`, expiresAt };
}

export interface UserPrincipal { userId: string; sessionId: string }

export async function authenticateSession(cfg: Config, q: Queryable, cookieHeader: string | undefined): Promise<UserPrincipal | null> {
  const raw = cookieHeader?.split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === SESSION_COOKIE)?.[1];
  const m = raw && /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,100})$/.exec(decodeURIComponent(raw));
  if (!m || !isUuid(m[1])) return null;
  const r = await q.query<{ token_hash: string; user_id: string }>(
    `SELECT s.token_hash, s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL`, [m[1]]);
  const row = r.rows[0];
  if (!row || !safeEq(row.token_hash, hmac(cfg.SESSION_SECRET, `${m[1]}.${m[2]}`))) return null;
  return { userId: row.user_id, sessionId: m[1] };
}

// ---- Authorisation ----

export type FactoryAction = "view" | "command" | "manage";
const ROLE_ALLOWS: Record<string, FactoryAction[]> = {
  owner: ["view", "command", "manage"], admin: ["view", "command", "manage"], member: ["view"], viewer: ["view"],
};

/** Org role grants baseline access; factory_permissions grants individual extras. */
export async function can(q: Queryable, userId: string, factoryId: string, action: FactoryAction): Promise<boolean> {
  const r = await q.query<{ role: string | null; perms: string[] | null }>(
    `SELECT m.role, (SELECT array_agg(p.permission) FROM factory_permissions p WHERE p.factory_id = f.id AND p.user_id = $1) AS perms
       FROM factories f LEFT JOIN memberships m ON m.org_id = f.org_id AND m.user_id = $1 WHERE f.id = $2`, [userId, factoryId]);
  const row = r.rows[0];
  if (!row) return false;
  if (row.role && ROLE_ALLOWS[row.role]?.includes(action)) return true;
  const perms = row.perms ?? [];
  return perms.includes(action) || (action === "view" && perms.length > 0) || (perms.includes("manage"));
}

export async function orgRole(q: Queryable, userId: string, orgId: string): Promise<string | null> {
  const r = await q.query<{ role: string }>("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
  return r.rows[0]?.role ?? null;
}
