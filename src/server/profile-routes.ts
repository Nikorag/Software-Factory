import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_PROFILE, ProfileError, type Profile } from "../config/profiles.js";

export interface ProfileDeps {
  current: string;
  list(): Profile[];
  add(name: string): Profile;
  remove(name: string): void;
  /** Starts that profile's own factory in the background (detached). */
  start(p: Profile): Promise<{ started: boolean; error?: string }>;
  isUp(p: Profile): Promise<boolean>;
}

/** Profiles are separate factory instances; this lets any of them list, create and switch to the others. Switching is just opening the other's URL. */
export function registerProfileRoutes(app: FastifyInstance, d: ProfileDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const view = async () => Promise.all(d.list().map(async (p) => ({ name: p.name, port: p.port, url: `http://127.0.0.1:${p.port}/`, current: p.name === d.current, running: p.name === d.current ? true : await d.isUp(p) })));
  app.get("/api/profiles", async () => ({ current: d.current, profiles: await view() }));
  app.post<{ Body: { name?: unknown } }>("/api/profiles", { preHandler: requireToken }, async (req, reply) => {
    try {
      const p = d.add(typeof req.body?.name === "string" ? req.body.name.trim() : "");
      const r = await d.start(p); // so it is ready to switch to straight away
      return { ok: true, profile: { name: p.name, port: p.port, url: `http://127.0.0.1:${p.port}/` }, ...(r.error ? { warning: `created, but it did not start: ${r.error}` } : {}) };
    } catch (e) { return reply.code(e instanceof ProfileError ? 400 : 500).send({ error: (e as Error).message }); }
  });
  app.delete<{ Params: { name: string } }>("/api/profiles/:name", { preHandler: requireToken }, async (req, reply) => {
    const name = req.params.name;
    if (name === d.current) return reply.code(409).send({ error: "you are in this profile: switch to another one first" });
    if (name === DEFAULT_PROFILE) return reply.code(400).send({ error: "the default profile cannot be removed" });
    const p = d.list().find((x) => x.name === name);
    if (p && (await d.isUp(p))) return reply.code(409).send({ error: `"${name}" is running: run \`software-factory shutdown --profile ${name}\` first` });
    try { d.remove(name); return { ok: true }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
}
