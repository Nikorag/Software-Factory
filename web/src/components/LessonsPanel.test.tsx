import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LessonsPanel, sourceLabel } from "@/components/LessonsPanel";
import { lessonIdsOf, RunLessons } from "@/components/job/RunLessons";
import type { Lesson } from "@/lib/types";

const lesson = (o: Partial<Lesson>): Lesson => ({ id: 1, projectId: "p", text: "Use tabs", kind: "convention", status: "proposed", source: "human", sourceJobId: null, hits: 0, createdAt: 1000, lastUsedAt: null, ...o });
const XSS = `<img src=x onerror="window.__pwned=1">`;

let store: Lesson[];
let calls: { url: string; method: string; body?: string }[];
beforeEach(() => {
  calls = [];
  store = [lesson({ id: 1, text: "Run pnpm test:unit", kind: "command", status: "proposed", source: "stage_execution:4" }), lesson({ id: 2, text: "Use tabs", status: "active", hits: 3, lastUsedAt: Date.now() }), lesson({ id: 3, text: XSS, status: "retired" })];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string });
    if (method === "GET") return new Response(JSON.stringify({ lessons: store }), { status: 200 });
    const m = /\/api\/lessons\/(\d+)\/(approve|reject|retire)$/.exec(url);
    if (m) {
      const l = store.find((x) => x.id === Number(m[1]))!;
      l.status = m[2] === "approve" ? "active" : "retired";
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("LessonsPanel", () => {
  it("lists lessons with their status, kind and source, and filters by status", async () => {
    render(<LessonsPanel projectId="p" />);
    expect(await screen.findByText("Run pnpm test:unit")).toBeInTheDocument();
    expect(screen.getByText("learned from a job's fix cycle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /all \(3\)/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /active \(1\)/ }));
    expect(screen.queryByText("Run pnpm test:unit")).not.toBeInTheDocument();
    expect(screen.getByText("Use tabs")).toBeInTheDocument();
    expect(screen.getByText(/used 3×/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /proposed \(1\)/ }));
    expect(screen.getByText("Run pnpm test:unit")).toBeInTheDocument();
  });
  it("offers Approve/Edit/Reject on proposed lessons, Edit/Retire on active ones and nothing on retired ones", async () => {
    render(<LessonsPanel projectId="p" />);
    const names = (id: number) => within(screen.getByRole("article", { name: `Lesson ${id}` })).queryAllByRole("button").map((b) => b.textContent);
    await screen.findByText("Run pnpm test:unit");
    expect(names(1)).toEqual(["Approve", "Edit", "Reject"]);
    expect(names(2)).toEqual(["Edit", "Retire"]);
    expect(names(3)).toEqual([]);
  });
  it("approves a proposed lesson through the API and shows it as active", async () => {
    render(<LessonsPanel projectId="p" />);
    await userEvent.click(within(await screen.findByRole("article", { name: "Lesson 1" })).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/lessons/1/approve"))).toBe(true));
    expect(await screen.findByText(/Lesson approved/)).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("article", { name: "Lesson 1" })).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument());
  });
  it("edits text and kind", async () => {
    render(<LessonsPanel projectId="p" />);
    await userEvent.click(within(await screen.findByRole("article", { name: "Lesson 2" })).getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: "Lesson text" });
    await userEvent.clear(box);
    await userEvent.type(box, "Use two spaces");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Lesson kind" }), "pitfall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({ url: "/api/lessons/2", body: JSON.stringify({ text: "Use two spaces", kind: "pitfall" }) }));
  });
  it("retires and rejects", async () => {
    render(<LessonsPanel projectId="p" />);
    await userEvent.click(within(await screen.findByRole("article", { name: "Lesson 2" })).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/lessons/2/retire"))).toBe(true));
    await userEvent.click(within(screen.getByRole("article", { name: "Lesson 1" })).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/api/lessons/1/reject"))).toBe(true));
  });
  it("adds a lesson (as a proposal) and shows the server's refusal", async () => {
    render(<LessonsPanel projectId="p" />);
    await userEvent.type(await screen.findByLabelText("Add a lesson"), "Always run lint");
    await userEvent.click(screen.getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/projects/p/lessons", body: JSON.stringify({ text: "Always run lint", kind: "convention" }) }));
    expect(await screen.findByText(/added as proposed/)).toBeInTheDocument();
  });
  it("renders lesson text as text, never as markup", async () => {
    const { container } = render(<LessonsPanel projectId="p" />);
    expect(await screen.findByText(XSS)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
  it("describes sources in words", () => {
    expect(sourceLabel({ source: "human", sourceJobId: null })).toBe("added by a person");
    expect(sourceLabel({ source: "decision:9", sourceJobId: "j" })).toBe("from a human answer");
  });
});

describe("RunLessons (job page)", () => {
  const known = [{ id: 3, kind: "convention" as const, text: "Use tabs", status: "active" as const }];
  it("reads the injected ids from a run's usage and names the ones it knows", () => {
    expect(lessonIdsOf({ usage: { lessons: [3, 9] } })).toEqual([3, 9]);
    expect(lessonIdsOf({ usage: null })).toEqual([]);
    expect(lessonIdsOf({ usage: { denials: 1 } })).toEqual([]);
    render(<RunLessons run={{ usage: { lessons: [3, 9] } }} known={known} />);
    expect(screen.getByText("#3 convention")).toHaveAttribute("title", "convention: Use tabs");
    expect(screen.getByText("#9")).toHaveAttribute("title", "lesson no longer available");
  });
  it("says none when a run saw no lessons", () => {
    render(<RunLessons run={{ usage: { lessons: [] } }} known={[]} />);
    expect(screen.getByText("none")).toBeInTheDocument();
  });
});
