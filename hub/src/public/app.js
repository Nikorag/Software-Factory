// Dashboard. Plain ES module, no dependencies. All server data is rendered with textContent (never innerHTML).
const $ = (id) => document.getElementById(id);
const main = $("main");
const b64u = { dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)),
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const data = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data?.error || r.statusText); e.status = r.status; throw e; }
  return data;
}

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v); }
  for (const k of kids.flat()) el.append(k instanceof Node ? k : document.createTextNode(k ?? ""));
  return el;
}
const show = (...nodes) => main.replaceChildren(...nodes);
const ago = (iso) => { if (!iso) return "never"; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const presence = (f) => { if (f.status === "disabled") return ["disabled", "offline"]; if (!f.lastSeenAt) return ["never connected", "offline"]; const s = (Date.now() - new Date(f.lastSeenAt)) / 1000; return s < 120 ? ["online", "online"] : s < 900 ? ["quiet", "stale"] : ["offline", "offline"]; };
const badge = (text, cls) => h("span", { class: `badge ${cls}` }, text);
const setTitle = (t) => { $("title").textContent = t; };

// ---- Shell: the factory rail (left), a title bar and a status bar (bottom), as in the dashboard ----
let factories = [];
function renderRail() {
  $("railList").replaceChildren(...(factories.length ? factories.map((f) => {
    const [label, cls] = presence(f);
    return h("button", { class: "rail-item", type: "button", "aria-current": String(view.name === "factory" && view.id === f.id), title: label, onclick: () => go({ name: "factory", id: f.id }) },
      h("span", { class: `dot ${cls}`, role: "img", "aria-label": label }), h("span", { class: "name" }, f.name), h("span", { class: "meta" }, f.activeJobs ? `${f.activeJobs} active` : label));
  }) : [h("div", { class: "muted small" }, "No factories yet.")]));
  const online = factories.filter((f) => presence(f)[1] === "online").length, active = factories.reduce((n, f) => n + (f.activeJobs || 0), 0);
  $("status").replaceChildren(h("span", {}, `${online} of ${factories.length} online`), h("span", {}, `${active} active job${active === 1 ? "" : "s"}`), h("span", { class: "right" }, me ? me.email : ""));
}
async function loadRail() { factories = (await api("GET", "/v1/factories")).factories; renderRail(); }

// ---- WebAuthn (browser side) ----
function creationOptions(o) { return { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) }; }
function attestationJSON(c) { return { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined,
  response: { clientDataJSON: b64u.enc(c.response.clientDataJSON), attestationObject: b64u.enc(c.response.attestationObject), transports: c.response.getTransports?.() || [] } }; }
function assertionJSON(c) { return { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined,
  response: { clientDataJSON: b64u.enc(c.response.clientDataJSON), authenticatorData: b64u.enc(c.response.authenticatorData), signature: b64u.enc(c.response.signature), userHandle: c.response.userHandle ? b64u.enc(c.response.userHandle) : undefined } }; }
const passkeysSupported = () => !!window.PublicKeyCredential;

async function createPasskey(optsUrl, verifyUrl, extra) {
  const { challengeId, options } = await api("POST", optsUrl, extra.opts);
  const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
  return api("POST", verifyUrl, { challengeId, response: attestationJSON(cred), ...(extra.verify || {}) });
}

