import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR, ConfigError } from "../config/load.js";
import { JIRA_STATUS_KEYS, type LoadedConfig } from "../config/schema.js";
import { applyTracker, JiraMapping, seedHomeConfig, updateJiraConfig, updateTracker } from "../config/store.js";
import type { FactoryDb } from "../db/client.js";
import { jobs } from "../db/schema.js";
import { inArray } from "drizzle-orm";
import { accessibleSites, ACCOUNT, authorizeUrl, exchangeCode, JIRA_SCOPES, JiraAuth, type SecretStore, type Site } from "../jira/auth.js";
import { createTrackerClient } from "../tracker/index.js";

export interface JiraRouteDeps {
  db: FactoryDb; config: LoadedConfig; store: SecretStore; port: number;
  fetch?: typeof fetch; authBase?: string; apiBase?: string; atlassianApi?: string;
}
/** What must be mapped before the factory can run a ticket end to end (the pickup status only matters in automatic mode). */
export const REQUIRED_STATUSES = ["specificationReview", "inProgress", "readyForReview", "done", "blocked"] as const;
const AUTO_STATUS = "readyForSpecification";
const REQUIRED_LABELS = ["blocked"] as const;
const AUTO_LABEL = "enabled";

const dirOf = (c: LoadedConfig) => (!c.configDir || c.configDir === BUNDLED_CONFIG_DIR ? seedHomeConfig() : c.configDir);
const page = (title: string, body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><h2>${title}</h2><p>${body}</p></body>`; // no script, no style: this page only ever shows text
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function registerJiraRoutes(app: FastifyInstance, d: JiraRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const callbackUrl = `http://127.0.0.1:${d.port}/api/jira/oauth/callback`;
  const pending = new Map<string, number>();            // OAuth `state` values we issued: one use, ten minutes
  let siteChoices: Site[] = [];                          // sites offered after a connection that could reach several
  const auth = () => new JiraAuth({ clientId: d.config.jira.clientId ?? "", store: d.store, fetch: d.fetch, base: d.authBase });
  const fail = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof z.ZodError ? 400 : code).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });
  const client = () => createTrackerClient(d.config, { store: d.store, fetch: d.fetch, apiBase: d.apiBase, authBase: d.authBase });

  app.get("/api/jira/status", async () => {
    const j = d.config.jira;
    return {
      tracker: d.config.factory.tracker, clientId: j.clientId ?? null, secretSet: Boolean(d.store.get(ACCOUNT.clientSecret)), connected: Boolean(d.store.get(ACCOUNT.refreshToken)),
      site: j.site ?? null, siteChoices: siteChoices.map((s) => ({ id: s.id, name: s.name, url: s.url })), callbackUrl, scopes: JIRA_SCOPES,
    };
  });

  /** The OAuth app's credentials, from the Atlassian developer console. The client id is config; the secret goes to the keychain, never to a file. */
  app.put<{ Body: { clientId?: unknown; clientSecret?: unknown } }>("/api/jira/app", { preHandler: requireToken }, async (req, reply) => {
    try {
      const clientId = z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, "that does not look like an Atlassian OAuth client id").parse(req.body?.clientId);
      const secret = req.body?.clientSecret === undefined || req.body.clientSecret === "" ? undefined : z.string().trim().min(16).max(300).parse(req.body.clientSecret);
      if (secret) d.store.set(ACCOUNT.clientSecret, secret);
      else if (!d.store.get(ACCOUNT.clientSecret)) throw new ConfigError("enter the client secret too");
      applyTracker(d.config, updateJiraConfig({ clientId }, dirOf(d.config)));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  /** Step 1 of connecting: where to send the user. `state` ties the answer to this click (one use, ten minutes). */
  app.post("/api/jira/connect", { preHandler: requireToken }, async (_req, reply) => {
    const clientId = d.config.jira.clientId;
    if (!clientId || !d.store.get(ACCOUNT.clientSecret)) return reply.code(400).send({ error: "save the OAuth app's client id and secret first" });
    const state = randomBytes(24).toString("hex");
    pending.set(state, Date.now() + 10 * 60_000);
    return { url: authorizeUrl({ clientId, redirectUri: callbackUrl, state, base: d.authBase }), callbackUrl };
  });

  /** Step 2: Atlassian sends the browser back here with a one-time code. No token header (it is a plain browser navigation): the `state` is the proof. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/jira/oauth/callback", async (req, reply) => {
    const send = (status: number, title: string, body: string) => reply.code(status).header("Content-Type", "text/html; charset=utf-8").header("Content-Security-Policy", "default-src 'none'").send(page(title, body));
    const { code, state, error } = req.query;
    const until = state ? pending.get(state) : undefined;
    if (state) pending.delete(state); // single use, whatever happens next
    if (!until || until < Date.now()) return send(400, "This link is no longer valid", "Start again from Settings → Tracker in Software Factory.");
    if (error || !code) return send(400, "Jira did not authorise the connection", esc(req.query.error_description ?? error ?? "no code returned"));
    const clientId = d.config.jira.clientId, secret = d.store.get(ACCOUNT.clientSecret);
    if (!clientId || !secret) return send(400, "Not configured", "The OAuth app's client id or secret is missing.");
    try {
      const tokens = await exchangeCode({ clientId, clientSecret: secret, code, redirectUri: callbackUrl, fetch: d.fetch, base: d.authBase });
      if (!tokens.refresh_token) return send(400, "No refresh token", "Atlassian did not return a refresh token. Make sure the app's scopes include offline_access, then connect again.");
      auth().adopt(tokens); // saves the refresh token to the keychain
      const sites = await accessibleSites(tokens.access_token, d.fetch, d.atlassianApi);
      if (sites.length === 1) { const s = sites[0]!; applyTracker(d.config, updateJiraConfig({ site: { cloudId: s.id, url: s.url, name: s.name } }, dirOf(d.config))); siteChoices = []; }
      else siteChoices = sites;
      return send(200, "Jira connected", `${sites.length === 1 ? `Connected to <b>${esc(sites[0]!.name)}</b>. ` : sites.length > 1 ? "Choose which site to use in Software Factory. " : "No Jira site is available to this app. "}You can close this tab and return to Software Factory.`);
    } catch (e) { return send(400, "Could not finish connecting", esc((e as Error).message)); }
  });

  app.post<{ Body: { cloudId?: unknown } }>("/api/jira/site", { preHandler: requireToken }, async (req, reply) => {
    const s = siteChoices.find((x) => x.id === req.body?.cloudId);
    if (!s) return reply.code(400).send({ error: "that site is not one of the sites Atlassian offered: connect again" });
    applyTracker(d.config, updateJiraConfig({ site: { cloudId: s.id, url: s.url, name: s.name } }, dirOf(d.config)));
    siteChoices = [];
    return { ok: true };
  });

  app.post("/api/jira/disconnect", { preHandler: requireToken }, async () => {
    d.store.set(ACCOUNT.refreshToken, "");
    siteChoices = [];
    applyTracker(d.config, updateJiraConfig({ site: null }, dirOf(d.config)));
    return { ok: true };
  });

  /** Who Jira says we are, as proof the connection works (never on a timer: only when the page asks). */
  app.get("/api/jira/whoami", async (_req, reply) => { try { return await client().viewer(); } catch (e) { return fail(reply, e, 502); } });

  // ---- mapping: the factory's statuses and labels onto what already exists in Jira ----
  const bound = () => d.config.projects.projects.filter((p) => p.linear);
  app.get("/api/jira/mapping", async () => ({
    statuses: d.config.jira.statuses, labels: d.config.jira.labels,
    required: { statuses: [...REQUIRED_STATUSES], labels: [...REQUIRED_LABELS], automaticStatus: AUTO_STATUS, automaticLabel: AUTO_LABEL },
    factoryStatuses: JIRA_STATUS_KEYS,
  }));

  /** What exists in Jira: every Jira project, and the statuses and labels of one (the first bound project by default). */
  app.get<{ Querystring: { project?: string } }>("/api/jira/metadata", async (req, reply) => {
    try {
      const c = client();
      const teams = await c.teams();
      const key = req.query.project ?? bound()[0]?.linear?.teamKey ?? teams[0]?.key;
      const team = teams.find((t) => t.key === key);
      return { projects: teams.map((t) => ({ key: t.key, name: t.name })), project: team?.key ?? null, statuses: team ? (await c.workflowStates(team.id)).map((s) => s.name) : [], labels: (await c.labels(team?.id ?? "")).map((l) => l.name) };
    } catch (e) { return fail(reply, e, 502); }
  });

  app.put<{ Body: unknown }>("/api/jira/mapping", { preHandler: requireToken }, async (req, reply) => {
    try {
      const mapping = JiraMapping.parse(req.body);
      applyTracker(d.config, updateJiraConfig({ mapping }, dirOf(d.config)));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  /** Does every mapped status exist in every Jira project that a factory project is bound to? (Statuses differ between Jira projects.) */
  app.get("/api/jira/mapping/check", async (_req, reply) => {
    try {
      const c = client();
      const teams = await c.teams();
      const wanted = Object.entries(d.config.jira.statuses).filter(([, v]) => v) as [string, string][];
      const results = [];
      for (const p of bound()) {
        const team = teams.find((t) => t.key === p.linear!.teamKey);
        if (!team) { results.push({ projectId: p.id, jiraProject: p.linear!.teamKey, found: false, missing: [] as string[] }); continue; }
        const have = new Set((await c.workflowStates(team.id)).map((s) => s.name.toLowerCase()));
        results.push({ projectId: p.id, jiraProject: team.key, found: true, missing: wanted.filter(([, name]) => !have.has(name.toLowerCase())).map(([k, name]) => `${k}: "${name}"`) });
      }
      return { ok: results.every((r) => r.found && r.missing.length === 0), projects: results };
    } catch (e) { return fail(reply, e, 502); }
  });

  // ---- choosing the tracker for this profile ----
  app.put<{ Body: { tracker?: unknown } }>("/api/settings/tracker", { preHandler: requireToken }, async (req, reply) => {
    const kind = req.body?.tracker;
    if (kind !== "linear" && kind !== "jira") return reply.code(400).send({ error: "tracker must be linear or jira" });
    if (kind === d.config.factory.tracker) return { ok: true };
    const active = d.db.select().from(jobs).where(inArray(jobs.status, ["queued", "running", "waiting"])).all().length;
    if (active) return reply.code(409).send({ error: `${active} job(s) are still active. Finish or cancel them before switching tracker: their tickets belong to the current one.` });
    applyTracker(d.config, updateTracker(kind, dirOf(d.config)));
    return { ok: true, note: d.config.projects.projects.some((p) => p.linear) ? "Existing projects are still linked to the previous tracker: re-link each one in Settings → Projects." : undefined };
  });
}
