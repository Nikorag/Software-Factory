import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticateSession, createSession, SESSION_COOKIE } from "./auth.js";
import { audit } from "./commands.js";
import type { Queryable } from "./db.js";
import type { Deps } from "./server.js";

// Authentication is passkey-only. There is no password, no recovery-by-email and no other factor to
// fall back to: registration and login both demand user verification (biometric/PIN) and a
// discoverable credential. The only way to create the first user is the one-time SETUP_TOKEN.

const CHALLENGE_TTL_S = 300;
const digest = (v: string) => createHash("sha256").update(v).digest();
const tokenOk = (given: string, want: string) => timingSafeEqual(digest(given), digest(want));

const setupOptsBody = z.object({ setupToken: z.string().min(1).max(200), email: z.email().max(200), displayName: z.string().min(1).max(100) });
const verifyBody = z.object({ challengeId: z.uuid(), response: z.object({ id: z.string() }).loose() });
const inviteOptsBody = z.object({ token: z.string().min(20).max(200), email: z.email().max(200), displayName: z.string().min(1).max(100) });
const INVITE_TTL_DAYS = 7;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const addLabel = z.object({ label: z.string().max(100).optional() });

export function setSessionCookie(d: Deps, reply: FastifyReply, cookie: string, expiresAt: Date) {
  const secure = d.cfg.PUBLIC_URL.startsWith("https://") ? "; Secure" : "";
  reply.header("set-cookie", `${SESSION_COOKIE}=${encodeURIComponent(cookie)}; HttpOnly; SameSite=Strict; Path=/; Expires=${expiresAt.toUTCString()}${secure}`);
}

