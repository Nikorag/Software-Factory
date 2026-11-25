// Which interruptions deserve a system notification, as plain data (no Electron, so it can be tested).
// An interruption is a job that has stopped and needs a person: it asked a question, hit its fix-cycle limit, or failed.
const HOLD = { BLOCKED: "needs your answer", NEEDS_ATTENTION: "needs your attention" };

/** @param {{id: string, key: string, stage: string, status: string, lastError?: string|null}} j */
function interruptionOf(j) {
  if (j.status === "failed") return { why: "failed", body: (j.lastError || "It failed.").split("\n")[0].slice(0, 140) };
  if (j.status === "waiting" && HOLD[j.stage]) return { why: HOLD[j.stage], body: (j.lastError || "Open it to see why.").split("\n")[0].slice(0, 140) };
  return null;
}

/**
 * Compare what is stopped now with what we already told you about.
 * `seen` is a Set of keys (mutated). The first poll for a profile only seeds it, so opening the app never floods you with old news;
 * a job that is retried and stops again is a new interruption, because its key left the set in between.
 * @returns {{key: string, jobId: string, profile: string, title: string, body: string}[]}
 */
function newInterruptions(profile, jobs, seen, seeded) {
  const now = new Map();
  for (const j of jobs) { const i = interruptionOf(j); if (i) now.set(`${profile}:${j.id}:${j.stage}`, { j, i }); }
  for (const k of [...seen]) if (k.startsWith(`${profile}:`) && !now.has(k)) seen.delete(k);
  const out = [];
  for (const [key, { j, i }] of now) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (seeded) out.push({ key, jobId: j.id, profile, title: `${j.key} ${i.why}`, body: i.body });
  }
  return out;
}
module.exports = { interruptionOf, newInterruptions };
