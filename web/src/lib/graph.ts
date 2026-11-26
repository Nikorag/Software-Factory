import { BUILTIN_HELP } from "./builtin-stages";
import { COMPLETE, type StageDef, type WorkflowDef } from "./workflows";

/**
 * A workflow definition as a drawable graph, independent of any job: nodes in execution order, success edges (`next` / order,
 * conditional branches) and failure routes (`goto` rules) as loop edges. Pure: the same definition always lays out the same way.
 */
export const W = 148, H = 52;
const PAD = 28, COL_GAP = 44, GUTTER = 108, LABEL = 22, LANE = 9, MAX_LANES = 8;

export const stageIds = (def: WorkflowDef) => def.stages.map((s) => s.id);

/** The engine's own routing rules (src/workflows/graph.ts) on a plain definition. */
export function compile(def: WorkflowDef) {
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  const index = new Map(def.stages.map((s, i) => [s.id, i]));
  const rawNext = (id: string): string => { const s = byId.get(id); if (s?.next) return s.next; const i = index.get(id); return (i === undefined ? undefined : def.stages[i + 1]?.id) ?? COMPLETE; };
  const resolve = (target: string): string => {
    let t = target;
    for (let n = 0; n <= def.stages.length; n++) {
      const s = t === COMPLETE ? undefined : byId.get(t);
      if (t === COMPLETE || (s && s.enabled)) return t;
      if (!s) return t;
      t = rawNext(t);
    }
    return COMPLETE;
  };
  const entry = def.stages.find((s) => s.enabled)?.id;
  const branches = (s: StageDef) => { const c = s.config as { then?: string; else?: string }; return { then: resolve(c.then ?? COMPLETE), else: resolve(c.else ?? COMPLETE) }; };
  const successors = (id: string): string[] => {
    const s = byId.get(id);
    if (!s) return [];
    if (s.type === "conditional") { const b = branches(s); return [b.then, b.else]; }
    return [resolve(rawNext(id))];
  };
  return { byId, entry, resolve, successors, branches, next: (id: string) => resolve(rawNext(id)) };
}

/** Stages in the order a job runs them (depth-first along the success path), then those only failure routes reach, then disabled ones. */
export function executionOrder(def: WorkflowDef): { main: string[]; side: string[]; disabled: string[] } {
  const c = compile(def);
  const main: string[] = [], seen = new Set<string>();
  const visit = (id: string) => { if (id === COMPLETE || seen.has(id) || !c.byId.get(id)) return; seen.add(id); main.push(id); for (const n of c.successors(id)) visit(n); };
  if (c.entry) visit(c.entry);
  const rest = def.stages.filter((s) => !seen.has(s.id));
  return { main, side: rest.filter((s) => s.enabled).map((s) => s.id), disabled: rest.filter((s) => !s.enabled).map((s) => s.id) };
}

export const subtitleOf = (s: StageDef): string => {
  if (s.type === "factory") return BUILTIN_HELP[s.handler ?? s.id]?.sub ?? "built-in stage";
  if (s.type === "agent" || s.type === "review") return `${s.type} · ${String(s.config.role ?? "")}`;
  if (s.type === "check") return `check · ${String(s.config.command ?? "test")}`;
  return "condition";
};

export interface GNode { id: string; label: string; sub: string; stage: StageDef | null; end: boolean; side: boolean; disabled: boolean; col: number; row: number; x: number; y: number }
export interface GEdge { id: string; from: string; to: string; kind: "flow" | "loop"; label?: string; d: string; lx: number; ly: number; anchor: "start" | "middle" | "end" }
export interface GBand { title: string; sub: string; y: number }
export interface Graph { nodes: GNode[]; edges: GEdge[]; bands: GBand[]; width: number; height: number; byId: Record<string, GNode> }

type Raw = { from: string; to: string; kind: "flow" | "loop"; labels: string[] };
export function rawEdges(def: WorkflowDef): Raw[] {
  const c = compile(def);
  const map = new Map<string, Raw>();
  const add = (from: string, to: string, kind: "flow" | "loop", label?: string) => {
    if (from === to) return;
    const k = `${from}>${to}`, e = map.get(k);
    if (!e) map.set(k, { from, to, kind, labels: label ? [label] : [] });
    else { if (kind === "flow") e.kind = "flow"; if (label && !e.labels.includes(label)) e.labels.push(label); }
  };
  for (const s of def.stages) {
    if (!s.enabled) continue;
    if (s.type === "conditional") { const b = c.branches(s); add(s.id, b.then, "flow", "then"); add(s.id, b.else, "flow", "else"); } else add(s.id, c.next(s.id), "flow");
    for (const r of s.onFailure) if (r.action === "goto" && r.target) add(s.id, c.resolve(r.target), "loop", r.on === "any" ? "any failure" : r.on);
  }
  return [...map.values()];
}