export function registerAuthRoutes(app: FastifyInstance, d: Deps, requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  const { cfg, db } = d;
  const rp = { rpID: cfg.WEBAUTHN_RP_ID, rpName: cfg.WEBAUTHN_RP_NAME };
  const hasUsers = async (q: Queryable = db) => ((await q.query<{ n: number }>("SELECT count(*)::int AS n FROM users")).rows[0]!.n) > 0;

  async function saveChallenge(purpose: string, challenge: string, userId: string | null, data: object): Promise<string> {
    return (await db.query<{ id: string }>("INSERT INTO webauthn_challenges (purpose, challenge, user_id, data, expires_at) VALUES ($1,$2,$3,$4, now() + $5 * interval '1 second') RETURNING id",
      [purpose, challenge, userId, JSON.stringify(data), CHALLENGE_TTL_S])).rows[0]!.id;
  }
  // Single use: consumed even if verification then fails, so a challenge can never be retried or replayed.
  async function takeChallenge(id: string, purpose: string, userId?: string) {
    const r = await db.query<{ challenge: string; data: { email?: string; displayName?: string; userHandle?: string; inviteId?: string } }>(
      "DELETE FROM webauthn_challenges WHERE id=$1 AND purpose=$2 AND expires_at > now() AND ($3::uuid IS NULL OR user_id = $3) RETURNING challenge, data", [id, purpose, userId ?? null]);
    return r.rows[0];
  }
  const startSession = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const s = await createSession(cfg, db, userId, req.headers["user-agent"]);
    setSessionCookie(d, reply, s.cookie, s.expiresAt);
  };
  const bad = (reply: FastifyReply, code = 400, msg = "verification_failed") => reply.code(code).send({ error: msg });

  app.get("/auth/status", async (req) => {
    const who = await authenticateSession(cfg, db, req.headers.cookie);
    return { needsSetup: !(await hasUsers()), authenticated: !!who };
  });

  // ---- First-time setup: create the first user + their first passkey ----
  app.post("/auth/setup/options", async (req, reply) => {
    const b = setupOptsBody.parse(req.body);
    if (await hasUsers()) return bad(reply, 403, "setup_closed");
    if (!tokenOk(b.setupToken, cfg.SETUP_TOKEN)) { req.log.warn("setup attempt with wrong token"); return bad(reply, 403, "invalid_setup_token"); }
    const userHandle = randomBytes(32);
    const options = await generateRegistrationOptions({ ...rp, userName: b.email, userDisplayName: b.displayName, userID: userHandle, attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    const challengeId = await saveChallenge("setup", options.challenge, null, { email: b.email, displayName: b.displayName, userHandle: userHandle.toString("base64url") });
    return { challengeId, options };
  });

  app.post("/auth/setup/verify", async (req, reply) => {
    const b = verifyBody.parse(req.body);
    const ch = await takeChallenge(b.challengeId, "setup");
    if (!ch) return bad(reply);
    let v;
    try { v = await verifyRegistrationResponse({ response: b.response as unknown as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: cfg.WEBAUTHN_ORIGIN, expectedRPID: cfg.WEBAUTHN_RP_ID, requireUserVerification: true }); }
    catch (e) { req.log.warn({ err: (e as Error).message }, "setup verification failed"); return bad(reply); }
    if (!v.verified) return bad(reply);
    const info = v.registrationInfo;
    const userId = await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(7352902)"); // two concurrent setups: exactly one wins
      if (await hasUsers(q)) return null;
      const u = (await q.query<{ id: string }>("INSERT INTO users (email, display_name, webauthn_user_handle) VALUES ($1,$2,$3) RETURNING id", [ch.data.email, ch.data.displayName, Buffer.from(ch.data.userHandle!, "base64url")])).rows[0]!.id;
      await storeCredential(q, u, info);
      const org = (await q.query<{ id: string }>("INSERT INTO organisations (slug, name) VALUES ('default', $1) RETURNING id", [`${ch.data.displayName}'s factories`])).rows[0]!.id;
      await q.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')", [org, u]);
      await audit(q, org, "user", u, "user.setup", u, {});
      return u;
    });
    if (!userId) return bad(reply, 403, "setup_closed");
    await startSession(req, reply, userId);
    return { ok: true };
  });

  // ---- Invites: a signed-in user mints a single-use token; the invitee registers a passkey and gets their own organisation ----
  app.post("/v1/invites", { preHandler: requireUser }, async (req) => {
    const token = randomBytes(32).toString("base64url");
    const r = (await db.query<{ id: string; expires_at: Date }>("INSERT INTO invites (token_hash, created_by, expires_at) VALUES ($1,$2, now() + $3 * interval '1 day') RETURNING id, expires_at", [hashToken(token), req.user!.userId, INVITE_TTL_DAYS])).rows[0]!;
    await audit(db, null, "user", req.user!.userId, "invite.create", r.id, {});
    // The token goes in the URL fragment so it never reaches server logs or Referer headers.
    return { id: r.id, token, url: `${cfg.PUBLIC_URL.replace(/\/$/, "")}/#invite=${token}`, expiresAt: r.expires_at };
  });

  app.get("/v1/invites", { preHandler: requireUser }, async (req) => ({
    invites: (await db.query(`SELECT i.id, i.created_at AS "createdAt", i.expires_at AS "expiresAt", i.used_at AS "usedAt", u.email AS "usedByEmail"
      FROM invites i LEFT JOIN users u ON u.id = i.used_by WHERE i.created_by=$1 AND i.revoked_at IS NULL ORDER BY i.created_at DESC LIMIT 50`, [req.user!.userId])).rows,
  }));

  app.delete("/v1/invites/:id", { preHandler: requireUser }, async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const r = await db.query("UPDATE invites SET revoked_at = now() WHERE id=$1 AND created_by=$2 AND used_at IS NULL AND revoked_at IS NULL", [id, req.user!.userId]);
    return r.rowCount ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  const inviteUsable = (q: Queryable, token: string) => q.query<{ id: string }>("SELECT id FROM invites WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()", [hashToken(token)]);

  app.post("/auth/invite/options", async (req, reply) => {
    const b = inviteOptsBody.parse(req.body);
    const inv = (await inviteUsable(db, b.token)).rows[0];
    if (!inv) return bad(reply, 403, "invalid_invite");
    if ((await db.query("SELECT 1 FROM users WHERE lower(email)=lower($1)", [b.email])).rows.length) return bad(reply, 409, "email_taken");
    const userHandle = randomBytes(32);
    const options = await generateRegistrationOptions({ ...rp, userName: b.email, userDisplayName: b.displayName, userID: userHandle, attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    const challengeId = await saveChallenge("invite", options.challenge, null, { email: b.email, displayName: b.displayName, userHandle: userHandle.toString("base64url"), inviteId: inv.id });
    return { challengeId, options };
  });

  app.post("/auth/invite/verify", async (req, reply) => {
    const b = verifyBody.parse(req.body);
    const ch = await takeChallenge(b.challengeId, "invite");
    if (!ch?.data.inviteId) return bad(reply);
    let v;
    try { v = await verifyRegistrationResponse({ response: b.response as unknown as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: cfg.WEBAUTHN_ORIGIN, expectedRPID: cfg.WEBAUTHN_RP_ID, requireUserVerification: true }); }
    catch (e) { req.log.warn({ err: (e as Error).message }, "invite verification failed"); return bad(reply); }
    if (!v.verified) return bad(reply);
    const info = v.registrationInfo;
    let userId: string | null;
    try {
      userId = await db.tx(async (q) => {
        // Claim the invite atomically: of two concurrent registrations, exactly one wins.
        const claimed = await q.query<{ created_by: string }>("UPDATE invites SET used_at = now() WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING created_by", [ch.data.inviteId]);
        if (!claimed.rowCount) return null;
        const u = (await q.query<{ id: string }>("INSERT INTO users (email, display_name, webauthn_user_handle) VALUES ($1,$2,$3) RETURNING id", [ch.data.email, ch.data.displayName, Buffer.from(ch.data.userHandle!, "base64url")])).rows[0]!.id;
        await q.query("UPDATE invites SET used_by=$2 WHERE id=$1", [ch.data.inviteId, u]);
        await storeCredential(q, u, info);
        const org = (await q.query<{ id: string }>("INSERT INTO organisations (slug, name) VALUES ($1, $2) RETURNING id", [`org-${u}`, `${ch.data.displayName}'s factories`])).rows[0]!.id;
        await q.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')", [org, u]);
        await audit(q, org, "user", u, "user.invited", u, { invitedBy: claimed.rows[0]!.created_by });
        return u;
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return bad(reply, 409, "email_taken"); // someone registered this email since the options call
      throw e;
    }
    if (!userId) return bad(reply, 403, "invalid_invite");
    await startSession(req, reply, userId);
    return { ok: true };
  });

  // ---- Login (usernameless: the passkey identifies the user) ----
  app.post("/auth/login/options", async () => {
    const options = await generateAuthenticationOptions({ rpID: cfg.WEBAUTHN_RP_ID, userVerification: "required" });
    return { challengeId: await saveChallenge("login", options.challenge, null, {}), options };
  });

  app.post("/auth/login/verify", async (req, reply) => {
    const b = verifyBody.parse(req.body);
    const ch = await takeChallenge(b.challengeId, "login");
    if (!ch) return bad(reply);
    const cred = (await db.query<{ id: string; user_id: string; public_key: Buffer; sign_count: number; transports: string[] }>(
      `SELECT c.id, c.user_id, c.public_key, c.sign_count, c.transports FROM passkey_credentials c JOIN users u ON u.id = c.user_id
        WHERE c.credential_id = $1 AND u.disabled_at IS NULL`, [Buffer.from(b.response.id, "base64url")])).rows[0];
    if (!cred) return bad(reply, 401, "unknown_credential");
    let v;
    try {
      v = await verifyAuthenticationResponse({ response: b.response as unknown as AuthenticationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: cfg.WEBAUTHN_ORIGIN, expectedRPID: cfg.WEBAUTHN_RP_ID, requireUserVerification: true,
        credential: { id: b.response.id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.sign_count), transports: cred.transports as never } });
    } catch (e) { req.log.warn({ err: (e as Error).message }, "login verification failed"); return bad(reply, 401); }
    if (!v.verified) return bad(reply, 401);
    await db.query("UPDATE passkey_credentials SET sign_count = $2, last_used_at = now(), backed_up = $3 WHERE id = $1", [cred.id, v.authenticationInfo.newCounter, v.authenticationInfo.credentialBackedUp]);
    await startSession(req, reply, cred.user_id);
    req.log = req.log.child({ userId: cred.user_id });
    req.log.info("login");
    return { ok: true };
  });

  app.post("/auth/logout", async (req, reply) => {
    const who = await authenticateSession(cfg, db, req.headers.cookie);
    if (who) await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [who.sessionId]);
    reply.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  // ---- Manage passkeys while signed in (add another device; never remove the last) ----
  app.get("/v1/passkeys", { preHandler: requireUser }, async (req) => ({
    passkeys: (await db.query("SELECT id, label, device_type AS \"deviceType\", backed_up AS \"backedUp\", created_at AS \"createdAt\", last_used_at AS \"lastUsedAt\" FROM passkey_credentials WHERE user_id=$1 ORDER BY created_at", [req.user!.userId])).rows,
  }));

  app.post("/v1/passkeys/options", { preHandler: requireUser }, async (req) => {
    const u = (await db.query<{ email: string; display_name: string; webauthn_user_handle: Buffer }>("SELECT email, display_name, webauthn_user_handle FROM users WHERE id=$1", [req.user!.userId])).rows[0]!;
    const existing = (await db.query<{ credential_id: Buffer }>("SELECT credential_id FROM passkey_credentials WHERE user_id=$1", [req.user!.userId])).rows;
    const options = await generateRegistrationOptions({ ...rp, userName: u.email, userDisplayName: u.display_name, userID: new Uint8Array(u.webauthn_user_handle), attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: Buffer.from(c.credential_id).toString("base64url") })), authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    return { challengeId: await saveChallenge("add-passkey", options.challenge, req.user!.userId, {}), options };
  });

  app.post("/v1/passkeys/verify", { preHandler: requireUser }, async (req, reply) => {
    const b = verifyBody.extend({ label: addLabel.shape.label }).parse(req.body);
    const ch = await takeChallenge(b.challengeId, "add-passkey", req.user!.userId);
    if (!ch) return bad(reply);
    try {
      const v = await verifyRegistrationResponse({ response: b.response as unknown as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: cfg.WEBAUTHN_ORIGIN, expectedRPID: cfg.WEBAUTHN_RP_ID, requireUserVerification: true });
      if (!v.verified) return bad(reply);
      await storeCredential(db, req.user!.userId, v.registrationInfo, b.label);
    } catch (e) { req.log.warn({ err: (e as Error).message }, "add passkey failed"); return bad(reply); }
    return { ok: true };
  });

  app.delete("/v1/passkeys/:id", { preHandler: requireUser }, async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const r = await db.tx(async (q) => {
      const n = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM passkey_credentials WHERE user_id=$1", [req.user!.userId])).rows[0]!.n;
      if (n <= 1) return "last";
      return (await q.query("DELETE FROM passkey_credentials WHERE id=$1 AND user_id=$2", [id, req.user!.userId])).rowCount ? "ok" : "missing";
    });
    if (r === "last") return reply.code(409).send({ error: "cannot_remove_last_passkey" });
    return r === "ok" ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });
}

async function storeCredential(q: Queryable, userId: string, info: { credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] }; aaguid: string; credentialDeviceType: string; credentialBackedUp: boolean }, label?: string) {
  await q.query(`INSERT INTO passkey_credentials (user_id, credential_id, public_key, sign_count, transports, aaguid, device_type, backed_up, label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, Buffer.from(info.credential.id, "base64url"), Buffer.from(info.credential.publicKey), info.credential.counter, info.credential.transports ?? [], info.aaguid, info.credentialDeviceType, info.credentialBackedUp, label ?? null]);
}
