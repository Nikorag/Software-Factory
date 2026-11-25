/**
 * Jira's API v3 reads and writes rich text as Atlassian Document Format (ADF), a JSON tree. The factory works in plain text / Markdown, so
 * these two functions convert at the edge. They cover what tickets and the factory's own comments actually contain (paragraphs, lists,
 * code, links, bold); anything exotic is flattened to its text rather than dropped.
 */
type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[]; content?: Node[] };

export function adfToText(doc: unknown): string {
  if (!doc) return "";
  if (typeof doc === "string") return doc; // API v2-style plain text
  const inline = (n: Node): string => {
    if (n.type === "text") {
      let t = n.text ?? "";
      for (const m of n.marks ?? []) { if (m.type === "code") t = `\`${t}\``; else if (m.type === "strong") t = `**${t}**`; else if (m.type === "em") t = `_${t}_`; else if (m.type === "link" && typeof m.attrs?.href === "string") t = `[${t}](${m.attrs.href})`; }
      return t;
    }
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") return String(n.attrs?.text ?? "@someone");
    if (n.type === "emoji") return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
    if (n.type === "inlineCard") return String(n.attrs?.url ?? "");
    return (n.content ?? []).map(inline).join("");
  };
  const block = (n: Node, indent = ""): string => {
    const kids = n.content ?? [];
    switch (n.type) {
      case "paragraph": return `${indent}${kids.map(inline).join("")}`;
      case "heading": return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${kids.map(inline).join("")}`;
      case "codeBlock": return `\`\`\`\n${kids.map(inline).join("")}\n\`\`\``;
      case "blockquote": return kids.map((k) => block(k)).join("\n").split("\n").map((l) => `> ${l}`).join("\n");
      case "rule": return "---";
      case "bulletList": return kids.map((li) => `${indent}- ${(li.content ?? []).map((c) => block(c, "")).join("\n").replace(/\n/g, `\n${indent}  `)}`).join("\n");
      case "orderedList": return kids.map((li, i) => `${indent}${i + 1}. ${(li.content ?? []).map((c) => block(c, "")).join("\n").replace(/\n/g, `\n${indent}   `)}`).join("\n");
      case "table": return kids.map((row) => (row.content ?? []).map((c) => (c.content ?? []).map((x) => block(x)).join(" ")).join(" | ")).join("\n");
      default: return kids.length ? kids.map((k) => (k.type === "text" ? inline(k) : block(k, indent))).join(k0(n)) : inline(n);
    }
  };
  const k0 = (n: Node) => (n.type === "doc" ? "\n\n" : "");
  return block(doc as Node).trim();
}

const text = (t: string, marks?: Node["marks"]): Node => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

/** `**bold**`, `` `code` ``, `[text](url)` and bare https URLs become ADF marks; newlines become hard breaks. */
function inlineNodes(line: string): Node[] {
  const out: Node[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push(text(line.slice(last, m.index)));
    if (m[1] !== undefined) out.push(text(m[1], [{ type: "strong" }]));
    else if (m[2] !== undefined) out.push(text(m[2], [{ type: "code" }]));
    else if (m[3] !== undefined) out.push(text(m[3], [{ type: "link", attrs: { href: m[4] } }]));
    else out.push(text(m[5]!, [{ type: "link", attrs: { href: m[5] } }]));
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(text(line.slice(last)));
  return out;
}

export function markdownToAdf(md: string): { version: 1; type: "doc"; content: Node[] } {
  const content: Node[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith("```")) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      content.push({ type: "codeBlock", content: code.length ? [text(code.join("\n"))] : [] });
      continue;
    }
    if (/^[-*] /.test(line)) {
      const items: Node[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i]!)) items.push({ type: "listItem", content: [{ type: "paragraph", content: inlineNodes(lines[i++]!.slice(2)) }] });
      content.push({ type: "bulletList", content: items });
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) { content.push({ type: "heading", attrs: { level: heading[1]!.length }, content: inlineNodes(heading[2]!) }); i++; continue; }
    const para: Node[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith("```") && !/^[-*] /.test(lines[i]!) && !/^#{1,6} /.test(lines[i]!)) {
      if (para.length) para.push({ type: "hardBreak" });
      para.push(...inlineNodes(lines[i++]!));
    }
    content.push({ type: "paragraph", content: para });
  }
  return { version: 1, type: "doc", content: content.length ? content : [{ type: "paragraph", content: [] }] };
}
