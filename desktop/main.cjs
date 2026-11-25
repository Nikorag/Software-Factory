// The Software Factory desktop app: a window onto a profile's dashboard. It is deliberately thin: the factory itself runs as a
// background service (started by `software-factory start`) and keeps working when this window is closed.
const { app, BrowserWindow, Menu, Notification, Tray, shell, dialog, session, nativeImage } = require("electron");
const { summarise, pollPlan } = require("./tray-model.cjs");
const { newInterruptions } = require("./notify-model.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = process.env.FACTORY_ROOT || path.join(os.homedir(), ".software-factory");
const ICON = path.join(__dirname, "icon.png");
const SMOKE = process.env.FACTORY_DESKTOP_SMOKE === "1";
const SMOKE_TRAY = process.env.FACTORY_DESKTOP_SMOKE_TRAY === "1"; // test hook: close the window, prove the menu bar icon keeps the app alive, reopen it
let tray = null;
let quitting = false;

app.setName("Software Factory"); // before ready: menus, the About panel and window titles use this
app.setAboutPanelOptions({ applicationName: "Software Factory", applicationVersion: require("../package.json").version, copyright: "Runs on your machine. It never merges: you do." });

const readProfiles = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "profiles.json"), "utf8")).profiles; } catch { return [{ name: "default", home: ROOT, port: 4780 }]; }
};
const urlOf = (p) => `http://127.0.0.1:${p.port}/`;
const profileArg = (argv) => { const i = argv.indexOf("--profile"); return i >= 0 && argv[i + 1] ? argv[i + 1] : "default"; };
const find = (name) => readProfiles().find((p) => p.name === name) || readProfiles()[0];

