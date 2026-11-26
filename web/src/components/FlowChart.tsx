import { useId } from "react";
import { cn } from "@/lib/utils";
import { H, W, type GNode, type Graph } from "@/lib/graph";
import { nodeState, type Flow, type NodeState } from "@/lib/pipeline";

function Icon({ kind, cx, cy }: { kind: NodeState; cx: number; cy: number }) {
  if (kind === "done") return <g><circle cx={cx} cy={cy} r={9} className="fill-ok" /><path d={`M${cx - 4},${cy} l3,3 l5,-6`} className="stroke-background" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></g>;
  if (kind === "run") return <g><circle cx={cx} cy={cy} r={8} fill="none" className="stroke-border" strokeWidth={2.4} /><path d={`M${cx},${cy - 8} A8,8 0 0 1 ${cx + 8},${cy}`} fill="none" className="anim stroke-run animate-spin" style={{ transformBox: "view-box", transformOrigin: `${cx}px ${cy}px` }} strokeWidth={2.6} strokeLinecap="round" /></g>;
  if (kind === "wait") return <g><circle cx={cx} cy={cy} r={9} fill="none" className="stroke-wait" strokeWidth={2} /><path d={`M${cx},${cy - 5} V${cy} l4,2.5`} fill="none" className="stroke-wait" strokeWidth={2} strokeLinecap="round" /></g>;
  if (kind === "fail") return <g><circle cx={cx} cy={cy} r={9} className="fill-destructive" /><path d={`M${cx - 3.5},${cy - 3.5} l7,7 M${cx + 3.5},${cy - 3.5} l-7,7`} className="stroke-background" strokeWidth={2} strokeLinecap="round" /></g>;
  if (kind === "blocked") return <g><circle cx={cx} cy={cy} r={9} className="fill-wait" /><path d={`M${cx},${cy - 4.5} V${cy + 1}`} className="stroke-background" strokeWidth={2.2} strokeLinecap="round" /><circle cx={cx} cy={cy + 4.6} r={1.2} className="fill-background" /></g>;
  if (kind === "skipped") return <g><circle cx={cx} cy={cy} r={9} fill="none" className="stroke-muted-foreground" strokeWidth={1.8} /><path d={`M${cx - 4},${cy - 3.5} l4,3.5 l-4,3.5 M${cx + 1},${cy - 3.5} l4,3.5 l-4,3.5`} fill="none" className="stroke-muted-foreground" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></g>;
  return <circle cx={cx} cy={cy} r={8} fill="none" className="stroke-border" strokeWidth={2} />;
}

const boxClass = (st: NodeState, n: GNode) =>
  cn("fill-card stroke-border", st === "done" && "stroke-ok/60", st === "run" && "fill-run/10 stroke-run", st === "fail" && "fill-destructive/10 stroke-destructive", (st === "wait" || st === "blocked") && "stroke-wait [stroke-dasharray:5_3]",
    st === "skipped" && "stroke-muted-foreground/50 [stroke-dasharray:2_3]", n.disabled && "opacity-50 [stroke-dasharray:3_3]", n.end && "fill-muted/40", n.side && st === "idle" && !n.disabled && "[stroke-dasharray:4_3]");

