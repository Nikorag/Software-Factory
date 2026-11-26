import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { readConversation, type Turn } from "../agents/transcript.js";
import type { FactoryDb } from "../db/client.js";
import { agentInvocations, decisions, jobs, stageExecutions } from "../db/schema.js";
import { redactSecrets } from "../implement/secrets.js";

/** Runs one read-only assistant turn. Wired to the real agent runner in the service; tests pass a fake. */
export type ChatRun = (req: { projectId: string; prompt: string; cwd: string; timeoutMs: number }) => Promise<{ ok: boolean; text: string; error?: string }>;
export interface ChatDeps { db: FactoryDb; dataDir?: string; chat?: { run: ChatRun } }

const MAX_MESSAGE = 4000, MAX_HISTORY = 20, MAX_CONTEXT = 24_000, RUNS_IN_CONTEXT = 3, TIMEOUT_MS = 180_000;
const body = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(MAX_MESSAGE * 2) })).max(MAX_HISTORY).default([]),
});

const clip = (s: string | null | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? "");
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "-");

function renderTurns(turns: Turn[], budget: number): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.kind === "text") lines.push(`agent: ${clip(t.text, 800)}`);
    else if (t.kind === "tool") lines.push(`tool ${t.name}: ${clip(t.input, 200)}`);
    else if (t.kind === "tool_result" && t.error) lines.push(`tool error: ${clip(t.text, 400)}`);
    else if (t.kind === "result") lines.push(`${t.ok ? "RESULT" : "FAILED"}: ${clip(t.text, 1200)}`);
    else if (t.kind === "stderr") lines.push(`stderr: ${clip(t.text, 300)}`);
  }
  // Keep the end of the run: that is where it went wrong.
  let out = lines.join("\n");
  if (out.length > budget) out = `…\n${out.slice(out.length - budget)}`;
  return out;
}

/** Everything the assistant is told about a job. Secrets are redacted: this text goes to a model. */
export function jobContext(db: FactoryDb, dataDir: string | undefined, jobId: string): string | null {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return null;
  const execs = db.select().from(stageExecutions).where(eq(stageExecutions.jobId, jobId)).orderBy(asc(stageExecutions.id)).all();
  const decs = db.select().from(decisions).where(eq(decisions.jobId, jobId)).orderBy(asc(decisions.id)).all();
  const invs = db.select().from(agentInvocations).where(eq(agentInvocations.jobId, jobId)).orderBy(asc(agentInvocations.id)).all();
  const parts = [
    `JOB ${job.externalKey} (project ${job.projectId}, workflow ${job.workflow})`,
    `status=${job.status} stage=${job.stage} remediationAttempts=${job.remediationAttempts} stageAttempts=${job.stageAttempts} dryRun=${job.dryRun} pr=${job.prUrl ?? "-"}`,
    `lastError: ${clip(job.lastError, 1500) || "-"}`,
    "", "STAGE HISTORY",
    ...execs.slice(-30).map((e) => `- #${e.id} ${e.stage} attempt ${e.attempt}: ${e.outcome ?? "?"} ${iso(e.startedAt)}${e.error ? ` error: ${clip(e.error, 600)}` : ""}`),
    "", "DECISIONS",
    ...decs.slice(-30).map((x) => `- [${x.kind}] ${clip(x.decision, 300)}${x.rationale ? ` (${clip(x.rationale, 500)})` : ""} by ${x.actor}`),
  ];
  const recent = invs.slice(-RUNS_IN_CONTEXT);
  for (const inv of recent) {
    parts.push("", `AGENT RUN #${inv.id} ${inv.agent} model=${inv.model ?? "-"} exit=${inv.exitCode ?? "-"} ${inv.durationMs ?? "-"}ms`);
    const conv = inv.logPath && dataDir ? readConversation(dataDir, inv.logPath, 0, 400_000) : null;
    parts.push(conv ? renderTurns(conv.turns.filter((t) => t.kind !== "prompt"), Math.floor(MAX_CONTEXT / RUNS_IN_CONTEXT)) : "(no conversation recorded)");
  }
  return redactSecrets(parts.join("\n"));
}

export function buildChatPrompt(context: string, history: { role: "user" | "assistant"; text: string }[], message: string): string {
  const convo = history.map((h) => `${h.role === "user" ? "Developer" : "Assistant"}: ${h.text}`).join("\n\n");
  return `<job_summary>\n${context}\n</job_summary>\n\n${convo ? `Conversation so far:\n\n${convo}\n\n` : ""}Developer: ${message}\n\nAnswer the developer's latest message.`;
}

export function registerChatRoutes(app: FastifyInstance, d: ChatDeps, requireToken: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  // POST (not GET) because it starts an agent; it needs the same same-origin/token proof as the other mutating calls.
  app.post<{ Params: { id: string } }>("/api/jobs/:id/chat", { preHandler: requireToken }, async (req, reply) => {
    if (!d.chat) return reply.code(503).send({ error: "chat is not available in this service" });
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    const context = jobContext(d.db, d.dataDir, req.params.id);
    if (context === null) return reply.code(404).send({ error: "no such job" });
    const job = d.db.select({ projectId: jobs.projectId }).from(jobs).where(eq(jobs.id, req.params.id)).get()!;
    // An empty directory of its own: the assistant can read here, but not the factory's database, logs or any repository.
    const cwd = join(d.dataDir ?? ".", "chat");
    mkdirSync(cwd, { recursive: true });
    const r = await d.chat.run({ projectId: job.projectId, prompt: buildChatPrompt(context, parsed.data.history, parsed.data.message), cwd, timeoutMs: TIMEOUT_MS });
    if (!r.ok) return reply.code(502).send({ error: r.error || "the assistant could not answer" });
    return { reply: redactSecrets(r.text) };
  });
}
