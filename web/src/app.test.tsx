import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { loadToken } from "@/lib/api";
import { deriveFlow } from "@/lib/pipeline";
import { JobDetail } from "@/pages/JobDetail";
import { Overview } from "@/pages/Overview";
import type { Execution, Job, JobDetail as D, Overview as O } from "@/lib/types";

const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
const job = (o: Partial<Job> = {}): Job => ({ id: "j1", key: "JAM-1", project: "p", workflow: "default", stage: "CLAUDE_REVIEW", status: "running", heldFromStage: null, remediationAttempts: 0, stageAttempts: 0, autonomous: false, dryRun: false, prUrl: null, lastError: null, notBefore: null, createdAt: 1000, updatedAt: 2000, ...o });
const exec = (stage: string, outcome = "succeeded", id = 1): Execution => ({ id, stage, attempt: 1, outcome, error: null, output: null, startedAt: 1000 + id * 1000, finishedAt: 1500 + id * 1000 });
const overview = (o: Partial<O> = {}): O => ({
  control: { paused: false, emergencyStop: false }, counts: { byStatus: { running: 1 }, outbox: { pending: 0, failed: 0 }, recentAgentFailures: { rateLimited: 0 } },
  active: [job()], queued: [], recent: [], scheduler: null, mergeMode: "pr-only", dryRun: false, health: [{ name: "sandbox", status: "ok", detail: "ready", checkedAt: 1 }],
  system: { memory: { availableBytes: 8 * 2 ** 30, totalBytes: 16 * 2 ** 30, freePercent: 50, pressure: "ok" }, disk: { freeBytes: 2 ** 40, totalBytes: 2 ** 41 }, load: [1, 1, 1] }, ...o,
});
const detail = (j: Job, executions: Execution[] = [], extra: Partial<D> = {}): D => ({ job: j, stageOrder: [], executions, decisions: [], invocations: [], artifacts: [], worktree: null, outbox: [], ...extra });

let routes: Record<string, unknown>;
let calls: { url: string; method: string; headers?: Record<string, string>; body?: string }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body as string });
    const body = routes[url];
    return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200, headers: { "content-type": "application/json" } });
  }));
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const app = (path: string) => render(
  <MemoryRouter initialEntries={[path]}><Routes><Route element={<Shell />}><Route index element={<Overview />} /><Route path="jobs/:id" element={<JobDetail />} /></Route></Routes></MemoryRouter>,
);

describe("flow derivation (from the stage history the factory already stores)", () => {
  it("marks finished steps, the running step, and counts a fix route only when a fix stage actually ran", () => {
    const f = deriveFlow(job({ stage: "CLAUDE_REVIEW" }), [exec("AUTOMATED_TESTING", "succeeded", 1), exec("LOCAL_MODEL_REVIEW", "succeeded", 2), exec("REMEDIATION", "succeeded", 3), exec("AUTOMATED_TESTING", "succeeded", 4)], []);
    expect(f.state["test"]).toBe("done"); expect(f.state["crev"]).toBe("run");
    expect(f.attempts["test"]).toBe(2);
    expect(f.loopsUsed.has("hrev>fix")).toBe(true); expect(f.loopsUsed.has("fix>test")).toBe(true);
    expect(f.loopsUsed.has("ci>fix")).toBe(false);
  });
  it("marks the step a held job stopped at, not the held state", () => {
    const f = deriveFlow(job({ stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "FINAL_VALIDATION", remediationAttempts: 3 }), [exec("FINAL_VALIDATION", "failed")], []);
    expect(f.state["fval"]).toBe("fail"); expect(f.active).toBe("fval");
  });
  it("a spec review that sends work to Fix spec skips the direct route to validation", () => {
    const f = deriveFlow(job({ stage: "SPECIFICATION_VALIDATION" }), [exec("SPECIFICATION_REVIEW", "succeeded", 1), exec("SPECIFICATION_REMEDIATION", "succeeded", 2)], []);
    expect(f.loopsUsed.has("srev>sfix")).toBe(true); expect(f.skipped.has("srev>sval")).toBe(true);
  });
});