// ---- Screens ----
function authScreen(needsSetup) {
  const err = h("div", { class: "err" });
  const guard = (btn, fn) => async () => { err.textContent = ""; btn.disabled = true; try { await fn(); await boot(); } catch (e) { err.textContent = e.name === "NotAllowedError" ? "Passkey prompt cancelled." : `Failed: ${e.message}`; } finally { btn.disabled = false; } };
  if (!passkeysSupported()) return show(h("div", { class: "card center" }, h("h1", {}, "Passkeys required"), h("p", {}, "This browser does not support passkeys. Use a current Chrome, Safari, Edge or Firefox.")));
  const inviteToken = new URLSearchParams(location.hash.slice(1)).get("invite");
  if (inviteToken) {
    const email = h("input", { type: "email", autocomplete: "username" }), name = h("input", { autocomplete: "name" });
    const btn = h("button", {}, "Create passkey & join");
    btn.addEventListener("click", guard(btn, async () => {
      await createPasskey("/auth/invite/options", "/auth/invite/verify", { opts: { token: inviteToken, email: email.value, displayName: name.value } });
      history.replaceState(null, "", location.pathname); // drop the used token from the address bar
    }));
    const signIn = h("a", { href: "#", onclick: (e) => { e.preventDefault(); history.replaceState(null, "", location.pathname); authScreen(false); } }, "Already have an account? Sign in");
    return show(h("div", { class: "card center" }, h("h1", {}, "You're invited"),
      h("p", { class: "muted" }, "Create your account. Sign-in is by passkey only; there are no passwords. You'll get your own space for your factories."),
      h("label", {}, "Email"), email, h("label", {}, "Your name"), name, h("p", {}, btn), err, h("p", { class: "small" }, signIn)));
  }
  if (needsSetup) {
    const token = h("input", { type: "password", autocomplete: "off" }), email = h("input", { type: "email", autocomplete: "username" }), name = h("input", { autocomplete: "name" });
    const btn = h("button", {}, "Create passkey & finish setup");
    btn.addEventListener("click", guard(btn, () => createPasskey("/auth/setup/options", "/auth/setup/verify", { opts: { setupToken: token.value, email: email.value, displayName: name.value } })));
    return show(h("div", { class: "card center" }, h("h1", {}, "Set up your hub"),
      h("p", { class: "muted" }, "Create the first user. Sign-in is by passkey only; there are no passwords."),
      h("label", {}, "Setup token (the SETUP_TOKEN secret)"), token, h("label", {}, "Email"), email, h("label", {}, "Your name"), name, h("p", {}, btn), err));
  }
  const btn = h("button", {}, "Sign in with passkey");
  btn.addEventListener("click", guard(btn, async () => {
    const { challengeId, options } = await api("POST", "/auth/login/options", {});
    const cred = await navigator.credentials.get({ publicKey: { ...options, challenge: b64u.dec(options.challenge) } });
    await api("POST", "/auth/login/verify", { challengeId, response: assertionJSON(cred) });
  }));
  show(h("div", { class: "card center" }, h("h1", {}, "Software Factory Hub"), h("p", { class: "muted" }, "Sign in with your passkey."), h("p", {}, btn), err));
}

let me, view = { name: "list" }, stream;

async function listScreen() {
  setTitle("Factories");
  const online = factories.filter((f) => presence(f)[1] === "online").length, active = factories.reduce((n, f) => n + (f.activeJobs || 0), 0), jobs = factories.reduce((n, f) => n + (f.jobCount || 0), 0);
  const stat = (n, l) => h("div", { class: "stat" }, h("b", {}, String(n)), h("span", {}, l));
  const nodes = [h("div", { class: "stats" }, stat(factories.length, "factories"), stat(online, "online"), stat(active, "active jobs"), stat(jobs, "jobs in total"))];
  if (!factories.length) nodes.push(h("div", { class: "card muted" }, "No factories yet. Add one to get an API key for your local factory."));
  for (const f of factories) {
    const [label, cls] = presence(f);
    nodes.push(h("div", { class: "card link", onclick: () => go({ name: "factory", id: f.id }) }, h("div", { class: "row" },
      h("div", { class: "grow" }, h("strong", {}, f.name), h("div", { class: "muted small" }, `v${f.version || "?"} · last seen ${ago(f.lastSeenAt)}`)),
      h("span", { class: "muted small" }, `${f.activeJobs} active / ${f.jobCount} jobs`), badge(label, cls),
      f.remoteAccess ? h("a", { class: "openlink", href: `/f/${f.id}/`, onclick: (e) => e.stopPropagation() }, "Open dashboard →") : h("span", { class: "muted small" }, "remote access off"))));
  }
  nodes.push(addFactoryForm(), await notificationsCard(), await invitesCard());
  if (view.addFocus) queueMicrotask(() => { document.getElementById("newFactoryName")?.focus(); view.addFocus = false; });
  show(...nodes);
}

