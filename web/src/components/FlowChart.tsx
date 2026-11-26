import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { EDGES, H, NODES, W, type Flow, type NodeState } from "@/lib/pipeline";

// Labels sit clear of the long return routes (y=262 and y=534); the last band's label goes to the free space right of its row.
const BANDS = [
  { t: "Understand the ticket", s: "Requirements, Spec Kit, independent spec review", x: 24, y: 40, sy: 40, anchor: "start" as const },
  { t: "Build and verify", s: "Sandboxed implementation, checks, two reviews, final gates", x: 24, y: 290, sy: 290, anchor: "start" as const },
  { t: "Deliver", s: "Pull request, CI, then your merge", x: 960, y: 570, sy: 588, anchor: "start" as const },
];

function Icon({ kind, cx, cy }: { kind: NodeState; cx: number; cy: number }) {
  if (kind === "done") return <g><circle cx={cx} cy={cy} r={9} className="fill-ok" /><path d={`M${cx - 4},${cy} l3,3 l5,-6`} className="stroke-background" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></g>;
  if (kind === "run") return <g><circle cx={cx} cy={cy} r={8} fill="none" className="stroke-border" strokeWidth={2.4} /><path d={`M${cx},${cy - 8} A8,8 0 0 1 ${cx + 8},${cy}`} fill="none" className="anim stroke-run animate-spin" style={{ transformBox: "view-box", transformOrigin: `${cx}px ${cy}px` }} strokeWidth={2.6} strokeLinecap="round" /></g>;
  if (kind === "wait") return <g><circle cx={cx} cy={cy} r={9} fill="none" className="stroke-wait" strokeWidth={2} /><path d={`M${cx},${cy - 5} V${cy} l4,2.5`} fill="none" className="stroke-wait" strokeWidth={2} strokeLinecap="round" /></g>;
  if (kind === "fail") return <g><circle cx={cx} cy={cy} r={9} className="fill-destructive" /><path d={`M${cx},${cy - 4.5} V${cy + 1}`} className="stroke-background" strokeWidth={2.2} strokeLinecap="round" /><circle cx={cx} cy={cy + 4.6} r={1.2} className="fill-background" /></g>;
  return <circle cx={cx} cy={cy} r={8} fill="none" className="stroke-border" strokeWidth={2} />;
}

const boxClass = (st: NodeState, fix: boolean, used: boolean) =>
  cn("fill-[#141417] stroke-[#2A2A30]", st === "idle" && "fill-[#111113]", st === "done" && "stroke-[#2F6B45]", st === "run" && "fill-[#121A26] stroke-run [stroke-dasharray:5_3]",
    st === "fail" && "fill-[#1F1214] stroke-destructive", st === "wait" && "fill-[#1F1A0E] stroke-wait [stroke-dasharray:5_3]",
    fix && !used && st === "idle" && "[stroke-dasharray:4_3]", fix && used && "fill-[#211B10] stroke-[#B7862A] [stroke-dasharray:none]");

const MAX_ZOOM = 3;
type View = { s: number; x: number; y: number };