/** Once a step has run, its line shows how long it took; before that, what it is. Never both, so they cannot overlap. */
function subtitle(n: GNode, s: NodeState, d: number | undefined, retries: number) {
  if (d) return `${s === "run" ? "running · " : ""}${fmt(d)}${retries ? ` · ↻${retries}` : ""}`;
  if (s === "run") return "running now";
  if (s === "wait") return "waiting";
  if (s === "blocked") return "needs you";
  if (s === "skipped") return "skipped";
  if (n.disabled) return "disabled";
  return n.sub;
}
const fmt = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`; };
const clipText = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/**
 * Draws a workflow graph (see lib/graph.ts). Without `flow` it is the plain definition: success routes solid, failure routes dashed in
 * the fix colour. With `flow` the nodes and routes show what one job really did.
 */
export function FlowChart({ graph, flow, selected, onSelect, label = "Workflow flow chart" }: { graph: Graph; flow?: Flow | undefined; selected?: string | null; onSelect?: ((id: string) => void) | undefined; label?: string }) {
  const uid = useId().replace(/:/g, "");
  const mk = (n: string) => `${uid}-${n}`;
  const st = (id: string): NodeState => (flow ? nodeState(flow, id) : "idle");
  return (
    <div className="overflow-x-auto pb-1">
      <svg viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-label={label} className="mx-auto block h-auto w-full min-w-[640px]" style={{ maxWidth: graph.width }}>
        <defs>
          {([["off", "fill-border"], ["ok", "fill-ok"], ["run", "fill-run"], ["loop", "fill-loop"], ["plan", "fill-muted-foreground"]] as const).map(([id, c]) => (
            <marker key={id} id={mk(id)} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className={c} /></marker>
          ))}
        </defs>
        {graph.bands.map((b) => (
          <g key={b.title}><text x={28} y={b.y} className="fill-muted-foreground text-[11px] font-semibold uppercase tracking-widest">{b.title}</text><text x={28 + b.title.length * 8.2 + 16} y={b.y} className="fill-muted-foreground text-[11px]">{b.sub}</text></g>
        ))}
        {graph.edges.map((e) => {
          const taken = flow?.taken.has(e.id) ?? false, a = st(e.from), b = st(e.to);
          let cls = "stroke-border", marker = "off", extra = "", sw = 2;
          if (!flow) { if (e.kind === "loop") { cls = "stroke-loop/70"; marker = "loop"; extra = "[stroke-dasharray:5_4]"; } else { cls = "stroke-muted-foreground/60"; marker = "plan"; } }
          else if (e.kind === "flow") {
            if (taken && b === "run") { cls = "stroke-run"; marker = "run"; extra = "anim [stroke-dasharray:6_5] animate-[flow_1s_linear_infinite]"; }
            else if (taken || (a === "done" && ["done", "wait", "fail", "blocked"].includes(b))) { cls = "stroke-ok"; marker = "ok"; }
          } else if (taken) { cls = "stroke-loop"; marker = "loop"; sw = 2.4; } else extra = "[stroke-dasharray:5_4]";
          return <path key={e.id} d={e.d} fill="none" strokeWidth={sw} className={cn(cls, extra)} markerEnd={`url(#${mk(marker)})`} />;
        })}
        {graph.edges.filter((e) => e.label && (e.kind === "loop" || !flow || e.label.includes("then") || e.label.includes("else"))).map((e) => {
          const used = flow?.taken.has(e.id) ?? !flow;
          return <text key={`l-${e.id}`} x={e.lx} y={e.ly} textAnchor={e.anchor} opacity={used ? 1 : 0.55} className={cn("text-[11px] font-medium [paint-order:stroke] stroke-background [stroke-width:5px] [stroke-linejoin:round]", used && e.kind === "loop" ? "fill-loop" : "fill-muted-foreground")}>{e.label}</text>;
        })}
        {graph.nodes.map((n) => {
          const s = st(n.id), nf = flow?.nodes[n.id], att = nf?.attempts ?? 0, d = nf?.durationMs || undefined, used = n.side && s === "done";
          return (
            <g key={n.id} tabIndex={onSelect ? 0 : -1} role={onSelect ? "button" : "img"} aria-label={`${n.label}: ${s}`} aria-pressed={onSelect ? selected === n.id : undefined} className={cn("outline-none [&:focus-visible_.sel]:opacity-100", onSelect && "cursor-pointer")} onClick={() => onSelect?.(n.id)}
              onKeyDown={(ev) => { if (onSelect && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onSelect(n.id); } }}>
              <rect x={n.x} y={n.y} width={W} height={H} rx={n.end ? 26 : 9} strokeWidth={s === "run" || s === "fail" || s === "wait" || s === "blocked" || used ? 2 : 1.5} className={cn(boxClass(s, n), used && "fill-loop/10 stroke-loop [stroke-dasharray:none]")} />
              {s === "run" && <rect x={n.x} y={n.y} width={W} height={H} rx={9} fill="none" strokeWidth={2} className="anim stroke-run opacity-50 animate-[pulse-ring_1.6s_ease-out_infinite]" style={{ transformBox: "fill-box", transformOrigin: "center" }} />}
              <rect x={n.x - 4} y={n.y - 4} width={W + 8} height={H + 8} rx={12} fill="none" strokeWidth={1.5} className={cn("sel stroke-foreground [stroke-dasharray:3_3]", selected === n.id ? "opacity-100" : "opacity-0")} />
              <text x={n.x + 12} y={n.y + 22} className={cn("text-[13px] font-semibold", s === "idle" || s === "skipped" ? "fill-muted-foreground" : "fill-foreground")} {...(n.label.length > 16 ? { textLength: W - 40, lengthAdjust: "spacingAndGlyphs" as const } : {})}>{clipText(n.label, 28)}</text>
              <text x={n.x + 12} y={n.y + 40} className={cn("text-[11px]", s === "run" || s === "wait" ? "fill-run" : "fill-muted-foreground", d ? "font-mono" : "")}>{clipText(subtitle(n, s, d, nf?.retries ?? 0), 24)}</text>
              {flow ? <><circle cx={n.x + W - 3} cy={n.y + H - 1} r={11} className="fill-background" /><Icon kind={s} cx={n.x + W - 3} cy={n.y + H - 1} /></> : null}
              {att > 1 || (n.side && att >= 1) ? (
                <g><rect x={n.x + W - 34} y={n.y - 15} width={30} height={18} rx={9} className="fill-card stroke-loop" strokeWidth={1.5} /><text x={n.x + W - 19} y={n.y - 2} textAnchor="middle" className="fill-loop text-[11px] font-semibold">×{att}</text></g>
              ) : null}
              {!flow && n.stage?.runIf ? <g><rect x={n.x + 4} y={n.y - 15} width={34} height={18} rx={9} className="fill-card stroke-muted-foreground" strokeWidth={1} /><text x={n.x + 21} y={n.y - 2} textAnchor="middle" className="fill-muted-foreground text-[10px] font-semibold">if</text></g> : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function FlowLegend({ plan = false }: { plan?: boolean }) {
  const item = (cls: string, label: string) => <span className="inline-flex items-center gap-2"><svg width="34" height="10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" strokeWidth="2.4" className={cls} /></svg>{label}</span>;
  return (
    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {plan ? <>{item("stroke-muted-foreground/60", "success route")}{item("stroke-loop/70 [stroke-dasharray:5_4]", "failure route (sends the job to another step)")}</> : <>{item("stroke-ok", "route taken")}{item("stroke-run [stroke-dasharray:6_5]", "running now")}{item("stroke-loop", "sent back for fixes")}{item("stroke-border [stroke-dasharray:5_4]", "possible route, not used")}</>}
    </div>
  );
}
