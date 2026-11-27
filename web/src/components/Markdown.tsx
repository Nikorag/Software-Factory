import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A small Markdown renderer for Claude's replies. Everything becomes React elements, so the text is always escaped: no HTML string is
 * ever built or injected, and raw HTML in the source stays visible as text. Links are only made for http(s) and mailto URLs.
 * Covers what replies actually use: paragraphs, headings, **bold**, *italic*, ~~strike~~, `code`, fenced code, lists (one level of
 * nesting), quotes, rules, tables and links.
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

// Leftmost match wins, so a code span hides the markers inside it. Underscore emphasis needs non-word characters around it, so
// identifiers like enable_cloudflare stay as they are.
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<![\w\\])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0, n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}.${n++}`;
    const [, , code, label, href, b1, b2, strike, i1, i2, bare] = m;
    if (code !== undefined) out.push(<code key={k} className="border border-[var(--border)] bg-muted px-1 py-px font-mono text-[0.92em]">{code.replace(/^ (.+) $/, "$1")}</code>);
    else if (label !== undefined) out.push(SAFE_URL.test(href!) ? <a key={k} href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">{inline(label, k)}</a> : <span key={k}>{inline(label, k)}</span>);
    else if (b1 !== undefined || b2 !== undefined) out.push(<strong key={k} className="font-semibold text-foreground">{inline((b1 ?? b2)!, k)}</strong>);
    else if (strike !== undefined) out.push(<s key={k}>{inline(strike, k)}</s>);
    else if (i1 !== undefined || i2 !== undefined) out.push(<em key={k}>{inline((i1 ?? i2)!, k)}</em>);
    else if (bare !== undefined) out.push(<a key={k} href={bare} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 wrap-anywhere hover:text-foreground">{bare}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Lines of a paragraph keep their line breaks (chat replies use single newlines on purpose). */
const lines = (ls: string[], key: string): ReactNode[] => ls.flatMap((l, i) => (i ? [<br key={`${key}.br${i}`} />, ...inline(l, `${key}.${i}`)] : inline(l, `${key}.${i}`)));

const BULLET = /^(\s*)[-*+]\s+(.*)$/, NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/, FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/, RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

interface Item { text: string[]; sub?: { ordered: boolean; start: number; items: string[][] } }

function list(src: string[], i: number, key: string): { node: ReactNode; next: number } {
  const ordered = NUMBER.test(src[i]!), re = ordered ? NUMBER : BULLET;
  const indent = (re.exec(src[i]!)![1] ?? "").length;
  const start = ordered ? Number(NUMBER.exec(src[i]!)![2]) : 1;
  const items: Item[] = [];
  while (i < src.length) {
    const line = src[i]!;
    const own = re.exec(line);
    if (own && own[1]!.length <= indent + 1) { items.push({ text: [ordered ? own[3]! : own[2]!] }); i++; continue; }
    const nested = BULLET.exec(line) ?? NUMBER.exec(line);
    if (nested && nested[1]!.length > indent + 1 && items.length) {
      const subOrdered = NUMBER.test(line), cur = items.at(-1)!;
      cur.sub ??= { ordered: subOrdered, start: subOrdered ? Number(NUMBER.exec(line)![2]) : 1, items: [] };
      cur.sub.items.push([subOrdered ? NUMBER.exec(line)![3]! : BULLET.exec(line)![2]!]);
      i++; continue;
    }
    // A continuation line (indented, not a new block) belongs to the last item.
    if (items.length && line.trim() && /^\s{2,}\S/.test(line) && !FENCE.test(line)) { const cur = items.at(-1)!; (cur.sub ? cur.sub.items.at(-1)! : cur.text).push(line.trim()); i++; continue; }
    break;
  }
  const L = ordered ? "ol" : "ul";
  const cls = cn("grid gap-1 pl-5", ordered ? "list-decimal" : "list-disc");
  const node = (
    <L key={key} className={cls} start={ordered && start !== 1 ? start : undefined}>
      {items.map((it, k) => (
        <li key={k} className="pl-1 marker:text-muted-foreground">
          {lines(it.text, `${key}.${k}`)}
          {it.sub ? (() => { const S = it.sub.ordered ? "ol" : "ul"; return <S className={cn("mt-1 grid gap-1 pl-5", it.sub.ordered ? "list-decimal" : "list-disc")} start={it.sub.ordered && it.sub.start !== 1 ? it.sub.start : undefined}>{it.sub.items.map((s, q) => <li key={q} className="pl-1 marker:text-muted-foreground">{lines(s, `${key}.${k}.${q}`)}</li>)}</S>; })() : null}
        </li>
      ))}
    </L>
  );
  return { node, next: i };
}

export function blocks(md: string): ReactNode[] {
  const src = md.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push(<p key={`p${out.length}`}>{lines(para, `p${out.length}`)}</p>); para = []; } };
  for (let i = 0; i < src.length;) {
    const line = src[i]!, key = `b${out.length}`;
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < src.length && !src[i]!.trim().startsWith(fence[1]!)) body.push(src[i++]!);
      i++; // the closing fence (or the end)
      out.push(<pre key={key} className="overflow-x-auto border border-[var(--border)] bg-[#0a0a0a] p-3 font-mono text-[12px] leading-relaxed" {...(fence[2] ? { "data-lang": fence[2] } : {})}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = HEADING.exec(line);
    if (h) { flush(); const level = h[1]!.length; out.push(<p key={key} role="heading" aria-level={Math.min(6, level + 2)} className={cn("font-semibold text-foreground", level <= 2 ? "text-[1.08em]" : "")}>{inline(h[2]!, key)}</p>); i++; continue; }
    if (RULE.test(line)) { flush(); out.push(<hr key={key} className="border-[var(--border)]" />); i++; continue; }
    if (BULLET.test(line) || NUMBER.test(line)) { flush(); const l = list(src, i, key); out.push(l.node); i = l.next; continue; }
    const q = QUOTE.exec(line);
    if (q) {
      flush();
      const body: string[] = [];
      while (i < src.length && QUOTE.test(src[i]!)) body.push(QUOTE.exec(src[i++]!)![1]!);
      out.push(<blockquote key={key} className="grid gap-2 border-l-2 border-[var(--border)] pl-3 text-muted-foreground">{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < src.length && TABLE_SEP.test(src[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < src.length && src[i]!.includes("|") && src[i]!.trim()) rows.push(cells(src[i++]!));
      out.push(
        <div key={key} className="overflow-x-auto" data-scroll-x>
          <table className="w-full border-collapse text-left text-[0.95em]">
            <thead><tr>{head.map((c, k) => <th key={k} className="border-b border-[var(--border)] px-2 py-1.5 font-semibold text-foreground">{inline(c, `${key}.h${k}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, k) => <tr key={k}>{head.map((_, c) => <td key={c} className="border-b border-[var(--border)] px-2 py-1.5 align-top">{inline(r[c] ?? "", `${key}.${k}.${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn("grid gap-2.5 wrap-anywhere leading-relaxed", className)}>{blocks(text)}</div>;
}