function keyBox(token, name) {
  const cmd = `software-factory hub connect --url ${me.publicUrl} --remote-access`;
  return h("div", { class: "card" }, h("strong", {}, `API key for ${name}`),
    h("p", { class: "muted small" }, "Copy it now: it is shown once. On the machine that runs your factory, run this and paste the key when asked (it keeps the key out of your shell history):"),
    h("pre", {}, cmd), h("p", { class: "muted small" }, "--remote-access lets you open this factory's full dashboard from here. Leave it off to only report progress."), h("pre", {}, token),
    h("div", { class: "row" },
      h("button", { class: "ghost", onclick: (e) => { navigator.clipboard?.writeText(token); e.target.textContent = "Key copied"; } }, "Copy key"),
      h("button", { class: "ghost", onclick: (e) => { navigator.clipboard?.writeText(cmd); e.target.textContent = "Command copied"; } }, "Copy command")));
}

function addFactoryForm() {
  const name = h("input", { id: "newFactoryName", placeholder: "e.g. mac-mini", maxlength: "100", "aria-label": "Factory name" }), out = h("div"), err = h("div", { class: "err" });
  const btn = h("button", {}, "Create factory & API key");
  btn.addEventListener("click", async () => {
    err.textContent = ""; if (!name.value.trim()) return;
    try { const r = await api("POST", "/v1/factories", { orgId: me.orgs[0].id, name: name.value.trim() }); out.replaceChildren(keyBox(r.token, name.value.trim())); name.value = ""; void loadRail(); }
    catch (e) { err.textContent = e.status === 409 ? "A factory with that name already exists." : `Failed: ${e.message}`; }
  });
  return h("div", { class: "card" }, h("h2", { class: "mt0" }, "Add a factory"), h("p", { class: "muted small" }, "Reporting stays off in a local factory until you paste this key into it."), h("div", { class: "row" }, h("div", { class: "grow" }, name), btn), err, out);
}

async function invitesCard() {
  const out = h("div"), err = h("div", { class: "err" }), list = h("div");
  const draw = async () => {
    const { invites } = await api("GET", "/v1/invites");
    list.replaceChildren(...invites.map((i) => {
      const used = !!i.usedAt, expired = !used && new Date(i.expiresAt) < new Date();
      return h("div", { class: "row small" }, h("div", { class: "grow muted" }, used ? `Joined: ${i.usedByEmail || "a user"} (${ago(i.usedAt)})` : expired ? `Expired (${ago(i.expiresAt)})` : `Pending, created ${ago(i.createdAt)}`),
        used || expired ? "" : h("button", { class: "ghost", onclick: async () => { await api("DELETE", `/v1/invites/${i.id}`); void draw(); } }, "Revoke"));
    }));
  };
  const btn = h("button", { class: "ghost" }, "Create invite link");
  btn.addEventListener("click", async () => {
    err.textContent = "";
    try {
      const r = await api("POST", "/v1/invites", {});
      out.replaceChildren(h("p", { class: "muted small" }, "Send this single-use link to the person you're inviting. It expires in 7 days and is shown once. They get their own space; they can't see your factories."), h("pre", {}, r.url),
        h("button", { class: "ghost", onclick: (e) => { navigator.clipboard?.writeText(r.url); e.target.textContent = "Link copied"; } }, "Copy link")); void draw();
    } catch (e) { err.textContent = `Failed: ${e.message}`; }
  });
  await draw().catch(() => {});
  return h("div", { class: "card" }, h("h2", { class: "mt0" }, "Invite someone"), h("p", { class: "muted small" }, "Let another person register their own account on this hub."), btn, err, out, list);
}

// ---- PWA + notifications (Web Push) ----
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => { /* the app works without it */ });
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const iosNeedsInstall = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone; // iOS only allows push from an installed web app

