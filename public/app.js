// Everything that originates from tickets, agents or logs is untrusted: it is only ever rendered with textContent.
"use strict";
const $ = (s) => document.querySelector(s);
let token = sessionStorage.getItem("factory-token") || "";
const m = /#token=([0-9a-f]+)/.exec(location.hash);
if (m) { token = m[1]; sessionStorage.setItem("factory-token", token); history.replaceState(null, "", location.pathname + "#/"); } // keep it out of the URL bar and history

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") el.className = v; else if (k === "on") for (const [e, f] of Object.entries(v)) el.addEventListener(e, f); else if (v !== false && v != null) el.setAttribute(k, v); }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const ago = (t) => { if (!t) return "never"; const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const dur = (ms) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : ms < 90000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60000)}m`);
const gb = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;
const cls = (status) => ({ done: "ok", completed: "ok", running: "", queued: "muted", waiting: "warn", failed: "bad", cancelled: "muted", ok: "ok", warn: "warn", fail: "bad", succeeded: "ok", timed_out: "bad" }[status] || "");
const safeUrl = (u) => (typeof u === "string" && /^https:\/\/github\.com\//.test(u) ? u : null);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res;
}
async function post(path) {
  if (!token) { alert("Controls need the control token. Open the dashboard with: pnpm factory dashboard --open"); return null; }
  try { return await (await api(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" })).json(); }
  catch (e) { alert(`Failed: ${e.message}`); return null; }
}

let current = null;
function setHeader(o) {
  const stop = o.control.emergencyStop, paused = o.control.paused;
  const st = $("#state"); st.textContent = stop ? "EMERGENCY STOP" : paused ? "PAUSED" : "RUNNING"; st.className = `pill ${stop ? "bad" : paused ? "warn" : "ok"}`;
  $("#mode").textContent = `${o.mergeMode === "pr-only" ? "PR-only: never merges" : o.mergeMode}${o.dryRun ? " · DRY RUN" : ""}`;
  $("#btn-pause").hidden = paused; $("#btn-resume").hidden = !paused || stop; $("#btn-stop").hidden = stop; $("#btn-clear").hidden = !stop;
  const b = $("#banner"); b.hidden = !stop; b.textContent = stop ? `Emergency stop is active${o.control.reason ? `: ${o.control.reason}` : ""}. No new work starts and running agents were terminated.` : "";
  $("#auth").textContent = token ? "controls enabled" : "read-only (no token: use `pnpm factory dashboard --open`)";
}

function jobTable(jobs) {
  if (!jobs.length) return h("p", { class: "muted" }, "None.");
  return h("table", {}, h("thead", {}, h("tr", {}, ["Ticket", "Project", "Stage", "Status", "Fixes", "Updated", "Note"].map((c) => h("th", {}, c)))),
    h("tbody", {}, jobs.map((j) => h("tr", { class: "click", on: { click: () => (location.hash = `#/jobs/${j.id}`) } },
      h("td", { class: "mono" }, j.key, j.dryRun ? " (dry)" : ""), h("td", {}, j.project), h("td", {}, j.stage, j.heldFromStage ? h("small", { class: "muted" }, ` ← ${j.heldFromStage}`) : ""),
      h("td", { class: cls(j.status) }, j.status), h("td", {}, j.remediationAttempts), h("td", { class: "muted" }, ago(j.updatedAt)),
      h("td", { class: j.lastError ? "err" : "muted" }, (j.lastError || (j.prUrl ? "PR raised" : "")).split("\n")[0].slice(0, 90))))));
}

async function overview() {
  const o = await (await api("/api/overview")).json(); setHeader(o);
  const c = o.counts.byStatus, sys = o.system, sch = o.scheduler;
  const kpi = (label, v, k = "") => h("div", { class: "kpi" }, h("div", { class: `big ${k}` }, v), h("small", {}, label));
  return h("div", {},
    h("div", { class: "grid" },
      h("div", { class: "card" }, h("h2", {}, "Jobs"), h("div", { class: "kpis" }, kpi("running", c.running || 0), kpi("queued", c.queued || 0), kpi("waiting", c.waiting || 0, c.waiting ? "warn" : ""), kpi("done", c.done || 0, "ok"), kpi("failed", c.failed || 0, c.failed ? "bad" : ""))),
      h("div", { class: "card" }, h("h2", {}, "This machine"), h("div", { class: "kpis" },
        kpi("memory free", sys.memory.freePercent == null ? gb(sys.memory.availableBytes) : `${sys.memory.freePercent}%`, sys.memory.pressure === "critical" ? "bad" : sys.memory.pressure === "warn" ? "warn" : ""),
        kpi("disk free", sys.disk ? gb(sys.disk.freeBytes) : "?"), kpi("load", sys.load[0].toFixed(1)))),
      h("div", { class: "card" }, h("h2", {}, "Scheduler"), sch ? h("div", {},
        h("div", {}, "Linear poll: ", sch.lastDiscovery ? h("span", { class: sch.lastDiscovery.ok ? "ok" : "bad" }, `${sch.lastDiscovery.ok ? "ok" : "error"} ${ago(sch.lastDiscovery.at)}`) : "not yet", sch.lastDiscovery ? ` · ${sch.lastDiscovery.enqueued} new` : ""),
        sch.lastDiscovery?.error ? h("div", { class: "err" }, sch.lastDiscovery.error.slice(0, 160)) : null,
        h("div", {}, "Write-back: ", sch.lastFlush ? `${sch.lastFlush.sent} sent, ${sch.lastFlush.pending} pending, ${sch.lastFlush.failed} failed (${ago(sch.lastFlush.at)})` : "not yet"),
        h("div", { class: "muted" }, `Backlog: ${o.counts.outbox.pending} pending, ${o.counts.outbox.failed} failed Linear writes`)) : h("div", { class: "muted" }, "Dashboard only: the scheduler is not running.")),
      h("div", { class: "card" }, h("h2", {}, "Dependencies"), o.health.length ? o.health.map((x) => h("div", {}, h("span", { class: cls(x.status) }, x.status === "ok" ? "● " : "▲ "), h("b", {}, x.name), h("span", { class: "muted" }, ` ${x.detail}`))) : h("div", { class: "muted" }, "No health probes configured."),
        o.counts.recentAgentFailures.rateLimited ? h("div", { class: "warn" }, `${o.counts.recentAgentFailures.rateLimited} rate-limit hit(s) in the last hour`) : null)),
    h("h3", {}, "Running now"), jobTable(o.active), h("h3", {}, "Queued and waiting"), jobTable(o.queued), h("h3", {}, "Recently finished"), jobTable(o.recent));
}

async function jobs() {
  const status = sessionStorage.getItem("f-status") || "", proj = sessionStorage.getItem("f-proj") || "";
  const q = new URLSearchParams(); if (status) q.set("status", status); if (proj) q.set("project", proj);
  const [list, ps] = await Promise.all([api(`/api/jobs?${q}`).then((r) => r.json()), api("/api/projects").then((r) => r.json())]);
  const sel = (id, opts, val, key) => { const s = h("select", { on: { change: (e) => { sessionStorage.setItem(key, e.target.value); render(); } } }, h("option", { value: "" }, id), opts.map((o) => h("option", { value: o, selected: o === val ? "" : false }, o))); return s; };
  return h("div", {}, h("div", { class: "row" }, sel("any status", ["running", "queued", "waiting", "done", "failed", "cancelled"], status, "f-status"), sel("any project", ps.projects.map((p) => p.id), proj, "f-proj")), jobTable(list.jobs));
}

async function jobDetail(id) {
  const d = await (await api(`/api/jobs/${encodeURIComponent(id)}`)).json(); const j = d.job;
  const ran = new Set(d.executions.filter((e) => e.outcome === "succeeded").map((e) => e.stage));
  const held = ["BLOCKED", "FAILED", "CANCELLED", "PAUSED", "NEEDS_ATTENTION"].includes(j.stage);
  const at = held ? j.heldFromStage : j.stage; // held states are not pipeline stages: mark the stage it stopped at
  const canRetry = held || j.status === "failed", canCancel = ["queued", "running", "waiting"].includes(j.status);
  const logBox = h("pre", { hidden: "" });
  const pr = safeUrl(j.prUrl);
  return h("div", {},
    h("p", {}, h("a", { href: "#/jobs" }, "← jobs")),
    h("div", { class: "row" }, h("h2", { class: "mono" }, j.key), h("span", { class: `pill ${cls(j.status)}` }, j.status), h("span", {}, j.project, " · ", j.workflow, j.autonomous ? " · autonomous" : "", j.dryRun ? " · dry run" : ""),
      pr ? h("a", { href: pr, target: "_blank", rel: "noopener noreferrer" }, "pull request ↗") : null, h("span", { class: "spacer" }),
      canRetry ? h("button", { on: { click: async () => { if (await post(`/api/jobs/${j.id}/retry`)) render(); } } }, "Retry") : null,
      canCancel ? h("button", { class: "danger", on: { click: async () => { if (confirm(`Cancel ${j.key}?`) && await post(`/api/jobs/${j.id}/cancel`)) render(); } } }, "Cancel") : null),
    j.lastError ? h("div", { class: "err" }, j.lastError) : null,
    h("div", { class: "stages" }, d.stageOrder.map((s) => h("span", { class: `stage ${s === at ? (held ? "held" : "now") : ran.has(s) ? "done" : ""}`, title: s }, s.replaceAll("_", " ").toLowerCase()))),
    held ? h("div", { class: "muted" }, `Held at ${j.stage}${j.heldFromStage ? ` (was ${j.heldFromStage})` : ""}. Retry resumes there.`) : null,
    h("h3", {}, "Stage history"),
    h("table", {}, h("thead", {}, h("tr", {}, ["Stage", "#", "Outcome", "Took", "Detail"].map((c) => h("th", {}, c)))),
      h("tbody", {}, d.executions.map((e) => h("tr", {}, h("td", { class: "mono" }, e.stage), h("td", {}, e.attempt), h("td", { class: cls(e.outcome) }, e.outcome), h("td", {}, e.finishedAt ? dur(e.finishedAt - e.startedAt) : "…"), h("td", { class: e.error ? "err" : "muted" }, (e.error || "").slice(0, 200)))))),
    h("h3", {}, "Agent runs"),
    h("table", {}, h("thead", {}, h("tr", {}, ["Agent", "Model", "Took", "Exit", "Denied", "Log"].map((c) => h("th", {}, c)))),
      h("tbody", {}, d.invocations.map((a) => h("tr", {}, h("td", {}, a.agent), h("td", {}, a.model || ""), h("td", {}, dur(a.durationMs)), h("td", {}, a.exitCode ?? ""), h("td", { class: a.usage?.denials ? "warn" : "muted" }, a.usage?.denials ?? ""),
        h("td", {}, a.hasLog ? h("button", { on: { click: async () => { try { const r = await api(`/api/jobs/${j.id}/invocations/${a.id}/log?tail=30000`); logBox.hidden = false; logBox.textContent = await r.text(); } catch (e) { logBox.hidden = false; logBox.textContent = `No log: ${e.message}`; } } } }, "view") : ""))))), logBox,
    h("h3", {}, "Decisions"), d.decisions.length ? h("table", {}, h("tbody", {}, d.decisions.map((x) => h("tr", {}, h("td", { class: "mono" }, x.kind), h("td", {}, x.decision), h("td", { class: "muted" }, x.rationale || ""), h("td", { class: "muted" }, x.actor))))) : h("p", { class: "muted" }, "None."),
    h("h3", {}, "Artifacts"), d.artifacts.length ? h("ul", {}, d.artifacts.map((a) => h("li", {}, h("b", {}, a.kind), " ", h("span", { class: "mono muted" }, a.path)))) : h("p", { class: "muted" }, "None."),
    d.worktree ? h("div", {}, h("h3", {}, "Worktree"), h("div", { class: "mono" }, `${d.worktree.path} (${d.worktree.state}) on ${d.worktree.branch}`)) : null,
    h("h3", {}, "Linear write-back"), d.outbox.length ? h("div", {}, d.outbox.map((o) => h("span", { class: `pill ${o.status === "done" ? "ok" : o.status === "failed" ? "bad" : "warn"}`, title: o.lastError || "" }, `${o.kind} ${o.status}`), " ")) : h("p", { class: "muted" }, "None."));
}

async function projects() {
  const { projects: ps } = await (await api("/api/projects")).json();
  const cmd = (p) => ["install", "build", "typecheck", "lint", "test"].filter((k) => p.commands[k]).map((k) => h("span", { class: `pill ${k === "test" ? "ok" : ""}`, title: p.commands[k] }, k));
  return h("table", {}, h("thead", {}, h("tr", {}, ["Project", "Autonomy", "Linear", "Commands", "Validation", "Active"].map((c) => h("th", {}, c)))),
    h("tbody", {}, ps.map((p) => h("tr", {}, h("td", {}, h("b", {}, p.name), h("div", { class: "muted mono" }, p.githubRepo || p.repository)), h("td", {}, p.autonomy), h("td", {}, p.linear ? `${p.linear.teamKey}${p.linear.projectName ? ` / ${p.linear.projectName}` : ""}` : "—"),
      h("td", {}, p.commands.test ? cmd(p) : h("span", { class: "warn" }, "no test command: blocked")),
      h("td", {}, p.validation ? h("span", { class: p.validation.ok ? "ok" : "bad" }, p.validation.ok ? "ok" : "failing") : h("span", { class: "muted" }, "unchecked"), p.validation ? h("div", { class: "muted" }, `protection: ${p.validation.protection}`) : null, ...(p.validation?.findings || []).slice(0, 3).map((f) => h("div", { class: "muted" }, f.slice(0, 110)))),
      h("td", {}, p.activeJobs || "")))));
}

async function health() {
  const r = await (await api("/api/health")).json(); const s = r.system;
  return h("div", { class: "grid" },
    h("div", { class: "card" }, h("h2", {}, "Dependencies"), r.health.map((x) => h("div", {}, h("span", { class: cls(x.status) }, x.status === "ok" ? "● " : "▲ "), h("b", {}, x.name), h("div", { class: "muted" }, `${x.detail} (checked ${ago(x.checkedAt)})`)))),
    h("div", { class: "card" }, h("h2", {}, "Memory and disk"), h("div", {}, `Memory: ${gb(s.memory.availableBytes)} available of ${gb(s.memory.totalBytes)} (${s.memory.pressure})`), h("div", {}, s.disk ? `Disk: ${gb(s.disk.freeBytes)} free of ${gb(s.disk.totalBytes)}` : "Disk: unknown"), h("div", {}, `Load: ${s.load.map((n) => n.toFixed(2)).join(" ")}`), h("div", { class: "muted" }, "Local inference runs one request at a time; Claude runs as separate processes.")));
}

async function render() {
  const hash = location.hash || "#/";
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", hash === a.getAttribute("href") || (a.getAttribute("href") === "#/jobs" && hash.startsWith("#/jobs"))));
  try {
    const jm = /^#\/jobs\/(.+)$/.exec(hash);
    const view = hash.startsWith("#/projects") ? await projects() : hash.startsWith("#/health") ? await health() : jm ? await jobDetail(jm[1]) : hash.startsWith("#/jobs") ? await jobs() : await overview();
    if (!jm || !current?.startsWith("job") || document.activeElement?.tagName !== "BUTTON") { $("#view").replaceChildren(view); }
    current = jm ? "job" : hash;
    if (!hash.startsWith("#/") || jm || hash === "#/") { try { setHeader(await (await api("/api/overview")).json()); } catch { /* header refresh is best-effort */ } }
  } catch (e) { $("#view").replaceChildren(h("p", { class: "err" }, `Cannot load: ${e.message}`)); }
}
document.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
  const act = b.dataset.act;
  if (act === "stop" && !confirm("EMERGENCY STOP: terminate running agents now and start nothing new?")) return;
  if (await post(`/api/control/${act}`)) render();
}));
window.addEventListener("hashchange", render);
render(); setInterval(() => { if (!document.hidden && !/^#\/jobs\/.+/.test(location.hash)) render(); }, 3000);
