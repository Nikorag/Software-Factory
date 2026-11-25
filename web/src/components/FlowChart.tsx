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
  if (kind === "run") return <g><circle cx={cx} cy={cy} r={8} fill="none" className="stroke-border" strokeWidth={2.4} /><path d={`M${cx},${cy - 8} A8,8 0 0 1 ${cx + 8},${cy}`} fill="none" className="anim stroke-run animate-spin" style={{ transformBox: "fill-box", transformOrigin: "center" }} strokeWidth={2.6} strokeLinecap="round" /></g>;
  if (kind === "wait") return <g><circle cx={cx} cy={cy} r={9} fill="none" className="stroke-wait" strokeWidth={2} /><path d={`M${cx},${cy - 5} V${cy} l4,2.5`} fill="none" className="stroke-wait" strokeWidth={2} strokeLinecap="round" /></g>;
  if (kind === "fail") return <g><circle cx={cx} cy={cy} r={9} className="fill-destructive" /><path d={`M${cx},${cy - 4.5} V${cy + 1}`} className="stroke-background" strokeWidth={2.2} strokeLinecap="round" /><circle cx={cx} cy={cy + 4.6} r={1.2} className="fill-background" /></g>;
  return <circle cx={cx} cy={cy} r={8} fill="none" className="stroke-border" strokeWidth={2} />;
}

const boxClass = (st: NodeState, fix: boolean, used: boolean) =>
  cn("fill-card stroke-border", st === "done" && "stroke-ok/60", st === "run" && "fill-run/10 stroke-run", st === "fail" && "fill-destructive/10 stroke-destructive", st === "wait" && "stroke-wait [stroke-dasharray:5_3]",
    fix && !used && "[stroke-dasharray:4_3]", fix && used && "fill-loop/10 stroke-loop [stroke-dasharray:none]");

export function FlowChart({ flow, selected, onSelect }: { flow: Flow; selected: string | null; onSelect: (id: string) => void }) {
  const st = (id: string): NodeState => flow.state[id] ?? "idle";
  return (
    <div className="overflow-x-auto pb-1">
      <svg viewBox="0 0 1180 640" role="img" aria-label="Pipeline flow chart" width={1180} height={640} className="mx-auto block h-auto max-w-none">
        <defs>
          {([["m-off", "fill-border"], ["m-ok", "fill-ok"], ["m-run", "fill-run"], ["m-loop", "fill-loop"]] as const).map(([id, c]) => (
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
          let cls = "stroke-border", marker = "m-off", extra = "";
          if (e.kind === "flow") {
            if (!flow.skipped.has(e.id) && a === "done" && b === "run") { cls = "stroke-run"; marker = "m-run"; extra = "anim [stroke-dasharray:6_5] animate-[flow_1s_linear_infinite]"; }
            else if (!flow.skipped.has(e.id) && a === "done" && (b === "done" || b === "wait" || b === "fail")) { cls = "stroke-ok"; marker = "m-ok"; }
          } else if (flow.loopsUsed.has(e.id)) { cls = "stroke-loop"; marker = "m-loop"; }
          else extra = "[stroke-dasharray:5_4]";
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
              <text x={n.x + 12} y={n.y + 22} className={cn("text-[13px] font-semibold", s === "idle" ? "fill-muted-foreground" : "fill-foreground")}>{n.label}</text>
              <text x={n.x + 12} y={n.y + 40} className={cn("text-[11px]", s === "run" || s === "wait" ? "fill-run" : "fill-muted-foreground", d ? "font-mono" : "")}>{subtitle(n, s, d)}</text>
              <Icon kind={s} cx={n.x + W - 20} cy={n.y + 17} />
              {att > 1 || (n.fix && att >= 1) ? (
                <g><rect x={n.x + W - 34} y={n.y - 15} width={30} height={18} rx={9} className="fill-card stroke-loop" strokeWidth={1.5} /><text x={n.x + W - 19} y={n.y - 2} textAnchor="middle" className="fill-loop text-[11px] font-semibold">×{att}</text></g>
              ) : null}
            </g>
          );
        })}
      </svg>
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
      {item("stroke-ok", "route taken")}{item("stroke-run [stroke-dasharray:6_5]", "running now")}{item("stroke-loop", "sent back for fixes")}{item("stroke-border [stroke-dasharray:5_4]", "possible route, not used")}
    </div>
  );
}