/** The chart lives in its own canvas: drag to pan in any direction, pinch (or ctrl/⌘-wheel, or the buttons) to zoom. The page itself keeps scrolling everywhere else. */
function usePanZoom() {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: W_FULL, h: 0 });
  const [view, setView] = useState<View | null>(null); // null = fitted to width
  const fit = Math.min(1, size.w / W_FULL);
  const height = Math.round(Math.min(H_FULL, Math.max(H_FULL * fit, 340)));
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || W_FULL, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const clamp = useCallback((v: View): View => {
    const s = Math.min(MAX_ZOOM, Math.max(fit, v.s)), cw = W_FULL * s, ch = H_FULL * s;
    const axis = (pos: number, content: number, port: number) => (content <= port ? (port - content) / 2 : Math.min(0, Math.max(port - content, pos)));
    return { s, x: axis(v.x, cw, size.w), y: axis(v.y, ch, height) };
  }, [fit, size.w, height]);
  const cur = clamp(view ?? { s: fit, x: 0, y: 0 });
  const zoomAt = useCallback((factor: number, px: number, py: number) => setView((prev) => {
    const c = clamp(prev ?? { s: fit, x: 0, y: 0 }), s = Math.min(MAX_ZOOM, Math.max(fit, c.s * factor)), k = s / c.s;
    return clamp({ s, x: px - (px - c.x) * k, y: py - (py - c.y) * k });
  }), [clamp, fit]);

  const pts = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; dist: number; ox: number; oy: number } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => { const r = box.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      pts.current.set(e.pointerId, local(e));
      gesture.current = { moved: pts.current.size > 1, dist: 0, ox: e.clientX, oy: e.clientY };
      if (pts.current.size === 2) { const [a, b] = [...pts.current.values()]; gesture.current.dist = Math.hypot(a!.x - b!.x, a!.y - b!.y); }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const g = gesture.current, prev = pts.current.get(e.pointerId); if (!g || !prev) return;
      const now = local(e);
      if (!g.moved && Math.hypot(e.clientX - g.ox, e.clientY - g.oy) < 6) return; // still a tap
      if (!g.moved) { g.moved = true; try { box.current!.setPointerCapture(e.pointerId); } catch { /* not capturable */ } }
      if (pts.current.size >= 2) {
        pts.current.set(e.pointerId, now);
        const [a, b] = [...pts.current.values()], d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (g.dist > 0) zoomAt(d / g.dist, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        g.dist = d;
      } else {
        pts.current.set(e.pointerId, now);
        setView((v) => { const c = clamp(v ?? { s: fit, x: 0, y: 0 }); return clamp({ ...c, x: c.x + now.x - prev.x, y: c.y + now.y - prev.y }); });
      }
    },
    onPointerUp: (e: React.PointerEvent) => { pts.current.delete(e.pointerId); if (pts.current.size === 0) setTimeout(() => { gesture.current = null; }, 0); else if (gesture.current) gesture.current.dist = 0; },
    onPointerCancel: (e: React.PointerEvent) => { pts.current.delete(e.pointerId); if (pts.current.size === 0) gesture.current = null; },
    // A drag or pinch must not also select the node it ended on.
    onClickCapture: (e: React.MouseEvent) => { if (gesture.current?.moved) { e.stopPropagation(); e.preventDefault(); } },
  };
  useEffect(() => {
    const el = box.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const p = local(e); zoomAt(Math.exp(-e.deltaY * 0.01), p.x, p.y); };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);
  return { box, handlers, view: cur, height, zoomAt, reset: () => setView(null), center: { x: size.w / 2, y: height / 2 }, zoomed: cur.s > fit + 0.001 };
}
const W_FULL = 1180, H_FULL = 640;

