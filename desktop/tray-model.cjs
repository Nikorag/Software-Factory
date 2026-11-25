// What the menu bar icon says, as plain data (no Electron here, so it can be tested). Input is one status per profile.
/** @param {{name: string, up: boolean, running?: number, queued?: number, waiting?: number}[]} profiles */
function summarise(profiles) {
  const up = profiles.filter((p) => p.up);
  const running = up.reduce((n, p) => n + (p.running || 0), 0);
  const queued = up.reduce((n, p) => n + (p.queued || 0), 0);
  const waiting = up.reduce((n, p) => n + (p.waiting || 0), 0); // held for a person, or waiting on CI or a merge
  const plural = (n, w) => `${n} ${w}`;
  const parts = [];
  if (running) parts.push(plural(running, running === 1 ? "job running" : "jobs running"));
  if (queued) parts.push(`${queued} queued`);
  if (waiting) parts.push(`${waiting} waiting`);
  const tooltip = !up.length ? "Software Factory: stopped" : `Software Factory: ${parts.join(", ") || "idle"}`;
  return {
    running, queued, waiting, anyUp: up.length > 0, allUp: up.length === profiles.length,
    // the number next to the icon: what is running now; a dot-and-number when nothing runs but something is waiting on you
    title: running ? ` ${running}` : waiting ? ` ·${waiting}` : "",
    tooltip,
    lines: profiles.map((p) => ({
      name: p.name, up: p.up,
      label: !p.up ? `○ ${p.name}: stopped` : `● ${p.name}: ${[p.running ? `${p.running} running` : "", p.queued ? `${p.queued} queued` : "", p.waiting ? `${p.waiting} waiting` : ""].filter(Boolean).join(", ") || "idle"}`,
    })),
  };
}

/**
 * How often the menu bar app polls the services. Every poll is a few HTTP requests per profile, and the app sits in the menu bar
 * all day, so: quick while jobs are running or queued (counts change, interruptions can appear), relaxed while the window is open,
 * and slow when the factory is idle (or stopped) and the window is closed. Interruptions only arise from jobs that run.
 * @param {{running?: number, queued?: number, windowVisible?: boolean}} s
 */
function pollPlan(s) {
  if ((s.running || 0) > 0 || (s.queued || 0) > 0) return { statusMs: 5000, interruptionsMs: 10000 };
  if (s.windowVisible) return { statusMs: 10000, interruptionsMs: 30000 };
  return { statusMs: 30000, interruptionsMs: 60000 };
}
module.exports = { summarise, pollPlan };
