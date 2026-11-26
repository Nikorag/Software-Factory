import type { Config } from "./config.js";
import { can } from "./auth.js";
import type { Db, Queryable } from "./db.js";
import { channels, type Bus, type DispatchQueue } from "./infra.js";
import type { Logger } from "pino";

export type CommandStatus = "pending" | "queued" | "delivered" | "acknowledged" | "succeeded" | "failed" | "expired" | "revoked" | "unknown";

export interface CommandRow {
  id: string; org_id: string; factory_id: string; type: string; payload: unknown; status: CommandStatus; repeatable: boolean;
  attempts: number; lease_token: string | null; lease_expires_at: Date | null; expires_at: Date; result: unknown; error: string | null;
  created_at: Date; completed_at: Date | null;
}

export class CommandError extends Error {
  constructor(public readonly code: "forbidden" | "not_found" | "conflict" | "invalid", message: string, public readonly status?: CommandStatus) { super(message); }
}

const OPEN_BEFORE_ACK = "('pending','queued','delivered')";

export class CommandService {
  constructor(private readonly cfg: Config, private readonly db: Db, private readonly queue: DispatchQueue, private readonly bus: Bus, private readonly log: Logger) {}

  // 1-3. Authorise, persist, and record the outbox entry in ONE transaction. If the transaction
  // commits, the command exists and the outbox guarantees it will be enqueued; if it rolls back,
  // neither exists. Nothing is ever put on Redis before this commit.
  async create(userId: string, factoryId: string, input: { type: string; payload?: unknown; ttlSeconds?: number; repeatable?: boolean; clientKey?: string }): Promise<{ command: CommandRow; created: boolean }> {
    return this.db.tx(async (q) => {
      if (!(await can(q, userId, factoryId, "command"))) throw new CommandError("forbidden", "not allowed to command this factory");
      const f = await q.query<{ org_id: string; status: string }>("SELECT org_id, status FROM factories WHERE id = $1 FOR SHARE", [factoryId]);
      const factory = f.rows[0];
      if (!factory) throw new CommandError("not_found", "factory not found");
      if (factory.status === "disabled") throw new CommandError("conflict", "factory is disabled");
      const ttl = Math.min(input.ttlSeconds ?? this.cfg.COMMAND_DEFAULT_TTL_SECONDS, 7 * 24 * 3600);
      const ins = await q.query<CommandRow>(
        `INSERT INTO remote_commands (org_id, factory_id, requested_by, type, payload, client_key, repeatable, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + $8 * interval '1 second')
         ON CONFLICT (factory_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,
        [factory.org_id, factoryId, userId, input.type, JSON.stringify(input.payload ?? {}), input.clientKey ?? null, input.repeatable ?? false, ttl]);
      const command = ins.rows[0];
      if (!command) { // same clientKey already submitted: return it rather than create a duplicate
        const ex = await q.query<CommandRow>("SELECT * FROM remote_commands WHERE factory_id = $1 AND client_key = $2", [factoryId, input.clientKey]);
        return { command: ex.rows[0]!, created: false };
      }
      await q.query("INSERT INTO outbox (topic, aggregate_id) VALUES ('command.dispatch', $1)", [command.id]);
      await audit(q, factory.org_id, "user", userId, "command.create", command.id, { type: input.type, factoryId });
      return { command, created: true };
    });
  }

  async revoke(userId: string, commandId: string): Promise<CommandRow> {
    return this.db.tx(async (q) => {
      const cur = (await q.query<CommandRow>("SELECT * FROM remote_commands WHERE id = $1 FOR UPDATE", [commandId])).rows[0];
      if (!cur) throw new CommandError("not_found", "command not found");
      if (!(await can(q, userId, cur.factory_id, "command"))) throw new CommandError("forbidden", "not allowed");
      if (cur.status === "revoked") return cur;
      if (!["pending", "queued", "delivered"].includes(cur.status))
        throw new CommandError("conflict", `command is ${cur.status}; it can no longer be revoked`, cur.status);
      const r = await q.query<CommandRow>("UPDATE remote_commands SET status='revoked', revoked_at=now(), updated_at=now(), lease_token=NULL WHERE id=$1 RETURNING *", [commandId]);
      await audit(q, cur.org_id, "user", userId, "command.revoke", commandId, {});
      return r.rows[0]!;
    });
  }

  async get(userId: string, commandId: string): Promise<CommandRow> {
    const cur = (await this.db.query<CommandRow>("SELECT * FROM remote_commands WHERE id = $1", [commandId])).rows[0];
    if (!cur || !(await can(this.db, userId, cur.factory_id, "view"))) throw new CommandError("not_found", "command not found");
    return cur;
  }

  // 4. Delivery: the factory pulls. The claim is a single atomic UPDATE using FOR UPDATE SKIP LOCKED,
  // so concurrent replicas/pollers never hand the same command to two holders. It reads PostgreSQL
  // directly, so delivery works even if Redis is down or was flushed.
  async claim(factoryId: string, limit = 5): Promise<Array<Pick<CommandRow, "id" | "type" | "payload" | "repeatable" | "expires_at" | "lease_token" | "lease_expires_at" | "attempts">>> {
    const r = await this.db.query<CommandRow>(
      `WITH c AS (
         SELECT id FROM remote_commands
          WHERE factory_id = $1 AND expires_at > now() AND attempts < $2
            AND ( status IN ('pending','queued')
               OR (status = 'delivered' AND lease_expires_at < now())
               OR (status = 'acknowledged' AND repeatable AND lease_expires_at < now()) )
          ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       UPDATE remote_commands r SET status='delivered', attempts = r.attempts + 1, lease_token = gen_random_uuid(),
              lease_expires_at = now() + $4 * interval '1 second', delivered_at = now(), updated_at = now()
         FROM c WHERE r.id = c.id
       RETURNING r.id, r.type, r.payload, r.repeatable, r.expires_at, r.lease_token, r.lease_expires_at, r.attempts`,
      [factoryId, this.cfg.COMMAND_MAX_DELIVERY_ATTEMPTS, limit, this.cfg.COMMAND_LEASE_SECONDS]);
    return r.rows;
  }

  // 5. Ack is the factory's permission to execute. It is refused for revoked/expired commands and
  // for stale leases, so a factory that is told "no" must not run the command. Re-acking with the
  // same lease token is idempotent and extends the lease (use it as a heartbeat for long commands).
  async ack(factoryId: string, commandId: string, leaseToken: string, extendSeconds?: number): Promise<{ ok: true } | { ok: false; status: CommandStatus | "unknown_command" }> {
    const secs = Math.min(Math.max(extendSeconds ?? this.cfg.COMMAND_LEASE_SECONDS, 5), 3600);
    const r = await this.db.query(
      `UPDATE remote_commands SET status='acknowledged', acknowledged_at = COALESCE(acknowledged_at, now()),
              lease_expires_at = now() + $4 * interval '1 second', updated_at = now()
        WHERE id=$1 AND factory_id=$2 AND lease_token=$3
          AND ( (status='delivered' AND expires_at > now()) OR status='acknowledged' )`, [commandId, factoryId, leaseToken, secs]);
    if (r.rowCount === 1) return { ok: true };
    const cur = (await this.db.query<{ status: CommandStatus }>("SELECT status FROM remote_commands WHERE id=$1 AND factory_id=$2", [commandId, factoryId])).rows[0];
    return { ok: false, status: cur?.status ?? "unknown_command" };
  }

  // 7. Result. Recorded exactly once; replaying the same result is a no-op success. A late result for a
  // command parked as 'unknown' (lease lapsed mid-run) is accepted: it resolves the unknown outcome.
  async complete(factoryId: string, commandId: string, leaseToken: string, outcome: "succeeded" | "failed", result: unknown, error?: string): Promise<{ ok: true; duplicate: boolean } | { ok: false; status: CommandStatus | "unknown_command" }> {
    const r = await this.db.query<{ org_id: string }>(
      `UPDATE remote_commands SET status=$4, result=$5, error=$6, completed_at=now(), updated_at=now()
        WHERE id=$1 AND factory_id=$2 AND lease_token=$3 AND status IN ('acknowledged','unknown') RETURNING org_id`,
      [commandId, factoryId, leaseToken, outcome, JSON.stringify(result ?? null), error?.slice(0, 2000) ?? null]);
    if (r.rowCount === 1) {
      await audit(this.db, r.rows[0]!.org_id, "factory", factoryId, `command.${outcome}`, commandId, {});
      return { ok: true, duplicate: false };
    }
    const cur = (await this.db.query<{ status: CommandStatus; lease_token: string | null }>("SELECT status, lease_token FROM remote_commands WHERE id=$1 AND factory_id=$2", [commandId, factoryId])).rows[0];
    if (cur && cur.lease_token === leaseToken && cur.status === outcome) return { ok: true, duplicate: true };
    return { ok: false, status: cur?.status ?? "unknown_command" };
  }

  // Queue-side handler (BullMQ worker): mark queued and wake any long-polling factory. Safe to run many
  // times for the same command: it only ever moves pending -> queued, and only wakes.
  async onDispatch(commandId: string): Promise<void> {
    const r = await this.db.query<{ factory_id: string }>(
      `UPDATE remote_commands SET status = CASE WHEN status='pending' THEN 'queued' ELSE status END, updated_at = now()
        WHERE id = $1 AND status IN ('pending','queued') AND expires_at > now() RETURNING factory_id`, [commandId]);
    const row = r.rows[0];
    if (row) await this.bus.publish(channels.wake(row.factory_id), commandId).catch(() => undefined);
  }

  // Outbox relay: moves committed outbox rows onto the Redis queue. At-least-once, which is fine
  // because enqueue is idempotent per command and onDispatch is idempotent.
  async relayOutbox(): Promise<number> {
    return this.db.tx(async (q) => {
      const rows = (await q.query<{ id: number; aggregate_id: string; attempts: number }>(
        `SELECT id, aggregate_id, attempts FROM outbox WHERE dispatched_at IS NULL AND available_at <= now()
          ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
      let sent = 0;
      for (const row of rows) {
        try {
          await this.queue.enqueue(row.aggregate_id);
          await q.query("UPDATE outbox SET dispatched_at = now() WHERE id = $1", [row.id]);
          sent++;
        } catch (e) {
          const delay = Math.min(2 ** row.attempts, 60);
          await q.query("UPDATE outbox SET attempts = attempts + 1, last_error = $2, available_at = now() + $3 * interval '1 second' WHERE id = $1", [row.id, String((e as Error).message).slice(0, 500), delay]);
          this.log.warn({ outboxId: row.id, commandId: row.aggregate_id, err: (e as Error).message }, "outbox enqueue failed; will retry");
          break; // Redis is likely down: stop hammering, try next tick
        }
      }
      return sent;
    });
  }

  // Periodic self-healing, safe to run on every replica concurrently (all statements are idempotent).
  async reconcile(): Promise<{ expired: number; unknown: number; requeued: number; failed: number; reenqueued: number }> {
    const n = async (sql: string, p: unknown[] = []) => (await this.db.query(sql, p)).rowCount;
    // Never executed: past TTL before the factory acknowledged.
    const expired = await n(`UPDATE remote_commands SET status='expired', lease_token=NULL, updated_at=now() WHERE status IN ${OPEN_BEFORE_ACK} AND expires_at <= now()`);
    // Acknowledged (maybe executing) and the lease lapsed without a result: re-run ONLY if repeatable.
    const unknown = await n(`UPDATE remote_commands SET status='unknown', error='lease lost during execution; outcome unknown, not re-run', updated_at=now()
        WHERE status='acknowledged' AND NOT repeatable AND lease_expires_at < now()`);
    const failed = await n(`UPDATE remote_commands SET status='failed', error='delivery attempts exhausted', completed_at=now(), updated_at=now()
        WHERE status IN ('delivered','acknowledged') AND lease_expires_at < now() AND attempts >= $1`, [this.cfg.COMMAND_MAX_DELIVERY_ATTEMPTS]);
    const requeued = await n(`UPDATE remote_commands SET status='queued', lease_token=NULL, updated_at=now()
        WHERE (status='delivered' OR (status='acknowledged' AND repeatable)) AND lease_expires_at < now() AND attempts < $1`, [this.cfg.COMMAND_MAX_DELIVERY_ATTEMPTS]);
    // Redis may have lost its queue: re-enqueue everything still waiting. Idempotent by jobId.
    const waiting = (await this.db.query<{ id: string }>(
      `SELECT id FROM remote_commands WHERE status IN ('pending','queued') AND expires_at > now() AND updated_at < now() - interval '10 seconds' ORDER BY created_at LIMIT 500`)).rows;
    let reenqueued = 0;
    for (const w of waiting) {
      try { await this.queue.enqueue(w.id); reenqueued++; } catch { break; }
    }
    await n("DELETE FROM outbox WHERE dispatched_at < now() - interval '1 day'");
    await n("DELETE FROM webauthn_challenges WHERE expires_at < now()");
    await n("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'");
    return { expired, unknown, requeued, failed, reenqueued };
  }
}

export async function audit(q: Queryable, orgId: string | null, actorType: "user" | "factory" | "system", actorId: string | null, action: string, targetId: string | null, detail: object): Promise<void> {
  await q.query("INSERT INTO audit_events (org_id, actor_type, actor_id, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [orgId, actorType, actorId, action, action.split(".")[0], targetId, JSON.stringify(detail)]);
}