async function notificationsCard() {
  const body = h("div"), err = h("div", { class: "err" });
  const card = h("div", { class: "card" }, h("h2", { class: "mt0" }, "Notifications"), body, err);
  const say = (...kids) => body.replaceChildren(...kids);
  const note = (t) => h("p", { class: "muted small" }, t);
  if (!pushSupported()) { say(note(iosNeedsInstall() ? "On iPhone and iPad, add this site to your Home Screen (Share, then Add to Home Screen) and open it from there to turn on notifications." : "This browser doesn't support push notifications.")); return card; }
  const cfg = await api("GET", "/v1/push/config").catch(() => ({ enabled: false }));
  if (!cfg.enabled) { say(note("Push notifications aren't set up on this hub yet (the server needs its VAPID keys).")); return card; }
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
  if (!reg) { say(note("Still starting up. Reload in a moment.")); return card; }
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  const act = (btn, fn) => btn.addEventListener("click", async () => { err.textContent = ""; btn.disabled = true; try { await fn(); view.addFocus = false; void render(); } catch (e) { err.textContent = e.name === "NotAllowedError" ? "Notifications were not allowed." : `Failed: ${e.message}`; } finally { btn.disabled = false; } });
  if (Notification.permission === "denied" && !sub) { say(note("Notifications are blocked for this site. Allow them in your browser's site settings, then reload.")); return card; }
  if (!sub) {
    const on = h("button", {}, "Turn on for this device");
    act(on, async () => {
      if ((await Notification.requestPermission()) !== "granted") throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u.dec(cfg.publicKey) });
      await api("POST", "/v1/push/subscribe", s.toJSON());
    });
    say(note("Get a notification on this device when a job fails or needs you."), on);
    return card;
  }
  const test = h("button", { class: "ghost" }, "Send a test"), off = h("button", { class: "ghost" }, "Turn off for this device");
  act(test, async () => { const r = await api("POST", "/v1/push/test", {}); err.textContent = r.queued ? "" : "No devices are subscribed."; });
  act(off, async () => { await api("POST", "/v1/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); });
  const prefs = (await api("GET", "/v1/notifications/preferences").catch(() => ({ types: [] }))).types.map((t) => {
    const box = h("input", { type: "checkbox", id: `pref-${t.id}` }); box.checked = t.enabled;
    box.addEventListener("change", async () => { try { await api("PUT", "/v1/notifications/preferences", { types: { [t.id]: box.checked } }); } catch (e) { err.textContent = `Failed: ${e.message}`; box.checked = !box.checked; } });
    return h("label", { class: "check", for: `pref-${t.id}` }, box, `Notify me when ${t.label.charAt(0).toLowerCase()}${t.label.slice(1)}`);
  });
  say(h("p", {}, badge("on for this device", "online")), ...prefs, h("div", { class: "row" }, test, off));
  return card;
}

async function factoryScreen(id) {
  const d = await api("GET", `/v1/factories/${id}`), f = d.factory, [label, cls] = presence(f);
  setTitle(f.name);
  const out = h("div"), err = h("div", { class: "err" });
  const rotate = h("button", { class: "ghost", onclick: async () => { if (!confirm("Replace the API key? The old key stops working immediately.")) return; try { out.replaceChildren(keyBox((await api("POST", `/v1/factories/${id}/rotate-key`, {})).token, f.name)); } catch (e) { err.textContent = e.message; } } }, "Rotate API key");
  const disable = h("button", { class: "danger", onclick: async () => { if (!confirm("Disable this factory and revoke its keys?")) return; await api("POST", `/v1/factories/${id}/disable`, {}); go({ name: "factory", id }); } }, "Disable");
  const table = (cols, rows) => h("div", { class: "card flush table-wrap" }, h("table", {}, h("tr", {}, cols.map((c) => h("th", {}, c))), rows.length ? rows : h("tr", {}, h("td", { class: "muted", colspan: String(cols.length) }, "Nothing yet"))));
  show(
    h("div", { class: "row" }, h("h1", { class: "grow" }, f.name), badge(label, cls), h("button", { class: "ghost", onclick: () => go({ name: "list" }) }, "All factories"), rotate, disable),
    h("p", { class: "muted small" }, `v${f.version || "?"} · last seen ${ago(f.lastSeenAt)} · registered ${ago(f.createdAt)}`), err, out,
    f.remoteAccess
      ? h("div", { class: "card" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("strong", {}, "Full dashboard"), h("div", { class: "muted small" }, "The same dashboard you get locally, running against this factory.")), h("a", { class: "btn", href: `/f/${f.id}/` }, "Open dashboard")))
      : h("div", { class: "card" }, h("strong", {}, "Remote dashboard is off"), h("p", { class: "muted small" }, "Reporting is on, but this factory has not allowed remote access. To open the full dashboard from here, run this on the factory's machine:"), h("pre", {}, "software-factory hub remote-access on")),
    h("h2", {}, "Jobs"), table(["Job", "Project", "Stage", "Status", "Updated"], d.jobs.map((j) => h("tr", {}, h("td", {}, j.title || j.id), h("td", {}, j.project || "–"), h("td", {}, j.stage || "–"), h("td", {}, j.status || "–"), h("td", { class: "muted" }, ago(j.updatedAt))))),
    h("h2", {}, "Recent activity"), table(["When", "Event", "Job", "Detail"], d.events.map((e) => h("tr", {}, h("td", { class: "muted" }, ago(e.occurredAt)), h("td", {}, e.type), h("td", {}, e.jobId || "–"), h("td", { class: "muted small" }, Object.entries(e.payload || {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ").slice(0, 160))))),
    h("h2", {}, "Projects & workflows"), h("p", { class: "muted" }, `${d.projects.map((p) => p.name).join(", ") || "no projects"} · ${d.workflows.map((w) => w.name).join(", ") || "no workflows"}`));
}

async function render() { try { await loadRail(); if (view.name === "factory") await factoryScreen(view.id); else await listScreen(); } catch (e) { if (e.status === 401) await boot(); else show(h("div", { class: "err" }, `Failed to load: ${e.message}`)); } }
function go(v) { view = v; render(); }

function connectStream() {
  stream?.close(); if (!me?.orgs?.[0]) return;
  let t; stream = new EventSource(`/v1/orgs/${me.orgs[0].id}/stream`);
  stream.onmessage = () => { clearTimeout(t); t = setTimeout(render, 500); }; // live: re-render shortly after any update
}
setInterval(() => { if (me) render(); }, 30000); // keeps "last seen" fresh even with no events

const setNav = (open) => { $("shell").classList.toggle("nav-open", open); $("burger").setAttribute("aria-expanded", String(open)); };
$("burger").addEventListener("click", () => setNav(!$("shell").classList.contains("nav-open")));
$("scrim").addEventListener("click", () => setNav(false));
$("rail").addEventListener("click", (e) => { if (e.target.closest("button")) setNav(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setNav(false); });
$("addFactory").addEventListener("click", () => go({ name: "list", addFocus: true }));
$("logout").addEventListener("click", async () => { await api("POST", "/auth/logout", {}); stream?.close(); me = null; await boot(); });
$("addPasskey").addEventListener("click", async () => {
  try { await createPasskey("/v1/passkeys/options", "/v1/passkeys/verify", { opts: {}, verify: { label: prompt("Name this passkey (e.g. iPhone)") || undefined } }); alert("Passkey added."); } catch (e) { if (e.name !== "NotAllowedError") alert(`Failed: ${e.message}`); }
});

async function boot() {
  const st = await api("GET", "/auth/status");
  if (!st.authenticated) { $("shell").classList.add("signed-out"); me = null; return authScreen(st.needsSetup); }
  me = await api("GET", "/v1/me"); $("who").textContent = me.email; $("shell").classList.remove("signed-out");
  connectStream();
  // A notification (or a shared link) can open straight onto a factory: /#factory=<id>
  const wanted = new URLSearchParams(location.hash.slice(1)).get("factory");
  view = wanted && /^[0-9a-f-]{36}$/i.test(wanted) ? { name: "factory", id: wanted } : { name: "list" };
  render();
}
boot().catch((e) => show(h("div", { class: "err" }, `Cannot reach the hub: ${e.message}`)));