export function layoutDefinition(def: WorkflowDef, names?: Record<string, string>, perRow = 6): Graph {
  const order = executionOrder(def);
  const stageOf = new Map(def.stages.map((s) => [s.id, s]));
  const groups: { ids: string[]; side: boolean; disabled: boolean; title: string; sub: string }[] = [];
  const mainIds = [...order.main, COMPLETE];
  groups.push({ ids: mainIds, side: false, disabled: false, title: "Main flow", sub: "the order a job runs these steps" });
  if (order.side.length) groups.push({ ids: order.side, side: true, disabled: false, title: "Fix and recovery steps", sub: "only reached when a failure route sends the job there" });
  if (order.disabled.length) groups.push({ ids: order.disabled, side: true, disabled: true, title: "Disabled steps", sub: "skipped: the job never enters them" });

  const cols = Math.max(1, Math.min(perRow, Math.max(...groups.map((g) => g.ids.length))));
  const width = PAD * 2 + cols * W + (cols - 1) * COL_GAP;
  const nodes: GNode[] = [], bands: GBand[] = [], rowTop: number[] = [];
  let y = 80, row = 0;
  groups.forEach((g, gi) => {
    if (gi > 0) y += LABEL;
    if (g.side) bands.push({ title: g.title, sub: g.sub, y: y - 8 });
    for (let i = 0; i < g.ids.length; i += cols) {
      g.ids.slice(i, i + cols).forEach((id, c) => {
        const s = stageOf.get(id) ?? null;
        nodes.push({ id, stage: s, end: id === COMPLETE, side: g.side, disabled: g.disabled, col: c, row, x: PAD + c * (W + COL_GAP), y,
          label: id === COMPLETE ? "Complete" : names?.[id] ?? s?.name ?? id, sub: id === COMPLETE ? "job is finished" : s ? subtitleOf(s) : "" });
      });
      rowTop[row] = y; row++; y += H + GUTTER;
    }
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const rows = rowTop.length, bottom = (r: number) => rowTop[r]! + H;
  const rowLen = (r: number) => nodes.filter((n) => n.row === r).length;
  // Gutter g lies above row g (and below row g-1); each route that uses it takes the next lane so routes never share a line.
  const lanes = new Map<number, number>();
  const gutterY = (g: number) => { const n = lanes.get(g) ?? 0; lanes.set(g, n + 1); return (g === 0 ? rowTop[0]! - 14 - (n % MAX_LANES) * LANE : bottom(g - 1) + 14 + (n % MAX_LANES) * LANE); };
  const ports = new Map<string, number>();
  const port = (id: string, side: "t" | "b") => { const k = `${id}${side}`, n = ports.get(k) ?? 0; ports.set(k, n + 1); return ([0, -10, 10, -20, 20, -30, 30][n % 7] ?? 0); };
  let ml = 0, mr = 0;

  const edges: GEdge[] = [];
  for (const e of rawEdges(def)) {
    const a = byId[e.from], b = byId[e.to];
    if (!a || !b) continue;
    const acx = a.x + W / 2, bcx = b.x + W / 2, acy = a.y + H / 2, bcy = b.y + H / 2;
    let pts: [number, number][];
    if (a.row === b.row) {
      if (b.col === a.col + 1 && e.kind === "flow") pts = [[a.x + W, acy], [b.x, bcy]];
      else if (e.kind === "flow" && b.col > a.col) { const gy = gutterY(a.row), pa = acx + port(a.id, "t"), pb = bcx + port(b.id, "t"); pts = [[pa, a.y], [pa, gy], [pb, gy], [pb, b.y]]; }
      else { const gy = gutterY(a.row + 1), pa = acx + port(a.id, "b"), pb = bcx + port(b.id, "b"); pts = [[pa, a.y + H], [pa, gy], [pb, gy], [pb, b.y + H]]; }
    } else if (e.kind === "flow" && b.row === a.row + 1 && b.col === 0 && a.col === rowLen(a.row) - 1) {
      const gy = gutterY(b.row), rx = width - 10 - (mr++ % MAX_LANES) * 4, lx = 8 + (ml++ % MAX_LANES) * 4;
      pts = [[a.x + W, acy], [rx, acy], [rx, gy], [lx, gy], [lx, bcy], [b.x, bcy]];
    } else {
      const left = e.kind === "flow", mx = left ? 8 + (ml++ % MAX_LANES) * 4 : width - 10 - (mr++ % MAX_LANES) * 4;
      if (b.row > a.row) { const g1 = gutterY(a.row + 1), g2 = gutterY(b.row), pa = acx + port(a.id, "b"), pb = bcx + port(b.id, "t"); pts = [[pa, a.y + H], [pa, g1], [mx, g1], [mx, g2], [pb, g2], [pb, b.y]]; }
      else { const g1 = gutterY(a.row), g2 = gutterY(b.row + 1), pa = acx + port(a.id, "t"), pb = bcx + port(b.id, "b"); pts = [[pa, a.y], [pa, g1], [mx, g1], [mx, g2], [pb, g2], [pb, b.y + H]]; }
    }
    // Label on the middle of the longest horizontal run.
    let best = { len: -1, x: pts[0]![0], y: pts[0]![1] };
    for (let i = 1; i < pts.length; i++) { const [x1, y1] = pts[i - 1]!, [x2, y2] = pts[i]!; if (y1 === y2 && Math.abs(x2 - x1) > best.len) best = { len: Math.abs(x2 - x1), x: (x1 + x2) / 2, y: y1 }; }
    edges.push({ id: `${e.from}>${e.to}`, from: e.from, to: e.to, kind: e.kind, ...(e.labels.length ? { label: e.labels.join(" / ") } : {}), d: pts.map(([x, py], i) => `${i ? "L" : "M"}${Math.round(x)},${Math.round(py)}`).join(" "), lx: best.x, ly: best.y - 4, anchor: "middle" });
  }
  const lastGutter = Math.max(...[...lanes.entries()].filter(([g]) => g === rows).map(([, n]) => Math.min(n, MAX_LANES)), 0);
  return { nodes, edges, bands, width, height: bottom(rows - 1) + 20 + (lastGutter ? 14 + lastGutter * LANE : 0), byId };
}
