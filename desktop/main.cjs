// The Software Factory desktop app: a window onto a profile's dashboard. It is deliberately thin: the factory itself runs as a
// background service (started by `software-factory start`) and keeps working when this window is closed.
const { app, BrowserWindow, Menu, shell, dialog, session, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = process.env.FACTORY_ROOT || path.join(os.homedir(), ".software-factory");
const ICON = path.join(__dirname, "icon.png");
const SMOKE = process.env.FACTORY_DESKTOP_SMOKE === "1";

const readProfiles = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "profiles.json"), "utf8")).profiles; } catch { return [{ name: "default", home: ROOT, port: 4780 }]; }
};
const urlOf = (p) => `http://127.0.0.1:${p.port}/`;
const profileArg = (argv) => { const i = argv.indexOf("--profile"); return i >= 0 && argv[i + 1] ? argv[i + 1] : "default"; };
const find = (name) => readProfiles().find((p) => p.name === name) || readProfiles()[0];

async function up(p) { try { return (await fetch(`${urlOf(p)}health`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }
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
  setTimeout(() => app.quit(), 800);
}

async function buildMenu() {
  const profs = readProfiles();
  const status = await Promise.all(profs.map((p) => up(p)));
  const template = [
    { label: app.name, submenu: [
      { role: "about" }, { type: "separator" },
      { label: "Stop the Factory and Quit…", click: () => void stopAll() },
      { role: "quit", label: "Quit (the factory keeps running)" },
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
  win.webContents.once("did-finish-load", () => { if (SMOKE) { console.log(`SMOKE ok url=${win.webContents.getURL()} title=${win.getTitle()}`); app.quit(); } });
  void show(current);
}

if (!SMOKE && !app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on("second-instance", (_e, argv) => { current = find(profileArg(argv)); if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.focus(); void show(current); } });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // no camera, mic, location, notifications...
    if (process.platform === "darwin" && fs.existsSync(ICON)) app.dock?.setIcon(nativeImage.createFromPath(ICON));
    void buildMenu(); setInterval(() => void buildMenu(), 5000);
    createWindow();
    app.on("activate", () => { if (!win) createWindow(); });
  });
  app.on("window-all-closed", () => app.quit()); // closing the window quits the app; the background factory is separate and keeps running
}
