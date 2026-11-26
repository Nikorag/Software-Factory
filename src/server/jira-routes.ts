import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BUNDLED_CONFIG_DIR, ConfigError } from "../config/load.js";
import { JIRA_STATUS_KEYS, trackerIdOf, type JiraConfig, type LoadedConfig } from "../config/schema.js";
import { applyTracker, JiraMapping, seedHomeConfig, updateJiraConfig } from "../config/store.js";
import type { FactoryDb } from "../db/client.js";
import { accessibleSites, ACCOUNT, authorizeUrl, exchangeCode, JIRA_SCOPES, JiraAuth, type SecretStore, type Site } from "../jira/auth.js";
import { createTrackerClient } from "../tracker/index.js";

export interface JiraRouteDeps {
  db: FactoryDb; config: LoadedConfig; store: SecretStore; port: number;
  /** The secret store of one Jira connection (a profile can have several). Falls back to `store`, which serves the built-in "jira" connection. */
  storeFor?: (id: string) => SecretStore;
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

/**
 * Jira, one Jira connection at a time: every route takes `?tracker=<connection id>` and defaults to the built-in "jira" connection. A profile
 * can have several (a work Jira and a client's), each with its own OAuth app, secrets, site and mapping.
 */
export function registerJiraRoutes(app: FastifyInstance, d: JiraRouteDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const callbackUrl = `http://127.0.0.1:${d.port}/api/jira/oauth/callback`;
  const pending = new Map<string, { until: number; id: string }>(); // OAuth `state` values we issued (one use, ten minutes), and the connection each is for
  const siteChoices = new Map<string, Site[]>();                    // sites offered after a connection that could reach several, per connection
  const storeOf = (id: string) => d.storeFor?.(id) ?? d.store;
  const fail = (reply: FastifyReply, e: unknown, code = 400) => reply.code(e instanceof z.ZodError ? 400 : code).send({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message });
  /** The Jira connection a request is about. */
  const jiraOf = (id: string): JiraConfig & { kind: "jira" } => {
    const c = d.config.connections[id];
    if (!c || c.kind !== "jira") throw new ConfigError(`"${id}" is not a Jira connection`);
    return c;
  };
  const idOf = (req: FastifyRequest) => (req.query as { tracker?: string } | undefined)?.tracker ?? "jira";
  const authOf = (id: string) => new JiraAuth({ clientId: jiraOf(id).clientId ?? "", store: storeOf(id), fetch: d.fetch, base: d.authBase });
  const clientOf = (id: string) => createTrackerClient(d.config, { id, store: storeOf(id), fetch: d.fetch, apiBase: d.apiBase, authBase: d.authBase });

  app.get<{ Querystring: { tracker?: string } }>("/api/jira/status", async (req, reply) => {
    try {
      const id = idOf(req), j = jiraOf(id);
      return {
        tracker: d.config.factory.tracker, id, clientId: j.clientId ?? null, secretSet: Boolean(storeOf(id).get(ACCOUNT.clientSecret)), connected: Boolean(storeOf(id).get(ACCOUNT.refreshToken)),
        site: j.site ?? null, siteChoices: (siteChoices.get(id) ?? []).map((s) => ({ id: s.id, name: s.name, url: s.url })), callbackUrl, scopes: JIRA_SCOPES,
      };
    } catch (e) { return fail(reply, e, 404); }
  });

  /** The OAuth app's credentials, from the Atlassian developer console. The client id is config; the secret goes to the keychain, never to a file. */
  app.put<{ Querystring: { tracker?: string }; Body: { clientId?: unknown; clientSecret?: unknown } }>("/api/jira/app", { preHandler: requireToken }, async (req, reply) => {
    try {
      const id = idOf(req); jiraOf(id);
      const clientId = z.string().trim().regex(/^[A-Za-z0-9]{16,64}$/, "that does not look like an Atlassian OAuth client id").parse(req.body?.clientId);
      const secret = req.body?.clientSecret === undefined || req.body.clientSecret === "" ? undefined : z.string().trim().min(16).max(300).parse(req.body.clientSecret);
      if (secret) storeOf(id).set(ACCOUNT.clientSecret, secret);
      else if (!storeOf(id).get(ACCOUNT.clientSecret)) throw new ConfigError("enter the client secret too");
      applyTracker(d.config, updateJiraConfig({ clientId }, dirOf(d.config), id));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  /** Step 1 of connecting: where to send the user. `state` ties the answer to this click (one use, ten minutes). */
  app.post<{ Querystring: { tracker?: string } }>("/api/jira/connect", { preHandler: requireToken }, async (req, reply) => {
    try {
      const id = idOf(req), clientId = jiraOf(id).clientId;
      if (!clientId || !storeOf(id).get(ACCOUNT.clientSecret)) return reply.code(400).send({ error: "save the OAuth app's client id and secret first" });
      const state = randomBytes(24).toString("hex");
      pending.set(state, { until: Date.now() + 10 * 60_000, id });
      return { url: authorizeUrl({ clientId, redirectUri: callbackUrl, state, base: d.authBase }), callbackUrl };
    } catch (e) { return fail(reply, e); }
  });

  /** Step 2: Atlassian sends the browser back here with a one-time code. No token header (it is a plain browser navigation): the `state` is the proof, and says which connection this is. */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/jira/oauth/callback", async (req, reply) => {
    const send = (status: number, title: string, body: string) => reply.code(status).header("Content-Type", "text/html; charset=utf-8").header("Content-Security-Policy", "default-src 'none'").send(page(title, body));
    const { code, state, error } = req.query;
    const p = state ? pending.get(state) : undefined;
    if (state) pending.delete(state); // single use, whatever happens next
    if (!p || p.until < Date.now()) return send(400, "This link is no longer valid", "Start again from Settings → Trackers in Software Factory.");
    if (error || !code) return send(400, "Jira did not authorise the connection", esc(req.query.error_description ?? error ?? "no code returned"));
    const id = p.id;
    let clientId: string | undefined, secret: string | undefined;
    try { clientId = jiraOf(id).clientId; secret = storeOf(id).get(ACCOUNT.clientSecret); } catch { /* removed meanwhile */ }
    if (!clientId || !secret) return send(400, "Not configured", "The OAuth app's client id or secret is missing.");
    try {
      const tokens = await exchangeCode({ clientId, clientSecret: secret, code, redirectUri: callbackUrl, fetch: d.fetch, base: d.authBase });
      if (!tokens.refresh_token) return send(400, "No refresh token", "Atlassian did not return a refresh token. Make sure the app's scopes include offline_access, then connect again.");
      authOf(id).adopt(tokens); // saves the refresh token to the keychain
      const sites = await accessibleSites(tokens.access_token, d.fetch, d.atlassianApi);
      if (sites.length === 1) { const s = sites[0]!; applyTracker(d.config, updateJiraConfig({ site: { cloudId: s.id, url: s.url, name: s.name } }, dirOf(d.config), id)); siteChoices.delete(id); }
      else siteChoices.set(id, sites);
      return send(200, "Jira connected", `${sites.length === 1 ? `Connected to <b>${esc(sites[0]!.name)}</b>. ` : sites.length > 1 ? "Choose which site to use in Software Factory. " : "No Jira site is available to this app. "}You can close this tab and return to Software Factory.`);
    } catch (e) { return send(400, "Could not finish connecting", esc((e as Error).message)); }
  });

  app.post<{ Querystring: { tracker?: string }; Body: { cloudId?: unknown } }>("/api/jira/site", { preHandler: requireToken }, async (req, reply) => {
    try {
      const id = idOf(req); jiraOf(id);
      const s = (siteChoices.get(id) ?? []).find((x) => x.id === req.body?.cloudId);
      if (!s) return reply.code(400).send({ error: "that site is not one of the sites Atlassian offered: connect again" });
      applyTracker(d.config, updateJiraConfig({ site: { cloudId: s.id, url: s.url, name: s.name } }, dirOf(d.config), id));
      siteChoices.delete(id);
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  app.post<{ Querystring: { tracker?: string } }>("/api/jira/disconnect", { preHandler: requireToken }, async (req, reply) => {
    try {
      const id = idOf(req); jiraOf(id);
      storeOf(id).set(ACCOUNT.refreshToken, "");
      siteChoices.delete(id);
      applyTracker(d.config, updateJiraConfig({ site: null }, dirOf(d.config), id));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  /** Who Jira says we are, as proof the connection works (never on a timer: only when the page asks). */
  app.get<{ Querystring: { tracker?: string } }>("/api/jira/whoami", async (req, reply) => { try { return await clientOf(idOf(req)).viewer(); } catch (e) { return fail(reply, e, 502); } });

  // ---- mapping: the factory's statuses and labels onto what already exists in Jira ----
  /** The projects bound to this Jira connection. */
  const bound = (id: string) => d.config.projects.projects.filter((p) => p.linear && trackerIdOf(d.config, p) === id);
  app.get<{ Querystring: { tracker?: string } }>("/api/jira/mapping", async (req, reply) => {
    try {
      const j = jiraOf(idOf(req));
      return {
        statuses: j.statuses, labels: j.labels,
        required: { statuses: [...REQUIRED_STATUSES], labels: [...REQUIRED_LABELS], automaticStatus: AUTO_STATUS, automaticLabel: AUTO_LABEL },
        factoryStatuses: JIRA_STATUS_KEYS,
      };
    } catch (e) { return fail(reply, e, 404); }
  });

  /** What exists in Jira: every Jira project, and the statuses and labels of one (the first bound project by default). */
  app.get<{ Querystring: { project?: string; tracker?: string } }>("/api/jira/metadata", async (req, reply) => {
    try {
      const id = idOf(req), c = clientOf(id);
      const teams = await c.teams();
      const key = req.query.project ?? bound(id)[0]?.linear?.teamKey ?? teams[0]?.key;
      const team = teams.find((t) => t.key === key);
      return { projects: teams.map((t) => ({ key: t.key, name: t.name })), project: team?.key ?? null, statuses: team ? (await c.workflowStates(team.id)).map((s) => s.name) : [], labels: (await c.labels(team?.id ?? "")).map((l) => l.name) };
    } catch (e) { return fail(reply, e, 502); }
  });

  app.put<{ Querystring: { tracker?: string }; Body: unknown }>("/api/jira/mapping", { preHandler: requireToken }, async (req, reply) => {
    try {
      const id = idOf(req); jiraOf(id);
      const mapping = JiraMapping.parse(req.body);
      applyTracker(d.config, updateJiraConfig({ mapping }, dirOf(d.config), id));
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  /** Does every mapped status exist in every Jira project that a factory project is bound to? (Statuses differ between Jira projects.) */
  app.get<{ Querystring: { tracker?: string } }>("/api/jira/mapping/check", async (req, reply) => {
    try {
      const id = idOf(req), c = clientOf(id);
      const teams = await c.teams();
      const wanted = Object.entries(jiraOf(id).statuses).filter(([, v]) => v) as [string, string][];
      const results = [];
      for (const p of bound(id)) {
        const team = teams.find((t) => t.key === p.linear!.teamKey);
        if (!team) { results.push({ projectId: p.id, jiraProject: p.linear!.teamKey, found: false, missing: [] as string[] }); continue; }
        const have = new Set((await c.workflowStates(team.id)).map((s) => s.name.toLowerCase()));
        results.push({ projectId: p.id, jiraProject: team.key, found: true, missing: wanted.filter(([, name]) => !have.has(name.toLowerCase())).map(([k, name]) => `${k}: "${name}"`) });
      }
      return { ok: results.every((r) => r.found && r.missing.length === 0), projects: results };
    } catch (e) { return fail(reply, e, 502); }
  });
}