export function FlowChart({ flow, selected, onSelect }: { flow: Flow; selected: string | null; onSelect: (id: string) => void }) {
  const st = (id: string): NodeState => flow.state[id] ?? "idle";
  const pz = usePanZoom();
  const btn = "flex size-8 items-center justify-center rounded-md border border-input bg-background/90 text-muted-foreground hover:text-foreground";
  return (
    <div className="relative">
      <div ref={pz.box} data-testid="flow-canvas" style={{ height: pz.height }} className="relative touch-none select-none overflow-hidden overscroll-contain rounded-lg" {...pz.handlers}>
        <div style={{ width: W_FULL, height: H_FULL, transform: `translate(${pz.view.x}px, ${pz.view.y}px) scale(${pz.view.s})`, transformOrigin: "0 0" }}>
      <svg viewBox="0 0 1180 640" width={W_FULL} height={H_FULL} role="img" aria-label="Pipeline flow chart" className="block">
        <defs>
          {([["m-off", "fill-[#3F3F46]"], ["m-ok", "fill-ok"], ["m-run", "fill-run"], ["m-loop", "fill-loop"]] as const).map(([id, c]) => (
            <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className={c} /></marker>
          ))}
        </defs>
        {BANDS.map((b) => (
          <g key={b.t}>
            <text x={b.x} y={b.y} textAnchor={b.anchor} className="fill-muted-foreground text-[11px] font-semibold uppercase tracking-widest">{b.t}</text>
            {b.sy === b.y ? <text x={b.x + b.t.length * 8.2 + 16} y={b.sy} className="fill-muted-foreground text-[11px]">{b.s}</text> : <text x={b.x} y={b.sy} className="fill-muted-foreground text-[11px]">{b.s}</text>}
          </g>
        ))}
        {EDGES.map((e) => {
          const a = st(e.from), b = st(e.to);
          let cls = "stroke-[#3F3F46]", marker = "m-off", extra = "[stroke-dasharray:5_5]";
          if (e.kind === "flow") {
            if (!flow.skipped.has(e.id) && a === "done" && b === "run") { cls = "stroke-run"; marker = "m-run"; extra = "anim [stroke-dasharray:6_5] animate-[flow_1s_linear_infinite]"; }
            else if (!flow.skipped.has(e.id) && a === "done" && (b === "done" || b === "wait" || b === "fail")) { cls = "stroke-ok"; marker = "m-ok"; extra = ""; }
          } else if (flow.loopsUsed.has(e.id)) { cls = "stroke-loop"; marker = "m-loop"; extra = ""; }
          return <path key={e.id} d={e.d} fill="none" strokeWidth={e.kind === "loop" && flow.loopsUsed.has(e.id) ? 2.4 : 2} className={cn(cls, extra)} markerEnd={`url(#${marker})`} />;
        })}
        {EDGES.filter((e) => e.label && e.kind === "loop").map((e) => {
          const used = flow.loopsUsed.has(e.id);
          return <text key={`l-${e.id}`} x={e.label!.x} y={e.label!.y} textAnchor={e.label!.a} opacity={used ? 1 : 0.55} className={cn("text-[11px] font-medium [paint-order:stroke] stroke-background [stroke-width:5px] [stroke-linejoin:round]", used ? "fill-loop" : "fill-muted-foreground")}>{e.label!.t}</text>;
        })}
        {NODES.map((n) => {
          const s = st(n.id), used = !!n.fix && s === "done", att = flow.attempts[n.id] ?? 0, d = flow.duration[n.id];
          return (
            <g key={n.id} tabIndex={0} role="button" aria-label={`${n.label}: ${s}`} aria-pressed={selected === n.id} className="cursor-pointer outline-none [&:focus-visible_.sel]:opacity-100" onClick={() => onSelect(n.id)}
              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect(n.id); } }}>
              <rect x={n.x} y={n.y} width={W} height={H} rx={9} strokeWidth={s === "run" || s === "fail" || s === "wait" || used ? 2 : 1.5} className={boxClass(s, !!n.fix, used)} />
              {s === "run" && <rect x={n.x} y={n.y} width={W} height={H} rx={9} fill="none" strokeWidth={2} className="anim stroke-run opacity-50 animate-[pulse-ring_1.6s_ease-out_infinite]" style={{ transformBox: "fill-box", transformOrigin: "center" }} />}
              <rect x={n.x - 4} y={n.y - 4} width={W + 8} height={H + 8} rx={12} fill="none" strokeWidth={1.5} className={cn("sel stroke-foreground [stroke-dasharray:3_3]", selected === n.id ? "opacity-100" : "opacity-0")} />
              <text x={n.x + 12} y={n.y + 22} className={cn("text-[13px] font-semibold", s === "idle" ? "fill-muted-foreground" : "fill-foreground")} {...(n.label.length > 16 ? { textLength: W - 24, lengthAdjust: "spacingAndGlyphs" as const } : {})}>{n.label}</text>
              <text x={n.x + 12} y={n.y + 40} className={cn("text-[11px]", s === "run" || s === "wait" ? "fill-run" : "fill-muted-foreground", d ? "font-mono" : "")}>{subtitle(n, s, d)}</text>
              {/* The status badge sits on the bottom-right corner, half outside the box, so it can never overlap the title or the subtitle. */}
              <circle cx={n.x + W - 3} cy={n.y + H - 1} r={11} className="fill-[#141417]" />
              <Icon kind={s} cx={n.x + W - 3} cy={n.y + H - 1} />
              {att > 1 || (n.fix && att >= 1) ? (
                <g><rect x={n.x + W - 34} y={n.y - 15} width={30} height={18} rx={9} className="fill-[#1F1A0E] stroke-loop" strokeWidth={1.5} /><text x={n.x + W - 19} y={n.y - 2} textAnchor="middle" className="fill-loop text-[11px] font-semibold">×{att}</text></g>
              ) : null}
            </g>
          );
        })}
      </svg>
        </div>
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1.5">
        <button type="button" className={btn} aria-label="Zoom out" onClick={() => pz.zoomAt(1 / 1.4, pz.center.x, pz.center.y)}><Minus className="size-4" /></button>
        <button type="button" className={btn} aria-label="Zoom in" onClick={() => pz.zoomAt(1.4, pz.center.x, pz.center.y)}><Plus className="size-4" /></button>
        {pz.zoomed ? <button type="button" className={btn} aria-label="Fit chart to screen" onClick={pz.reset}><Maximize2 className="size-4" /></button> : null}
      </div>
    </div>
  );
}

/** Once a step has run, its line shows how long it took; before that, what it does. Never both, so they cannot overlap. */
function subtitle(n: { sub: string; fix?: boolean }, s: NodeState, d: number | undefined) {
  if (d) return s === "run" ? `running · ${fmt(d)}` : fmt(d);
  if (s === "run") return "running now";
  if (s === "wait") return "waiting";
  return n.fix && s === "idle" ? "not needed so far" : n.sub;
}
const fmt = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };

export function FlowLegend() {
  const item = (cls: string, label: string) => <span className="inline-flex items-center gap-2"><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" strokeWidth="2.4" className={cls} /></svg>{label}</span>;
  return (
    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {item("stroke-ok", "route taken")}{item("stroke-run [stroke-dasharray:6_5]", "running now")}{item("stroke-loop", "sent back for fixes")}{item("stroke-[#52525B] [stroke-dasharray:5_4]", "possible route, not used")}
    </div>
  );
}