async function up(p) { try { return (await fetch(`${urlOf(p)}health`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }
async function counts(p) {
  try { const o = await (await fetch(`${urlOf(p)}api/overview`, { signal: AbortSignal.timeout(1500) })).json(); const c = o.counts?.byStatus ?? {}; return { running: c.running ?? 0, queued: c.queued ?? 0, waiting: c.waiting ?? 0 }; } catch { return { running: 0, queued: 0, waiting: 0 }; }
}
async function activeJobs(p) {
  try { const o = await (await fetch(`${urlOf(p)}api/overview`, { signal: AbortSignal.timeout(1500) })).json(); return (o.counts?.byStatus?.running ?? 0); } catch { return 0; }
}
const pidOf = (p) => { try { const n = Number(fs.readFileSync(path.join(p.home, "factory.lock"), "utf8").trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } };

let win = null;
let current = find(profileArg(process.argv));

const origins = () => new Set(readProfiles().map((p) => new URL(urlOf(p)).origin));

const stoppedPage = (p) => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset=utf-8><title>Software Factory</title>
<body style="font:15px -apple-system,sans-serif;background:#18181b;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:460px;text-align:center"><h2 style="margin:0 0 8px">Profile “${p.name.replace(/[<>&"]/g, "")}” is not running</h2>
<p style="color:#a1a1aa">Choose <b>Profiles → Start all profiles</b> in the menu, or run <code>software-factory start</code> in a terminal.</p></div>`)}`;

async function show(p) {
  current = p;
  if (!win) return;
  win.setTitle(`Software Factory — ${p.name}`);
  if (await up(p)) win.loadURL(urlOf(p)); else win.loadURL(stoppedPage(p));
}

function startAll() {
  const cmd = process.env.FACTORY_START_JSON ? JSON.parse(process.env.FACTORY_START_JSON) : null;
  if (!cmd) { dialog.showErrorBox("Software Factory", "Run `software-factory start` in a terminal to start the factory."); return; }
  const env = { ...process.env, FACTORY_ROOT: ROOT }; delete env.ELECTRON_RUN_AS_NODE;
  spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore", env }).unref();
  setTimeout(() => void show(current), 6000);
}

async function stopAll() {
  const profs = readProfiles();
  let running = 0;
  for (const p of profs) if (await up(p)) running += await activeJobs(p);
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: running ? "warning" : "question", buttons: ["Stop the factory", "Cancel"], defaultId: 1, cancelId: 1, title: "Stop the factory?",
    message: running ? `${running} job${running === 1 ? " is" : "s are"} running right now.` : "Stop every profile's factory?",
    detail: running ? "Stopping aborts the running agents. Their jobs are put back untouched and the stage in progress is redone at the next start." : "Nothing is running. The factory will not pick up tickets until you start it again.",
  });
  if (response !== 0) return;
  for (const p of profs) { const pid = pidOf(p); if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } } }
  quitting = true;
  setTimeout(() => app.quit(), 800);
}


// ---- the menu bar icon: the app stays here when its window is closed, so the factory is one click away while the engine runs ----
/** Showing the Dock icon again after it was hidden brings back the default Electron icon, so set ours every time. */
function setDockIcon() { if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock?.setIcon(nativeImage.createFromPath(ICON)); }
function showDock() { if (process.platform !== "darwin" || !app.dock) return; setDockIcon(); void Promise.resolve(app.dock.show()).then(setDockIcon); }

function openWindow(profile) {
  if (profile) current = profile;
  if (process.platform === "darwin") void showDock();
  void pollStatus(); // the window counts towards the polling pace: re-plan now
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); if (profile) void show(profile); }
}

async function refreshTray() {
  if (!tray) return;
  const profs = readProfiles();
  const status = await Promise.all(profs.map(async (p) => { const isUp = await up(p); return { name: p.name, up: isUp, ...(isUp ? await counts(p) : {}) }; }));
  const m = summarise(status);
  lastSummary = m;
  tray.setToolTip(m.tooltip);
  if (process.platform === "darwin") tray.setTitle(m.title);
  const items = [
    { label: "Open Software Factory", click: () => openWindow() },
    { type: "separator" },
    ...m.lines.map((l) => ({ label: l.label, click: () => openWindow(profs.find((p) => p.name === l.name)) })),
    { type: "separator" },
    ...(!m.allUp ? [{ label: "Start all profiles", click: startAll }] : []),
    { label: "Check for Updates…", click: () => { openWindow(); if (win) win.loadURL(`${urlOf(current)}#/settings?tab=system`); } },
    { type: "separator" },
    { label: "Quit (the factory keeps running)", click: () => { quitting = true; app.quit(); } },
    { label: "Stop the Factory and Quit…", click: () => void stopAll() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  return m;
}

// ---- polling pace (see pollPlan): one timer chain each, re-planned after every poll from what the last one saw ----
let lastSummary = null, statusTimer = null, interruptionsTimer = null;
const plan = () => pollPlan({ ...(lastSummary ?? {}), windowVisible: Boolean(win && !win.isDestroyed() && win.isVisible()) });
async function pollStatus() {
  clearTimeout(statusTimer);
  try { await buildMenu(await refreshTray()); } catch { /* next poll */ }
  clearTimeout(statusTimer); statusTimer = setTimeout(() => void pollStatus(), plan().statusMs);
}
async function pollInterruptions() {
  clearTimeout(interruptionsTimer);
  try { await checkInterruptions(); } catch { /* next poll */ }
  clearTimeout(interruptionsTimer); interruptionsTimer = setTimeout(() => void pollInterruptions(), plan().interruptionsMs);
}

// ---- system notifications for interruptions: a job that stops and needs you (a question, a fix-cycle limit, a failure) ----
const seenInterruptions = new Set(), seededProfiles = new Set();
async function checkInterruptions() {
  if (SMOKE || !Notification.isSupported()) return;
  for (const p of readProfiles()) {
    if (!(await up(p))) continue;
    let jobs;
    try {
      const get = async (status) => (await (await fetch(`${urlOf(p)}api/jobs?status=${status}&archived=hide&pageSize=50`, { signal: AbortSignal.timeout(1500) })).json()).jobs ?? [];
      jobs = [...(await get("waiting")), ...(await get("failed"))];
    } catch { continue; }
    const fresh = newInterruptions(p.name, jobs, seenInterruptions, seededProfiles.has(p.name));
    seededProfiles.add(p.name);
    for (const n of fresh) {
      const note = new Notification({ title: n.title, body: n.body, silent: false });
      note.on("click", () => { openWindow(find(n.profile)); if (win) win.loadURL(`${urlOf(find(n.profile) ?? current)}#/jobs/${encodeURIComponent(n.jobId)}`); });
      note.show();
    }
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "trayTemplate.png")); // black with alpha: macOS tints it for light and dark menu bars
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Software Factory");
  tray.on("double-click", () => openWindow());
  void pollInterruptions();
}

/** @param m the tray's latest summary, when there is a tray: saves probing every profile a second time */
async function buildMenu(m) {
  const profs = readProfiles();
  const status = await Promise.all(profs.map((p) => { const l = m?.lines.find((x) => x.name === p.name); return l ? l.up : up(p); }));
  const template = [
    { label: app.name, submenu: [
      { role: "about" },
      { label: "Check for Updates…", click: () => { if (win) win.loadURL(`${urlOf(current)}#/settings?tab=system`); } },
      { type: "separator" },
      { label: "Stop the Factory and Quit…", click: () => void stopAll() },
      { label: "Quit (the factory keeps running)", accelerator: "CmdOrCtrl+Q", click: () => { quitting = true; app.quit(); } },
    ] },
    { label: "Profiles", submenu: [
      ...profs.map((p, i) => ({ label: `${p.name}${status[i] ? "" : "  (stopped)"}`, type: "radio", checked: p.name === current.name, click: () => void show(p) })),
      { type: "separator" }, { label: "Start all profiles", click: startAll },
      { label: "Manage profiles…", click: () => { if (win) win.loadURL(`${urlOf(current)}#/settings`); } },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Test hook: closing the window must not end the app while the menu bar icon exists, and the icon must bring the window back. */
function trayRoundTrip() {
  win.close();
  setTimeout(() => {
    console.log(`TRAY-SMOKE after close: windows=${BrowserWindow.getAllWindows().length} tray=${tray && !tray.isDestroyed() ? "present" : "missing"}`);
    openWindow();
    win.webContents.once("did-finish-load", () => { console.log(`TRAY-SMOKE reopened: windows=${BrowserWindow.getAllWindows().length} url=${win.webContents.getURL()}`); quitting = true; app.quit(); });
  }, 1200);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, title: `Software Factory — ${current.name}`, backgroundColor: "#18181b", show: !SMOKE,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  // The page is our own loopback dashboard. It may navigate between our own profiles; links out go to the browser, and only https GitHub ones (plus the Atlassian sign-in).
  const external = (u) => { try { const x = new URL(u); if (x.protocol === "https:" && ["github.com", "auth.atlassian.com"].includes(x.hostname)) void shell.openExternal(u); /* GitHub links, and the Atlassian sign-in for connecting Jira */ } catch { /* ignore */ } };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (url.startsWith("data:")) return; try { if (origins().has(new URL(url).origin)) return; } catch { /* fall through */ } e.preventDefault(); external(url); });
  win.on("closed", () => { win = null; });
  win.webContents.on("page-title-updated", (e) => e.preventDefault()); // keep the profile name in the title
  win.webContents.once("did-finish-load", () => {
    if (SMOKE) { console.log(`SMOKE ok url=${win.webContents.getURL()} title=${win.getTitle()}`); app.quit(); }
    if (SMOKE_TRAY) trayRoundTrip();
  });
  void show(current);
}

if (!SMOKE && !app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on("second-instance", (_e, argv) => openWindow(find(profileArg(argv)))); // `software-factory` again: bring the window back, even from the menu bar
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // no camera, mic, location, notifications...
    setDockIcon();
    if (!SMOKE) createTray();
    createWindow();
    void pollStatus(); // tray and app menu, at the pace pollPlan sets (after the window exists: it counts towards the pace)
    app.on("activate", () => { if (!win) createWindow(); });
  });
  // Closing the window keeps the app in the menu bar (no Dock icon) so it can be reopened with one click; the factory itself is a separate
  // background service either way. Quit from the menu bar icon or the app menu to really close the app.
  app.on("window-all-closed", () => { if (SMOKE || quitting || !tray) app.quit(); else if (process.platform === "darwin") app.dock?.hide(); });
  app.on("before-quit", () => { quitting = true; });
}
