import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { Markdown } from "./Markdown";

const md = (text: string) => render(<Markdown text={text} />).container;

describe("Markdown (Claude's chat replies)", () => {
  it("renders the reply from the job chat: bold headings, code, bullet and numbered lists", () => {
    const c = md([
      "I can't say for sure. My search of `KPS-19/` was denied.",
      "",
      "**What the evidence shows**",
      "- Attempt 3 is still running. It has written the Worker (`config/workers/seo-redirect/...`) and its tests.",
      "- It read `config/_infra.hcl` and `.github/workflows/deploy-config.yml`.",
      "",
      "**What to do**",
      "1. When attempt 3 finishes, look at the diff.",
      "2. Use a `count = var.enable_cloudflare ? 1 : 0` variable that defaults to false.",
      "3. The Worker's vitest tests should pass without an account.",
    ].join("\n"));
    expect(c.textContent).not.toMatch(/\*\*|`/); // no raw markers left
    expect([...c.querySelectorAll("strong")].map((s) => s.textContent)).toEqual(["What the evidence shows", "What to do"]);
    expect([...c.querySelectorAll("code")].map((s) => s.textContent)).toEqual(["KPS-19/", "config/workers/seo-redirect/...", "config/_infra.hcl", ".github/workflows/deploy-config.yml", "count = var.enable_cloudflare ? 1 : 0"]);
    expect(c.querySelectorAll("ul > li")).toHaveLength(2);
    expect(c.querySelectorAll("ol > li")).toHaveLength(3);
    expect(c.querySelector("em")).toBeNull(); // underscores in identifiers are not emphasis
  });

  it("never renders HTML from the text, and only links http(s) and mailto", () => {
    const c = md('<img src=x onerror="alert(1)"> **<script>alert(2)</script>**\n[click](javascript:alert(3)) [ok](https://example.com) [mail](mailto:a@b.c)\nsee https://github.com/o/r/pull/4.');
    expect(c.querySelectorAll("img, script")).toHaveLength(0);
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(c.textContent).toContain("<script>alert(2)</script>");
    expect([...c.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://example.com", "mailto:a@b.c", "https://github.com/o/r/pull/4"]); // the trailing full stop is not part of the URL
    expect(screen.getByText("click").closest("a")).toBeNull();
    for (const a of c.querySelectorAll("a")) { expect(a).toHaveAttribute("rel", "noopener noreferrer"); expect(a).toHaveAttribute("target", "_blank"); }
  });

  it("handles headings, italics, strikethrough, quotes, rules, fenced code and nested lists", () => {
    const c = md("## Plan\n\nThis is *important* and _also this_, not ~~that~~.\n\n> quoted **bit**\n\n---\n\n```ts\nconst a = **not bold**;\n<b>x</b>\n```\n\n- one\n  - one.a\n  - one.b\n- two\n  continued");
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect([...c.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["important", "also this"]);
    expect(c.querySelector("s")?.textContent).toBe("that");
    expect(c.querySelector("blockquote strong")?.textContent).toBe("bit");
    expect(c.querySelector("hr")).not.toBeNull();
    const pre = c.querySelector("pre")!;
    expect(pre.textContent).toBe("const a = **not bold**;\n<b>x</b>"); // code is shown exactly, never parsed
    expect(pre).toHaveAttribute("data-lang", "ts");
    const outer = c.querySelector("ul")!;
    expect(outer.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(within(outer.querySelector(":scope > li")!).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["one.a", "one.b"]);
    expect(outer.querySelectorAll(":scope > li")[1]!.textContent).toBe("twocontinued");
  });

  it("keeps a numbered list's starting number and renders tables", () => {
    const c = md("3. third\n4. fourth\n\n| File | Change |\n|---|:--|\n| `a.ts` | **new** |\n| b.ts | removed |");
    expect(c.querySelector("ol")).toHaveAttribute("start", "3");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["File", "Change"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(table.querySelector("td code")?.textContent).toBe("a.ts");
  });

  it("keeps single line breaks inside a paragraph", () => {
    const c = md("line one\nline two");
    expect(c.querySelectorAll("p")).toHaveLength(1);
    expect(c.querySelectorAll("br")).toHaveLength(1);
  });
});