describe("dashboard", () => {
  it("renders the overview: state, mode, counts, system and dependency health", async () => {
    routes = { "/api/overview": overview() };
    app("/");
    expect(await screen.findByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText(/PR-only: never merges/)).toBeInTheDocument();
    expect(await screen.findByText("memory free")).toBeInTheDocument();
    expect(screen.getByText("Dashboard only: the scheduler is not running.")).toBeInTheDocument();
    expect(screen.getByText("JAM-1")).toBeInTheDocument(); expect(screen.getByText("sandbox")).toBeInTheDocument();
  });
  it("shows the emergency state loudly and swaps the controls", async () => {
    routes = { "/api/overview": overview({ control: { paused: false, emergencyStop: true, reason: "disk full" } }) };
    app("/");
    expect(await screen.findByText("EMERGENCY STOP")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
    expect(screen.queryByRole("button", { name: /Emergency stop/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Clear stop/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
  });
  it("renders hostile ticket/agent-derived text as inert text: no elements, no script, no javascript: links", async () => {
    const j = job({ lastError: `${XSS} boom`, prUrl: "javascript:window.__pwned=1", stage: "BLOCKED", status: "waiting", heldFromStage: "IMPLEMENTATION" });
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j, [{ ...exec("DISCOVERED", "failed"), error: XSS }], { decisions: [{ id: 1, kind: XSS, decision: XSS, rationale: XSS, actor: XSS, at: 1 }], invocations: [{ id: 1, agent: XSS, model: XSS, exitCode: 0, durationMs: 1, usage: null, hasLog: false, at: 1 }] }) };
    const { container } = app("/jobs/j1");
    await screen.findAllByText(/<img src=x onerror=/);
    expect(container.querySelectorAll("img, script, iframe, object, embed").length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect([...container.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name)))).toBe(false);
  });
  it("links a real GitHub PR safely, draws the flow with the held step marked, and offers Retry and Answer", async () => {
    const j = job({ prUrl: "https://github.com/Nikorag/Zonto-Kart/pull/35", stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "CLAUDE_REVIEW" });
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j, [exec("DISCOVERED")]) };
    app("/jobs/j1");
    const a = await screen.findByRole("link", { name: /pull request/ });
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener")); expect(a).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("img", { name: "Pipeline flow chart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude review: fail" })).toBeInTheDocument(); // marked where it stopped
    expect(screen.getByRole("button", { name: "Discovered: done" })).toBeInTheDocument();
    expect(screen.getByText(/Retry resumes there/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Answer & resume/ })).toBeDisabled(); // nothing typed yet
  });
  it("clicking a step shows what it does and filters the stage history to it", async () => {
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job(), [exec("AUTOMATED_TESTING", "succeeded", 1), exec("LOCAL_MODEL_REVIEW", "succeeded", 2)]) };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("button", { name: /Run checks: done/ }));
    expect(screen.getByText(/runs build, typecheck, lint and tests itself/)).toBeInTheDocument();
    expect(screen.getByText("Filtered to Run checks.")).toBeInTheDocument();
    expect(screen.queryByText("LOCAL_MODEL_REVIEW")).toBeNull();
  });
  it("controls send the bearer token, and a missing token never sends a request", async () => {
    routes = { "/api/overview": overview(), "/api/control/pause": { ok: true } };
    sessionStorage.setItem("factory-token", "k".repeat(64));
    app("/");
    await userEvent.click(await screen.findByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/control/pause" && c.method === "POST" && c.headers?.Authorization === `Bearer ${"k".repeat(64)}`)).toBe(true));
    expect(screen.getByText("controls enabled")).toBeInTheDocument();
    cleanup(); calls = []; sessionStorage.clear();
    app("/");
    await userEvent.click(await screen.findByRole("button", { name: /Pause/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Controls need the control token");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
  });
  it("posts an answer with the token, then asks the API to resume", async () => {
    const j = job({ stage: "BLOCKED", status: "waiting", heldFromStage: "REQUIREMENTS_ANALYSIS" });
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j), "/api/jobs/j1/answer": { ok: true } };
    sessionStorage.setItem("factory-token", "t".repeat(64));
    app("/jobs/j1");
    await userEvent.type(await screen.findByPlaceholderText(/Your answer/), "Use port 7777");
    await userEvent.click(screen.getByRole("button", { name: /Answer & resume/ }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/jobs/j1/answer")?.body).toBe(JSON.stringify({ answer: "Use port 7777" })));
  });
  it("takes the token from the URL fragment and removes it from the address bar", () => {
    window.location.hash = `#token=${"a".repeat(64)}`;
    expect(loadToken()).toBe("a".repeat(64));
    expect(window.location.hash).not.toContain("token");
  });
});
