import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { deriveFlow, edgesFor, nodesFor, stripStates } from "@/lib/pipeline";
import { JobDetail } from "@/pages/JobDetail";
import { Settings } from "@/pages/Settings";
import { Setup } from "@/pages/Setup";
import { Board } from "@/pages/Board";
import { Overview } from "@/pages/Overview";
import { HealthPage } from "@/pages/Health";
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
    const route = routes[url];
    const body = typeof route === "function" ? await (route as () => unknown)() : route; // a function route can hold its response back
    const status = body && typeof body === "object" && "__status" in body ? (body as { __status: number }).__status : body === undefined ? 404 : 200;
    return new Response(JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const app = (path: string) => render(
  <MemoryRouter initialEntries={[path]}><Routes><Route element={<Shell />}><Route index element={<Overview />} /><Route path="jobs/:id" element={<JobDetail />} /><Route path="settings" element={<Settings />} /><Route path="board" element={<Board />} /><Route path="setup" element={<Setup />} /></Route></Routes></MemoryRouter>,
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

describe("flow chart follows the planning mode", () => {
  const haiku = (o = {}) => job({ planningMode: "haiku_prompt", ...o });
  it("haiku_prompt draws no Spec Kit steps at all (not skipped ones), and the prompt step replaces them", () => {
    const ids = nodesFor("haiku_prompt").map((n) => n.id);
    expect(ids.some((i) => ["gen", "srev", "sval", "sfix"].includes(i))).toBe(false);
    expect(nodesFor("haiku_prompt").find((n) => n.id === "req")!.label).toBe("Write prompt");
    expect(edgesFor("haiku_prompt").map((e) => e.id)).toEqual(expect.arrayContaining(["req>prep", "mr>conf", "conf>test"]));
    expect(edgesFor("haiku_prompt").some((e) => e.from === "gen" || e.to === "sval" || e.from === "sfix")).toBe(false);
    expect(nodesFor("speckit").map((n) => n.id)).toEqual(expect.arrayContaining(["gen", "srev", "sval", "sfix", "conf"]));
  });
  it("the per-job strip drops the Spec Kit squares in haiku_prompt, and a Spec Kit job keeps them whatever the profile says now", () => {
    expect(stripStates(haiku({ stage: "IMPLEMENTATION" }))).toHaveLength(14);
    expect(stripStates(job({ stage: "IMPLEMENTATION" }))).toHaveLength(17);
    const f = deriveFlow(haiku({ stage: "IMPLEMENTATION" }), [exec("SPECIFICATION_GENERATION", "succeeded", 1)], []);
    expect(f.mode).toBe("speckit");
    expect(deriveFlow(haiku({ stage: "IMPLEMENTATION" }), [exec("REQUIREMENTS_ANALYSIS", "succeeded", 1)], []).mode).toBe("haiku_prompt");
  });
  it("conflict resolution lights its own route, so a conflict is visible rather than hidden in a retry", () => {
    const f = deriveFlow(haiku({ stage: "MERGING" }), [exec("PULL_REQUEST_CREATION", "succeeded", 1), exec("MERGE_VALIDATION", "succeeded", 2), exec("CONFLICT_RESOLUTION", "succeeded", 3)], []);
    expect(f.state["conf"]).toBe("done"); expect(f.loopsUsed.has("mr>conf")).toBe(true); expect(f.loopsUsed.has("conf>test")).toBe(true);
  });
});

describe("flow derivation: waiting", () => {
  it("does not count re-checks while waiting as attempts or time on the step", () => {
    const waits = Array.from({ length: 12 }, (_, i) => exec("MERGING", "waiting", 100 + i));
    const f = deriveFlow(job({ stage: "MERGING", status: "queued" }), [exec("PULL_REQUEST_CREATION"), ...waits], []);
    expect(f.attempts["hm"]).toBeUndefined();
    expect(f.duration["hm"]).toBeUndefined();
    expect(f.state["hm"]).toBe("wait");
    expect(f.attempts["pr"]).toBe(1);
  });
});

describe("dashboard", () => {
  it("renders the overview: state, mode, counts, system and dependency health", async () => {
    routes = { "/api/overview": overview() };
    app("/");
    expect(await screen.findByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText(/PR-only/)).toBeInTheDocument();
    expect(await screen.findByText("memory free")).toBeInTheDocument();
    expect(screen.getByText("Dashboard only: the scheduler is not running.")).toBeInTheDocument();
    expect(screen.getByText("JAM-1")).toBeInTheDocument(); expect(screen.getByText("sandbox")).toBeInTheDocument();
  });
  it("offers the setup wizard when there are no projects, and not otherwise", async () => {
    routes = { "/api/overview": overview({ projectCount: 0 }) };
    app("/");
    expect(await screen.findByRole("link", { name: "Start setup" })).toHaveAttribute("href", "/setup");
    cleanup();
    routes = { "/api/overview": overview({ projectCount: 2 }) };
    app("/");
    await screen.findByText("RUNNING");
    expect(screen.queryByRole("link", { name: "Start setup" })).toBeNull();
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
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j, [{ ...exec("DISCOVERED", "failed"), error: XSS }], { decisions: [{ id: 1, kind: XSS, decision: XSS, rationale: XSS, actor: XSS, at: 1 }], invocations: [{ id: 1, stageExecutionId: null, agent: XSS, model: XSS, exitCode: 0, durationMs: 1, finished: true, usage: null, hasLog: false, at: 1 }] }) };
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
  it("shows friendly stage names, not the engine's ids, in the held banner, the history and the decisions", async () => {
    const j = job({ stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "LOCAL_MODEL_REVIEW", lastError: "remediation attempts exhausted (3): 2 blocking finding(s) in LOCAL_MODEL_REVIEW" });
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j, [exec("LOCAL_MODEL_REVIEW", "succeeded")], { decisions: [{ id: 1, kind: "hold.NEEDS_ATTENTION", decision: "LOCAL_MODEL_REVIEW -> NEEDS_ATTENTION", rationale: null, actor: "factory", at: 1 }] }) };
    app("/jobs/j1");
    expect(await screen.findByText(/Held at Needs attention \(was Independent review\)/)).toBeInTheDocument();
    expect(screen.queryByText(/LOCAL_MODEL_REVIEW/)).toBeNull();
  });
  it("offers to delete the worktree too when deleting a job that still has one", async () => {
    const j = job({ status: "failed", stage: "FAILED" });
    const wt = { path: "/Users/me/.software-factory/workspaces/zonto-hub/JAM-418", state: "preserved", branch: "factory/JAM-418" };
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j, [exec("DISCOVERED")], { worktree: wt }), "/api/jobs/j1?removeWorktree=1": { ok: true } };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("button", { name: "delete JAM-1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText(wt.path)).toBeInTheDocument();
    const box = within(dialog).getByRole("checkbox");
    expect(box).toBeChecked();
    await userEvent.click(box); // unticked: the job cannot be deleted while the worktree exists, so the button is off
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    await userEvent.click(box);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete job and worktree" }));
    await waitFor(() => expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/api/jobs/j1?removeWorktree=1"));
  });
  it("asks again before discarding uncommitted changes in the worktree", async () => {
    const j = job({ status: "failed", stage: "FAILED" });
    const wt = { path: "/w/JAM-418", state: "active", branch: "factory/JAM-418" };
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j, [exec("DISCOVERED")], { worktree: wt }),
      "/api/jobs/j1?removeWorktree=1": { __status: 409, error: "worktree /w/JAM-418 has uncommitted changes", code: "worktree-dirty" },
      "/api/jobs/j1?removeWorktree=1&discardChanges=1": { ok: true } };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("button", { name: "delete JAM-1" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Delete job and worktree" }));
    expect(await within(dialog).findByText(/uncommitted changes/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1); // nothing is discarded without a second, explicit click
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard changes and delete" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE").at(-1)?.url).toBe("/api/jobs/j1?removeWorktree=1&discardChanges=1"));
  });
  it("clicking a step shows what it does and filters the stage history to it", async () => {
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job(), [exec("AUTOMATED_TESTING", "succeeded", 1), exec("LOCAL_MODEL_REVIEW", "succeeded", 2)]) };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("button", { name: /Run checks: done/ }));
    expect(screen.getByText(/runs build, typecheck, lint and tests itself/)).toBeInTheDocument();
    expect(screen.getByText("Showing Run checks only.")).toBeInTheDocument();
    expect(screen.queryByText("LOCAL_MODEL_REVIEW")).toBeNull();
  });
  it("controls work with no token and no read-only mode, sending the same-origin header", async () => {
    routes = { "/api/overview": overview(), "/api/control/pause": { ok: true } };
    app("/");
    await userEvent.click(await screen.findByRole("button", { name: /Pause/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/control/pause" && c.method === "POST" && c.headers?.["X-Factory-UI"] === "1")).toBe(true));
    expect(calls.some((c) => c.headers?.Authorization)).toBe(false);
    expect(screen.queryByText(/read-only|token/i)).toBeNull();
  });
  it("posts an answer with the token, then asks the API to resume", async () => {
    const j = job({ stage: "BLOCKED", status: "waiting", heldFromStage: "REQUIREMENTS_ANALYSIS" });
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j), "/api/jobs/j1/answer": { ok: true } };
    app("/jobs/j1");
    await userEvent.type(await screen.findByPlaceholderText(/Your answer/), "Use port 7777");
    await userEvent.click(screen.getByRole("button", { name: /Answer & resume/ }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/jobs/j1/answer")?.body).toBe(JSON.stringify({ answer: "Use port 7777" })));
  });
});

const proj = { id: "my-app", name: "My App", enabled: true, autonomy: "supervised", repository: "/x", githubRepo: "me/my-app", defaultBranch: "main", githubAccount: null, managed: true, linear: { teamKey: "ENG", projectName: "My App" }, commands: { test: "npm test" }, validation: null, activeJobs: 0 };
const setupInfo = { tracker: { kind: "linear", name: "Linear", connected: true }, configDir: null, homeConfigDir: "~/.software-factory/config", usingDefaults: true, projectCount: 1, linear: { keyPresent: true, env: "LINEAR_API_KEY", keychainService: "svc" } };

describe("settings and setup", () => {
  it("shows projects in a list on the left and the selected one in a full editor", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj, { ...proj, id: "bare", name: "Bare", githubRepo: "me/bare", commands: {} }] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] } };
    app("/settings");
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    expect(within(nav).getByRole("button", { name: /My App/ })).toHaveAttribute("aria-current", "true"); // first one selected
    expect(within(nav).getByLabelText("no test command")).toBeInTheDocument();                           // the one without tests is flagged in the list
    expect(await screen.findByLabelText(/^test$/i)).toHaveValue("npm test");
    await userEvent.click(within(nav).getByRole("button", { name: /Bare/ }));
    expect(await screen.findByText(/No test command: the factory will not implement/)).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Bare");
  });
  it("adds a project from the list's Add button: sends exactly what was typed, no token", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/projects/new-thing": { ok: true } };
    app("/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Add project" }));
    expect(await screen.findByText("New project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), "New Thing");
    await userEvent.type(screen.getByLabelText("GitHub repo"), "me/new-thing");
    await userEvent.type(screen.getByLabelText(/^test$/i), "npm test");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.url).toBe("/api/settings/projects/new-thing"));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toMatchObject({ name: "New Thing", github: { repo: "me/new-thing" }, commands: { test: "npm test" }, autonomy: "supervised" });
    expect(put.headers).toMatchObject({ "X-Factory-UI": "1" });
    expect(put.headers?.Authorization).toBeUndefined();
  });
  it("shows the server's validation error in the editor and keeps what was typed", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] } }; // PUT -> 404 => error
    app("/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Add project" }));
    await userEvent.type(screen.getByLabelText("Name"), "Dup");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Dup");
  });
  it("asks before discarding unsaved edits when switching project", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj, { ...proj, id: "bare", name: "Bare", githubRepo: "me/bare", commands: {} }] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] } };
    app("/settings");
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    await userEvent.type(await screen.findByLabelText("Name"), " edited");
    await userEvent.click(within(nav).getByRole("button", { name: /Bare/ }));
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Name")).toHaveValue("My App edited");
    await userEvent.click(within(nav).getByRole("button", { name: /Bare/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await screen.findByDisplayValue("Bare")).toBeInTheDocument();
  });
  it("runs a project action from the editor and streams its output", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] },
      "/api/projects/my-app/actions/check": { ok: true, taskId: "t1" }, "/api/tasks/t1": { id: "t1", label: "Run checks: my-app", status: "ok", lines: ["✓ test (3s): npm test"] } };
    app("/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Run checks" }));
    expect(await screen.findByText(/✓ test \(3s\): npm test/)).toBeInTheDocument();
    expect(screen.getByText(/Run checks: my-app: done/)).toBeInTheDocument();
  });
  it("shows an update notice with the command to run, and remembers a dismissal per version", async () => {
    localStorage.clear();
    routes = { "/api/overview": overview(), "/api/update": { current: "v0.1.0", latest: "v0.1.1", available: true, checkedAt: 1 } };
    app("/");
    expect(await screen.findByText(/Update available:/)).toBeInTheDocument();
    expect(screen.getByText("software-factory update")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "dismiss update notice" }));
    expect(screen.queryByText(/Update available:/)).toBeNull();
    cleanup();
    app("/");
    await screen.findByText("RUNNING");
    expect(screen.queryByText(/Update available:/)).toBeNull();           // still dismissed for v0.1.1
    cleanup();
    routes = { ...routes, "/api/update": { current: "v0.1.0", latest: "v0.2.0", available: true, checkedAt: 1 } };
    app("/");
    expect(await screen.findByText(/Update available:/)).toBeInTheDocument(); // a newer release shows again
  });
  it("shows no update notice when up to date", async () => {
    localStorage.clear();
    routes = { "/api/overview": overview(), "/api/update": { current: "v0.1.1", latest: "v0.1.1", available: false, checkedAt: 1 } };
    app("/");
    await screen.findByText("RUNNING");
    expect(screen.queryByText(/Update available:/)).toBeNull();
  });
  it("the wizard only lets you continue from Linear once a key exists, and shows each step's real status", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": { ...setupInfo, projectCount: 0, tracker: { kind: "linear", name: "Linear", connected: false }, linear: { ...setupInfo.linear, keyPresent: false } }, "/api/setup/linear": { teams: [] },
      "/api/health": { system: overview().system, health: [{ name: "claude code", status: "fail", detail: "not logged in", checkedAt: 1 }, { name: "sandbox", status: "ok", detail: "ready", checkedAt: 1 }], scheduler: null } };
    app("/setup");
    expect(await screen.findByText("not logged in")).toBeInTheDocument();
    expect(screen.getByText(/run `claude`, then \/login/i)).toBeInTheDocument(); // the fix is shown next to the failure
    await userEvent.click(screen.getByRole("button", { name: /Continue anyway/ }));
    expect(await screen.findByText("Connect your issue tracker")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled(); // no key yet
  });
  it("opens the editor for the project named in the link", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj, { ...proj, id: "bare", name: "Bare", githubRepo: "me/bare", commands: {} }] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] } };
    app("/settings?project=bare");
    expect(await screen.findByDisplayValue("Bare")).toBeInTheDocument();
  });
  const globalSettings = { maxConcurrentJobs: 1, maxRemediationAttempts: 3, routes: {
    classification: { provider: "anthropic", model: "haiku" }, specification: { provider: "anthropic", model: "default" }, implementation: { provider: "anthropic", model: "default" },
    independent_review: { provider: "anthropic", model: "haiku" }, final_review: { provider: "anthropic", model: "default" } } };
  it("edits the workflow defaults: concurrency, fix-cycle limit and a model per task, saved in one request", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Workflow" }));
    const conc = await screen.findByLabelText("Concurrent jobs");
    expect(conc).toHaveValue(1);
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled(); // nothing changed yet
    await userEvent.clear(conc); await userEvent.type(conc, "3");
    await userEvent.clear(screen.getByLabelText("Fix cycle limit")); await userEvent.type(screen.getByLabelText("Fix cycle limit"), "5");
    const impl = within(screen.getByRole("group", { name: "Implementation model presets" }));
    await userEvent.click(impl.getByRole("button", { name: "opus" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.url).toBe("/api/settings/global"));
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!)).toMatchObject({ maxConcurrentJobs: 3, maxRemediationAttempts: 5, routes: { implementation: { provider: "anthropic", model: "opus" }, classification: { model: "haiku" } } });
  });
  it("sets the number of implementation passes, separately from the fix cycle limit, and explains the difference", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": { ...globalSettings, maxImplementationPasses: 3 } };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Workflow" }));
    const passes = await screen.findByLabelText("Implementation passes");
    expect(passes).toHaveValue(3);
    expect(screen.getByText(/separate from the fix cycle limit/)).toBeInTheDocument();
    await userEvent.clear(passes); await userEvent.type(passes, "8");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!)).toMatchObject({ maxImplementationPasses: 8, maxRemediationAttempts: 3 });
  });
  it("a project can have its own number of implementation passes", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": { ...globalSettings, maxImplementationPasses: 4 }, "/api/settings/projects/my-app": { ok: true } };
    app("/settings");
    expect(await screen.findByText("global: 4")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Implementation passes"), "9");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!).overrides).toMatchObject({ maxImplementationPasses: 9 });
  });
  it("keeps concurrency inside 1-8 and warns when the reviewer is the same model as the writer", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Workflow" }));
    const conc = await screen.findByLabelText("Concurrent jobs");
    await userEvent.clear(conc); await userEvent.type(conc, "99");
    expect(conc).toHaveValue(8);
    await userEvent.click(within(screen.getByRole("group", { name: "Independent review model presets" })).getByRole("button", { name: "default" }));
    expect(await screen.findByText(/partly marking its own work/)).toBeInTheDocument();
  });
  it("a project can override a setting, and one it leaves alone is not sent", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/settings/projects/my-app": { ok: true } };
    app("/settings");
    expect((await screen.findAllByText("global: 3")).length).toBeGreaterThanOrEqual(1); // the fix-cycle default (and the passes default) are shown beside their fields
    await userEvent.type(screen.getByLabelText("Fix cycle limit"), "1");
    const row = screen.getByText("Implementation model").closest("div")!.parentElement!;
    await userEvent.click(within(row).getByRole("button", { name: "Override for this project" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Implementation override model presets" })).getByRole("button", { name: "opus" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    const sent = JSON.parse(calls.find((c) => c.method === "PUT")!.body!);
    expect(sent.overrides).toEqual({ maxRemediationAttempts: 1, models: { implementation: { provider: "anthropic", model: "opus" } } }); // concurrency + other models: follow global
  });
  it("shows an agent run's conversation: prompt, messages, tool calls with their results, and the outcome", async () => {
    const run = { id: 7, stageExecutionId: null, agent: "anthropic/implementer", model: "claude-opus-5-5", exitCode: 0, durationMs: 5000, finished: true, usage: null, hasLog: true, at: 1 };
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job(), [], { invocations: [run] }), "/api/jobs/j1/invocations/7/conversation?after=0": { offset: 500, done: true, agent: "anthropic/implementer", model: "claude-opus-5-5", turns: [
      { kind: "prompt", text: "Implement the due-date feature\nline two\nline three\nline four" }, { kind: "session", model: "claude-opus-5-5", tools: 6 }, { kind: "text", text: "I'll start by reading the tests." },
      { kind: "tool", id: "t1", name: "Bash", input: "npm test" }, { kind: "tool_result", id: "t1", text: "12 passed\n3 skipped\nDone in 4s", error: false }, { kind: "usage", tokens: 50_000 }, { kind: "result", ok: true, text: "Done", turns: 3 } ] } };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("tab", { name: "Agent runs" }));
    await userEvent.click(await screen.findByRole("button", { name: "Conversation" }));
    expect(await screen.findByText("I'll start by reading the tests.")).toBeInTheDocument();
    expect(screen.getByText("Prompt sent to Claude")).toBeInTheDocument();
    expect(screen.queryByText(/line four/)).toBeNull();                               // the prompt is folded to its first lines until asked for
    await userEvent.click(screen.getAllByRole("button", { name: /\+2 lines/ })[0]!); // the prompt is first
    expect(screen.getByText(/line four/)).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();                             // a tool call reads like Claude Code: Bash(npm test)
    expect(screen.getByText("(npm test)")).toBeInTheDocument();
    expect(screen.getByText("12 passed")).toBeInTheDocument();                        // its result shows one line under it, the rest on request
    expect(screen.queryByText(/Done in 4s/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /\+2 lines \(click to expand\)/ })); // only the tool output is still folded
    expect(screen.getByText(/Done in 4s/)).toBeInTheDocument();
    expect(screen.getByText(/Finished after 3 turns/)).toBeInTheDocument();
  });
  it("shows a Claude Code style status bar: ticket, role, worktree, branch, model, tool calls, context and time", async () => {
    const run = { id: 9, stageExecutionId: null, agent: "anthropic/spec-writer", model: "claude-opus-5-5", exitCode: 0, durationMs: 185_000, finished: true, usage: null, hasLog: true, at: 1 };
    const wt = { path: "/Users/me/.software-factory/workspaces/zonto-hub/JAM-419", state: "active", branch: "factory/JAM-419" };
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job({ key: "JAM-419" }), [], { invocations: [run], worktree: wt }), "/api/jobs/j1/invocations/9/conversation?after=0": { offset: 9, done: true, agent: "anthropic/spec-writer", model: "claude-opus-5-5", cwd: wt.path, startedAt: 1, durationMs: 185_000, turns: [
      { kind: "session", model: "claude-opus-5-5", tools: 7 }, { kind: "tool", id: "a", name: "Read", input: "/x/y.ts" }, { kind: "tool", id: "b", name: "Bash", input: "ls" },
      { kind: "usage", tokens: 48_000 }, { kind: "result", ok: true, text: "ok", turns: 2 } ] } };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("tab", { name: "Agent runs" }));
    await userEvent.click(await screen.findByRole("button", { name: "Conversation" }));
    const bar = within(await screen.findByRole("status", { name: "run status" }));
    expect(bar.getByText("JAM-419")).toBeInTheDocument();
    expect(bar.getByText("spec-writer")).toBeInTheDocument();
    expect(bar.getByText("~/…/zonto-hub/JAM-419")).toBeInTheDocument();
    expect(bar.getByText("factory/JAM-419")).toBeInTheDocument();
    expect(bar.getByText("Opus 5.5")).toBeInTheDocument();
    expect(bar.getByText("2 tool calls")).toBeInTheDocument();
    expect(bar.getByText(/24%/)).toBeInTheDocument();                  // 48k of an assumed 200k window
    expect(bar.getByText("76% left")).toBeInTheDocument();
    expect(bar.getByText(/3m 05s/)).toBeInTheDocument();
    expect(screen.getByText(/finished · read-only view/)).toBeInTheDocument();
  });
  describe("peek: one button per step, a tab per agent session", () => {
    const T = 1_700_000_000_000;
    const mk = (id: number, agent: string, ms: number, o: object = {}) => ({ id, stageExecutionId: 1, agent, model: "claude-opus-5-5", exitCode: 0, durationMs: ms, finished: true, usage: null, hasLog: true, at: T, ...o });
    const runs = [mk(11, "anthropic/implementer", 32_000), mk(12, "anthropic/spec-writer", 50_000), mk(13, "anthropic/implementer", 6_000)];
    const conv = (text: string) => ({ offset: 1, done: true, agent: "anthropic/implementer", model: "claude-opus-5-5", turns: [{ kind: "text", text }] });
    const setup = () => {
      const exs = [{ id: 1, stage: "IMPLEMENTATION", attempt: 1, outcome: "failed", error: "did not converge", output: null, startedAt: T, finishedAt: T + 120_000 }];
      routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job({ stage: "IMPLEMENTATION", status: "running" }), exs, { invocations: runs, worktree: { path: "/w/JAM-1", state: "active", branch: "factory/JAM-1" } }),
        "/api/jobs/j1/invocations/11/conversation?after=0": conv("first session"), "/api/jobs/j1/invocations/12/conversation?after=0": conv("second session"), "/api/jobs/j1/invocations/13/conversation?after=0": conv("third session") };
    };
    it("shows a single Peek button for a step with many sessions, not one per session", async () => {
      setup(); app("/jobs/j1");
      expect(await screen.findByText("What happened")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /^(Peek|Watch live)/ })).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Peek: 3 sessions" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Conversation: implementer/ })).toBeNull();
    });
    it("opens the sessions as tabs (the latest first), and switching tab shows that session", async () => {
      setup(); app("/jobs/j1");
      await userEvent.click(await screen.findByRole("button", { name: "Peek: 3 sessions" }));
      const tabs = within(await screen.findByRole("tablist", { name: "Agent sessions" })).getAllByRole("tab");
      expect(tabs).toHaveLength(3);
      expect(tabs[2]).toHaveAttribute("aria-selected", "true");
      expect(await screen.findByText("third session")).toBeInTheDocument();
      await userEvent.click(tabs[1]!);
      expect(await screen.findByText("second session")).toBeInTheDocument();
      expect(screen.queryByText("third session")).toBeNull();
      expect(within(screen.getByRole("tablist", { name: "Agent sessions" })).getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
    });
    it("has a Close button in the window's header and a wrap tick box that is on by default and remembered", async () => {
      setup(); app("/jobs/j1");
      await userEvent.click(await screen.findByRole("button", { name: "Peek: 3 sessions" }));
      const wrap = await screen.findByRole("checkbox", { name: "Wrap lines" });
      expect(wrap).toBeChecked();
      await userEvent.click(wrap);
      expect(wrap).not.toBeChecked();
      expect(localStorage.getItem("sf.session.wrap")).toBe("0");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("tablist", { name: "Agent sessions" })).toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Peek: 3 sessions" }));
      expect(await screen.findByRole("checkbox", { name: "Wrap lines" })).not.toBeChecked();   // remembered
      localStorage.removeItem("sf.session.wrap");
    });
    it("keeps a long list of a step's events folded until asked for", async () => {
      const dec = (id: number, at: number) => ({ id, kind: "implementation.pass", decision: `pass ${id}`, rationale: "x", actor: "factory", at });
      const exs = [{ id: 1, stage: "IMPLEMENTATION", attempt: 1, outcome: "failed", error: "did not converge", output: null, startedAt: T, finishedAt: T + 120_000 }];
      routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job({ stage: "IMPLEMENTATION", status: "running" }), exs, { decisions: [1, 2, 3, 4, 5].map((i) => dec(i, T + i * 1000)) }) };
      app("/jobs/j1");
      const toggle = await screen.findByRole("button", { name: /Show 5 details/ });
      expect(screen.queryByText("pass 3 — x")).toBeNull();
      await userEvent.click(toggle);
      expect(screen.getByText("pass 3 — x")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Hide 5 details/ })).toBeInTheDocument();
    });
  });
  describe("What happened: a few entries at a time", () => {
    const T = 1_700_000_000_000;
    const STAGES = ["DISCOVERED", "ELIGIBILITY_CHECK", "REQUIREMENTS_ANALYSIS", "SPECIFICATION_GENERATION", "SPECIFICATION_REVIEW", "SPECIFICATION_VALIDATION", "IMPLEMENTATION_PREPARATION", "IMPLEMENTATION", "AUTOMATED_TESTING", "LOCAL_MODEL_REVIEW"];
    const open = (n: number) => {
      const exs = STAGES.slice(0, n).map((stage, i) => ({ id: i + 1, stage, attempt: 1, outcome: "succeeded", error: null, output: null, startedAt: T + i * 60_000, finishedAt: T + i * 60_000 + 30_000 }));
      routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job({ stage: "LOCAL_MODEL_REVIEW", status: "running" }), exs) };
      return app("/jobs/j1");
    };
    const title = (name: string) => screen.queryByRole("button", { name });
    it("shows 3 entries, then 3 more per click, and offers View all only after the first View more", async () => {
      open(10);
      expect(await screen.findByText("Showing 3 of 10")).toBeInTheDocument();
      expect(title("Independent review")).not.toBeNull();   // newest first
      expect(title("Implement")).not.toBeNull();
      expect(title("Prepare")).toBeNull();                   // the 4th newest is not shown yet
      expect(screen.getByRole("button", { name: "View more" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "View more" }));
      expect(screen.getByText("Showing 6 of 10")).toBeInTheDocument();
      expect(title("Prepare")).not.toBeNull();
      expect(title("Discovered")).toBeNull();
      expect(screen.getByRole("button", { name: "View more" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();   // now offered
      await userEvent.click(screen.getByRole("button", { name: "View more" }));
      expect(screen.getByText("Showing 9 of 10")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "View more" }));
      expect(screen.getByText("Showing 10 of 10")).toBeInTheDocument();
      expect(title("Discovered")).not.toBeNull();
      expect(screen.queryByRole("button", { name: "View more" })).toBeNull();            // nothing left to load
      expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
    });
    it("View all shows everything at once", async () => {
      open(10);
      await userEvent.click(await screen.findByRole("button", { name: "View more" }));
      await userEvent.click(screen.getByRole("button", { name: "View all" }));
      expect(screen.getByText("Showing 10 of 10")).toBeInTheDocument();
      expect(title("Discovered")).not.toBeNull();
    });
    it("starts again at 3 when the order or filter changes", async () => {
      open(10);
      await userEvent.click(await screen.findByRole("button", { name: "View more" }));
      expect(screen.getByText("Showing 6 of 10")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Newest first" }));
      expect(screen.getByText("Showing 3 of 10")).toBeInTheDocument();
      expect(title("Discovered")).not.toBeNull();            // oldest first now
      expect(title("Independent review")).toBeNull();
    });
    it("has no footer when everything already fits", async () => {
      open(3);
      expect(await screen.findByText("What happened")).toBeInTheDocument();
      expect(screen.queryByText(/^Showing /)).toBeNull();
      expect(screen.queryByRole("button", { name: "View more" })).toBeNull();
    });
  });
  it("renders hostile text in a conversation as inert text", async () => {
    const run = { id: 8, stageExecutionId: null, agent: "anthropic/implementer", model: null, exitCode: 0, durationMs: 1, finished: true, usage: null, hasLog: true, at: 1 };
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job(), [], { invocations: [run] }), "/api/jobs/j1/invocations/8/conversation?after=0": { offset: 1, done: true, agent: "x", model: null, turns: [
      { kind: "text", text: XSS }, { kind: "tool", id: "a", name: XSS, input: XSS }, { kind: "tool_result", id: "a", text: XSS, error: false } ] } };
    const { container } = app("/jobs/j1");
    await userEvent.click(await screen.findByRole("tab", { name: "Agent runs" }));
    await userEvent.click(await screen.findByRole("button", { name: "Conversation" }));
    await screen.findAllByText(/<img src=x onerror=/);
    expect(container.querySelectorAll("img, script, iframe, object, embed").length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect([...container.querySelectorAll("*")].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name)))).toBe(false);
  });
  const profilesBody = { current: "home", profiles: [
    { name: "home", port: 4780, url: "http://127.0.0.1:4780/", current: true, running: true },
    { name: "work", port: 4781, url: "http://127.0.0.1:4781/", current: false, running: true },
    { name: "old", port: 4782, url: "http://127.0.0.1:4782/", current: false, running: false } ] };
  it("shows a profile switcher only when there is more than one profile, and names the window after it", async () => {
    routes = { "/api/overview": overview(), "/api/profiles": { current: "default", profiles: [{ name: "default", port: 4780, url: "http://127.0.0.1:4780/", current: true, running: true }] } };
    app("/");
    await screen.findByText("RUNNING");
    expect(screen.queryByRole("combobox", { name: "profile" })).toBeNull();
    cleanup();
    routes = { "/api/overview": overview(), "/api/profiles": profilesBody };
    app("/");
    expect(await screen.findByRole("combobox", { name: "profile" })).toHaveTextContent("home");
    await waitFor(() => expect(document.title).toBe("Software Factory — home"));
  });
  it("creates a profile from Settings and says what happens next", async () => {
    routes = { "/api/overview": overview(), "/api/profiles": profilesBody, "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/profiles ": {} };
    routes["/api/profiles"] = profilesBody;
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Profiles" }));
    expect(await screen.findByText("port 4781")).toBeInTheDocument();
    expect(screen.getByText("○ stopped")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "Client A");
    await userEvent.click(screen.getByRole("button", { name: /Create profile/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/api/profiles")).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ name: "client a" });
  });
  it("picks this profile's GitHub account from the accounts gh is logged in to", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings,
      "/api/setup/github": { accounts: [{ login: "Nikorag", active: true }, { login: "jamiebartlett-kps", active: false }], defaultAccount: null }, "/api/settings/global ": {} };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Workflow" }));
    expect(await screen.findByText(/Logged in on this machine: Nikorag, jamiebartlett-kps/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "GitHub account" }));
    await userEvent.click(await screen.findByRole("option", { name: "jamiebartlett-kps" }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!).githubAccount).toBe("jamiebartlett-kps");
  });
  it("shows each project's onboarding status in the list and a checklist with the next action in its editor", async () => {
    const steps = (speckit: boolean) => [
      { id: "repo", label: "Repository reachable", ok: true, detail: "me/my-app" },
      { id: "speckit", label: "Spec Kit set up on the default branch", ok: speckit, detail: speckit ? "present" : "onboarding pull request is open: merge it, then press Validate" },
      { id: "test", label: "Test command configured", ok: true, detail: "npm test" } ];
    routes = { "/api/overview": overview(), "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/projects": { projects: [
      { ...proj, onboarding: { status: "in-progress", steps: steps(false) } },
      { ...proj, id: "done", name: "Done", githubRepo: "me/done", onboarding: { status: "ready", steps: steps(true) } } ] } };
    app("/settings");
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    expect(within(nav).getByRole("img", { name: "onboarding: in-progress" })).toBeInTheDocument();
    expect(within(nav).getByRole("img", { name: "onboarding: ready" })).toBeInTheDocument();
    const box = within(await screen.findByLabelText("Onboarding"));
    expect(box.getByText(/Almost there: tickets are skipped until all of this is done/)).toBeInTheDocument();
    expect(box.getByText(/merge it, then press Validate/)).toBeInTheDocument();      // it says what to do next
    expect(box.getAllByLabelText("done")).toHaveLength(2); expect(box.getAllByLabelText("to do")).toHaveLength(1);
    await userEvent.click(within(nav).getByRole("button", { name: /Done/ }));
    expect(await screen.findByText("Ready: tickets will be picked up")).toBeInTheDocument();
  });
  const ticket = (o: object = {}) => ({ id: "i1", key: "ENG-418", title: "Fix the login redirect", url: "https://linear.app/x/issue/ENG-418", state: "Backlog", stateType: "backlog", labels: [], linearProject: "Alpha", projectId: "a", projectName: "Alpha", mode: "manual", job: null, canStart: true, reason: null, ...o });
  const board = (items: object[], mode = "manual") => ({ mode, query: "", items, projects: [{ id: "a", name: "Alpha", mode }] });
  it("shows tickets in a lane per Linear status, with the mode, and starts one on click", async () => {
    routes = { "/api/overview": overview(), "/api/board": board([ticket(), ticket({ id: "i2", key: "ENG-7", title: "Speed up CI", state: "In progress", stateType: "started", job: { id: "j9", status: "running", stage: "IMPLEMENTATION" }, canStart: false, reason: "the factory is already working on it" })]), "/api/board/start": { ok: true, jobId: "j1" } };
    app("/board");
    expect(await screen.findByText(/Manual mode: nothing starts until you start it/)).toBeInTheDocument();
    const backlog = within(await screen.findByRole("region", { name: "Backlog" }));
    expect(backlog.getByText("Fix the login redirect")).toBeInTheDocument();
    const progress = within(screen.getByRole("region", { name: "In progress" }));
    expect(progress.getByText("the factory is already working on it")).toBeInTheDocument();      // why it cannot be started
    expect(progress.queryByRole("button", { name: /Start/ })).toBeNull();
    expect(progress.getByText("implement")).toBeInTheDocument();                             // and what it is doing now
    await userEvent.click(backlog.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/board/start")?.body).toBe(JSON.stringify({ issueId: "i1", projectId: "a" })));
    expect(await screen.findByText("Started ENG-418. It is queued and will begin shortly.")).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/board/start")!.headers).toMatchObject({ "X-Factory-UI": "1" });
  });
  it("searches by number: sends what was typed, shows matches as results, and explains an empty search", async () => {
    routes = { "/api/overview": overview(), "/api/board": board([ticket()]), "/api/board?q=418": board([ticket()]), "/api/board?q=999": board([]) };
    app("/board");
    await screen.findByRole("region", { name: "Backlog" });
    await userEvent.type(screen.getByLabelText("Search tickets"), "418");
    await waitFor(() => expect(calls.some((c) => c.url === "/api/board?q=418")).toBe(true));
    expect(await screen.findByText("Fix the login redirect")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Backlog" })).toBeNull();                        // results, not lanes
    await userEvent.clear(screen.getByLabelText("Search tickets")); await userEvent.type(screen.getByLabelText("Search tickets"), "999");
    expect(await screen.findByText(/No ticket matches “999”/)).toBeInTheDocument();
  });
  it("shows why a ticket cannot be started and shows the server's error if starting fails", async () => {
    routes = { "/api/overview": overview(), "/api/board": board([ticket({ canStart: false, reason: "the project is not onboarded yet (Settings → Projects)" }), ticket({ id: "i3", key: "ENG-5", title: "Another", state: "Todo", stateType: "unstarted" })], "automatic") };
    app("/board");
    expect(await screen.findByText(/Automatic mode: labelled tickets start on their own/)).toBeInTheDocument();
    expect(screen.getByText(/the project is not onboarded yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start" })); // /api/board/start is not routed: 404 -> error
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
  it("sets the pickup mode for the profile and per project", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": { ...globalSettings, pickupMode: "automatic" }, "/api/settings/global ": {} };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Workflow" }));
    await userEvent.click(await screen.findByRole("radio", { name: /Manual/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!).pickupMode).toBe("manual");
  });
  const jiraInfo = { ...setupInfo, tracker: { kind: "jira", name: "Jira", connected: true } };
  const jiraStatus = { tracker: "jira", clientId: "clientidclientid1234", secretSet: true, connected: true, site: { cloudId: "c1", url: "https://acme.atlassian.net", name: "Acme" }, siteChoices: [], callbackUrl: "http://127.0.0.1:4780/api/jira/oauth/callback", scopes: [] };
  const jiraMap = { statuses: { inProgress: "In Progress" }, labels: { enabled: "factory-ready" }, required: { statuses: ["specificationReview", "inProgress", "readyForReview", "done", "blocked"], labels: ["blocked"], automaticStatus: "readyForSpecification", automaticLabel: "enabled" } };
  const jiraMeta = { projects: [{ key: "ENG", name: "Engineering" }], project: "ENG", statuses: ["To Do", "In Progress", "In Review", "Closed"], labels: ["urgent", "factory-ready"] };
  const jiraRoutes = () => ({ "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": jiraInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/jira/status": jiraStatus, "/api/jira/mapping": jiraMap, "/api/jira/metadata": jiraMeta, "/api/jira/mapping/check": { ok: true, projects: [] } });

  it("walks through connecting Jira: shows the callback URL to register, saves the app, and starts the OAuth sign-in in the browser", async () => {
    const opened: string[] = [];
    vi.stubGlobal("open", (u: string) => { opened.push(u); return null; });
    routes = { ...jiraRoutes(), "/api/setup": jiraInfo, "/api/jira/status": { ...jiraStatus, connected: false, site: null }, "/api/jira/app": { ok: true }, "/api/jira/connect": { url: "https://auth.atlassian.com/authorize?client_id=x", callbackUrl: "x" } };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    expect(await screen.findByTestId("callback")).toHaveTextContent("http://127.0.0.1:4780/api/jira/oauth/callback");
    expect(screen.getByText(/OAuth 2.0 \(3LO\)/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Client secret/), "supersecretsupersecret1");
    await userEvent.click(screen.getByRole("button", { name: "Save app" }));
    await waitFor(() => expect(JSON.parse(calls.find((c) => c.url === "/api/jira/app")!.body!)).toEqual({ clientId: "clientidclientid1234", clientSecret: "supersecretsupersecret1" }));
    await userEvent.click(screen.getByRole("button", { name: /Connect Jira/ }));
    await waitFor(() => expect(opened).toEqual(["https://auth.atlassian.com/authorize?client_id=x"]));
    expect(screen.queryByDisplayValue("supersecretsupersecret1")).toBeNull();                      // the secret is cleared from the page once saved
    vi.unstubAllGlobals(); vi.stubGlobal("fetch", globalThis.fetch);
  });
  it("maps the factory's statuses and labels onto Jira's, flags what is still required, and saves", async () => {
    routes = { ...jiraRoutes(), "/api/jira/mapping ": {} };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    expect(await screen.findByText(/cannot create statuses in Jira/)).toBeInTheDocument();
    expect(screen.getByText(/Still to map: Specification review, Ready for review, Done, Blocked/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Done status" }));
    await userEvent.click(await screen.findByRole("option", { name: "Closed" }));
    await userEvent.type(screen.getByLabelText("Blocked label"), "factory blocked");               // spaces are stripped: Jira labels cannot have them
    expect(screen.getByLabelText("Blocked label")).toHaveValue("factoryblocked");
    await userEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/jira/mapping")).toBeTruthy());
    const sent = JSON.parse(calls.find((c) => c.method === "PUT" && c.url === "/api/jira/mapping")!.body!);
    expect(sent.statuses).toMatchObject({ inProgress: "In Progress", done: "Closed" });
    expect(sent.labels).toMatchObject({ enabled: "factory-ready", blocked: "factoryblocked" });
  });
  it("uses Jira's words in the project editor, and shows which Jira projects fail the mapping check", async () => {
    routes = { ...jiraRoutes(), "/api/projects": { projects: [proj] }, "/api/setup/linear": { teams: [{ key: "ENG", name: "Engineering", projects: ["Web"], audit: { ok: true, statuses: [], labels: [] } }] } };
    app("/settings");
    expect(await screen.findByText("Jira project")).toBeInTheDocument();
    expect(screen.getByText("Component (optional)")).toBeInTheDocument();
    cleanup();
    routes = { ...jiraRoutes(), "/api/jira/mapping/check": { ok: false, projects: [{ projectId: "my-app", jiraProject: "ENG", found: true, missing: ['done: "Closed"'] }] } };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    expect(await screen.findByText(/these statuses do not exist there: done: "Closed"/)).toBeInTheDocument();
  });
  it("switches the tracker only after confirming, and shows the server's refusal", async () => {
    routes = { ...jiraRoutes(), "/api/setup": setupInfo, "/api/settings/tracker": { ok: true } };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Jira" }));
    expect(await screen.findByText("Switch this profile to Jira?")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/settings/tracker")).toBe(false);                      // nothing happens until confirmed
    await userEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(JSON.parse(calls.find((c) => c.url === "/api/settings/tracker")!.body!)).toEqual({ tracker: "jira" }));
  });
  const entry = (id: string, kind: string, label: string, o: object = {}) => ({ id, kind, label, builtin: ["linear", "jira", "github"].includes(id), isDefault: id === "linear", connected: false, projects: [], ...o });
  const trackerList = { default: "linear", trackers: [entry("linear", "linear", "Linear", { connected: true, projects: ["my-app"] }), entry("jira", "jira", "Jira"), entry("github", "github", "GitHub Issues"), entry("work-jira", "jira", "Work Jira")] };
  it("sets up one of several tracker connections: each Jira has its own app, so its calls say which one", async () => {
    routes = { ...jiraRoutes(), "/api/setup": setupInfo, "/api/trackers": trackerList, "/api/jira/status?tracker=work-jira": { ...jiraStatus, id: "work-jira", clientId: null, secretSet: false, connected: false, site: null } };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    const pick = await screen.findByRole("combobox", { name: "Tracker connection to set up" });
    expect(screen.getByRole("radio", { name: "Work Jira" })).toBeInTheDocument();                  // every connection can be the profile's default
    await userEvent.selectOptions(pick, "work-jira");
    expect(await screen.findByText(/Your Atlassian OAuth app/)).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/jira/status?tracker=work-jira")).toBe(true));
    expect(calls.some((c) => c.url === "/api/jira/status")).toBe(false);                           // the built-in Jira was not asked
  });
  it("adds a tracker connection: a named second Jira (or Linear, or GitHub) with its own id", async () => {
    routes = { ...jiraRoutes(), "/api/setup": setupInfo, "/api/trackers": trackerList };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    await userEvent.click(await screen.findByRole("button", { name: /Add another tracker connection/ }));
    const form = within(screen.getByRole("group", { name: "Add a tracker connection" }));
    await userEvent.type(form.getByLabelText("Name"), "Client Jira");
    await userEvent.click(form.getByRole("button", { name: "Add connection" }));
    await waitFor(() => expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url === "/api/trackers")!.body!)).toEqual({ id: "client-jira", kind: "jira", label: "Client Jira" }));
  });
  it("a project can name its own tracker connection, and then picks its team from that connection", async () => {
    routes = { ...jiraRoutes(), "/api/projects": { projects: [proj] }, "/api/setup": setupInfo, "/api/trackers": trackerList, "/api/settings/projects/my-app": { ok: true },
      "/api/setup/linear?tracker=work-jira": { teams: [{ key: "WEB", name: "Web", projects: ["Core"], audit: { ok: true, statuses: [], labels: [] } }] } };
    app("/settings");
    await userEvent.click(await screen.findByRole("combobox", { name: "tracker connection" }));
    await userEvent.click(await screen.findByRole("option", { name: "Work Jira" }));
    expect(await screen.findByText("Jira project")).toBeInTheDocument();                           // the words change with the connection's kind
    await userEvent.click(await screen.findByRole("combobox", { name: "linear team" }));
    await userEvent.click(await screen.findByRole("option", { name: "WEB · Web" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/settings/projects/my-app")).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.method === "PUT" && c.url === "/api/settings/projects/my-app")!.body!)).toMatchObject({ tracker: "work-jira", linear: { teamKey: "WEB" } });
  });
  const bbCreds = { credentials: [{ name: "work", kind: "access-token", email: null, hasToken: true, usedBy: ["my-app"] }, { name: "me", kind: "api-token", email: "me@x.com", hasToken: false, usedBy: [] }] };
  it("manages Bitbucket credentials: lists them with the projects that use them, never shows a token, and saves a new one", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/bitbucket/credentials": bbCreds, "/api/bitbucket/credentials/new-one": { ok: true } };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    expect(await screen.findByText("used by my-app")).toBeInTheDocument();
    expect(screen.getByText("me@x.com")).toBeInTheDocument();
    expect(screen.getByText("no token")).toBeInTheDocument();                                          // a credential that still needs its token is flagged
    await userEvent.clear(screen.getByLabelText("Name")); await userEvent.type(screen.getByLabelText("Name"), "new-one");
    await userEvent.type(screen.getByLabelText(/^Token/), "ATBB-secret-token-value");
    await userEvent.click(screen.getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(JSON.parse(calls.find((c) => c.method === "PUT" && c.url === "/api/bitbucket/credentials/new-one")!.body!)).toEqual({ kind: "access-token", token: "ATBB-secret-token-value" }));
    expect(await screen.findByText(/Saved "new-one"/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("ATBB-secret-token-value")).toBeNull();                          // cleared once saved
  });
  it("an API token needs the account email before it can be saved", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/bitbucket/credentials": { credentials: [] } };
    app("/settings");
    await userEvent.click(await screen.findByRole("tab", { name: "Integrations" }));
    await userEvent.type(await screen.findByLabelText(/^Token/), "tok-123456789");
    await userEvent.click(screen.getByRole("combobox", { name: "kind of token" }));
    await userEvent.click(await screen.findByRole("option", { name: /API token/ }));
    expect(screen.getByRole("button", { name: "Save credential" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Atlassian account email"), "me@x.com");
    expect(screen.getByRole("button", { name: "Save credential" })).toBeEnabled();
  });
  it("a project picks its host: GitHub shows the gh account, Bitbucket shows the repo and a credential, and both are saved per project", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [{ ...proj, host: "bitbucket", bitbucketRepo: "acme/widgets", bitbucketCredential: "work", githubRepo: null }] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/bitbucket/credentials": bbCreds, "/api/settings/projects/my-app": { ok: true }, "/api/bitbucket/credentials/work/test": { ok: true, name: "acme/widgets", isPrivate: true, mainBranch: "main" } };
    app("/settings");
    expect(await screen.findByDisplayValue("acme/widgets")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "host" })).toHaveTextContent("Bitbucket");
    expect(screen.queryByRole("combobox", { name: "GitHub account" })).toBeNull();                   // no gh account for a Bitbucket project
    await userEvent.click(screen.getByRole("button", { name: "Test access" }));
    expect(await screen.findByText(/acme\/widgets is reachable \(default branch main\)/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), " 2");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!)).toMatchObject({ host: "bitbucket", bitbucket: { repo: "acme/widgets", credential: "work" } });
    expect(JSON.parse(calls.find((c) => c.method === "PUT")!.body!).github).toBeUndefined();
  });
  it("a GitHub project is saved as GitHub, with its gh account, and no Bitbucket section", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/bitbucket/credentials": bbCreds, "/api/settings/projects/my-app": { ok: true }, "/api/setup/github": { accounts: [{ login: "Nikorag", active: true }], defaultAccount: null } };
    app("/settings");
    await userEvent.type(await screen.findByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    const sent = JSON.parse(calls.find((c) => c.method === "PUT")!.body!);
    expect(sent).toMatchObject({ host: "github", github: { repo: "me/my-app" } });
    expect(sent.bitbucket).toBeUndefined();
  });
  it("Settings → System has a Check for updates button that asks now and tells you what to do", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings,
      "/api/update": { version: "0.2.0", current: "v0.2.0", latest: "v0.2.0", available: false, checkedAt: Date.now() - 3600_000 },
      "/api/update/check": { version: "0.2.0", current: "v0.2.0", latest: "v0.3.0", available: true, checkedAt: Date.now() } };
    app("/settings?tab=system");                                                                           // the app menu links straight here
    expect(await screen.findByText("v0.2.0")).toBeInTheDocument();
    expect(screen.getByText(/You're on the latest release/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Check for updates/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST" && c.url === "/api/update/check")).toBeTruthy());
    expect(await screen.findByText(/v0\.3\.0 is available/)).toBeInTheDocument();
    expect(screen.getByText("software-factory update")).toBeInTheDocument();
    expect(screen.getByText(/Pick a quiet moment/)).toBeInTheDocument();
    expect(screen.queryByText(/You're on the latest release/)).toBeNull();
  });
  it("says so when the update check cannot reach GitHub", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] }, "/api/settings/global": globalSettings, "/api/update": { version: "0.2.0", current: null, latest: null, available: false, checkedAt: Date.now(), error: "unable to access remote" } };
    app("/settings?tab=system");
    expect(await screen.findByText(/Could not check for updates: unable to access remote/)).toBeInTheDocument();
  });
  it("shows a job's story as a timeline: why each step ran again, fix cycles, and a way into the agent's conversation", async () => {
    const T = 1_700_000_000_000;
    const exs = [
      { id: 1, stage: "AUTOMATED_TESTING", attempt: 1, outcome: "succeeded", error: null, output: null, startedAt: T, finishedAt: T + 60_000 },
      { id: 2, stage: "LOCAL_MODEL_REVIEW", attempt: 1, outcome: "succeeded", error: null, output: JSON.stringify({ remediate: "2 blocking finding(s) in the code review" }), startedAt: T + 60_000, finishedAt: T + 90_000 },
      { id: 3, stage: "REMEDIATION", attempt: 1, outcome: "succeeded", error: null, output: JSON.stringify({ accepted: [1, 2], rejected: [] }), startedAt: T + 90_000, finishedAt: T + 200_000 },
      { id: 4, stage: "AUTOMATED_TESTING", attempt: 2, outcome: "failed", error: "3 tests failed", output: null, startedAt: T + 200_000, finishedAt: T + 230_000 },
    ];
    const run = { id: 9, stageExecutionId: 3, agent: "anthropic/implementer", model: "m", exitCode: 0, durationMs: 110_000, finished: true, usage: null, hasLog: true, at: T };
    routes = { "/api/overview": overview(), "/api/jobs/j1": { ...detail(job({ stage: "REMEDIATION", status: "running", remediationAttempts: 1 }), exs, { invocations: [run] }), remediationCap: 3 } };
    app("/jobs/j1");
    expect(await screen.findByText("What happened")).toBeInTheDocument();
    expect(screen.getByText(/Sent back for fixes: 2 blocking finding\(s\) in the code review/)).toBeInTheDocument();   // why it looped
    expect(screen.getByText(/Fix findings · cycle 1 of 3/)).toBeInTheDocument();
    expect(screen.getByText("run 2")).toBeInTheDocument();                                                          // the re-run after the fix
    expect(screen.getAllByText("3 tests failed").length).toBeGreaterThanOrEqual(1);                                    // and how it ended (also in the stage history table)
    expect(screen.getByText(/1 fix cycle/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Peek: 1 session" })).toBeInTheDocument();
    const order = screen.getAllByRole("listitem").map((li) => li.textContent ?? "").filter((t) => /Run checks|Independent review|Fix findings/.test(t));
    expect(order[0]).toMatch(/Run checks/); expect(order[0]).toMatch(/3 tests failed/);                             // newest first
    await userEvent.click(screen.getByRole("button", { name: "Newest first" }));
    const oldest = screen.getAllByRole("listitem").map((li) => li.textContent ?? "").filter((t) => /Run checks|Independent review|Fix findings/.test(t));
    expect(oldest[0]).toMatch(/Run checks/); expect(oldest[0]).not.toMatch(/3 tests failed/);                       // oldest first
  });
  it("can show only the problems and fix cycles, and clicking a step focuses it on the chart", async () => {
    const T = 1_700_000_000_000;
    const exs = [
      { id: 1, stage: "AUTOMATED_TESTING", attempt: 1, outcome: "succeeded", error: null, output: null, startedAt: T, finishedAt: T + 1000 },
      { id: 2, stage: "CLAUDE_REVIEW", attempt: 1, outcome: "failed", error: "boom", output: null, startedAt: T + 1000, finishedAt: T + 2000 },
    ];
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job({ stage: "CLAUDE_REVIEW" }), exs) };
    app("/jobs/j1");
    await screen.findByText("What happened");
    await userEvent.click(screen.getByRole("button", { name: "Problems and fixes only" }));
    expect(screen.queryByRole("button", { name: "Run checks" })).toBeNull();                                          // the successful step is hidden
    await userEvent.click(screen.getByRole("button", { name: "Claude review" }));
    expect(await screen.findByText("Selected step")).toBeInTheDocument();                                            // the step panel opened for it
  });
});

describe("reliability: live state, lost connections and double clicks", () => {
  it("a run stopped by a signal (no exit code, but a duration) is finished, not 'Watch live'; a run still going is live", async () => {
    const stopped = { id: 3, stageExecutionId: null, agent: "anthropic/implementer", model: "m", exitCode: null, durationMs: 300_000, finished: true, usage: null, hasLog: true, at: 1 };
    const live = { ...stopped, id: 4, agent: "anthropic/reviewer", durationMs: null, finished: false };
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job(), [], { invocations: [stopped, live] }) };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("tab", { name: "Agent runs" }));
    const rows = screen.getAllByRole("row");
    const row = (agent: string) => within(rows.find((r) => within(r).queryByText(agent))!);
    expect(row("anthropic/implementer").getByRole("button", { name: "Conversation" })).toBeInTheDocument();
    expect(row("anthropic/implementer").getByText("stopped")).toBeInTheDocument();
    expect(row("anthropic/reviewer").getByRole("button", { name: "Watch live" })).toBeInTheDocument();
  });
  it("says the connection is lost (keeping the last data, marked as old) and disables controls until it is back", async () => {
    routes = { "/api/overview": overview(), "/api/control/pause": { ok: true } };
    app("/");
    await userEvent.click(await screen.findByRole("button", { name: /Pause/ }));
    delete routes["/api/overview"]; // the next poll (3s later) fails
    await waitFor(() => expect(screen.getByTestId("connection-lost")).toHaveTextContent(/Connection lost.*last updated \d+s ago/), { timeout: 5000 });
    expect(screen.getByText("RUNNING")).toBeInTheDocument();                       // last known state still shown
    expect(screen.getByRole("button", { name: /Pause/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Emergency stop/ })).toBeEnabled(); // always worth trying
    routes["/api/overview"] = overview();
    await waitFor(() => expect(screen.queryByTestId("connection-lost")).toBeNull(), { timeout: 15_000 });
    expect(screen.getByRole("button", { name: /Pause/ })).toBeEnabled();
  }, 25_000);
  it("a double-clicked Retry sends one request and shows no false error", async () => {
    let release = () => {};
    const j = job({ stage: "NEEDS_ATTENTION", status: "waiting", heldFromStage: "CLAUDE_REVIEW" });
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j), "/api/jobs/j1/retry": () => new Promise((r) => { release = () => r({ ok: true }); }) };
    app("/jobs/j1");
    const retry = await screen.findByRole("button", { name: /Retry/ });
    await userEvent.dblClick(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: /Retry/ })).toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: /Retry/ })).toBeEnabled());
    expect(calls.filter((c) => c.url === "/api/jobs/j1/retry")).toHaveLength(1);
    expect(screen.queryByText(/HTTP \d{3}|not held|cannot retry/i)).toBeNull(); // no false error from a second request
  });
  it("says that retrying an archived job restores it from the archive", async () => {
    const j = job({ stage: "FAILED", status: "failed", heldFromStage: "IMPLEMENTATION", archivedAt: 5 });
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j) };
    app("/jobs/j1");
    expect(await screen.findByText(/Retrying will restore this job from the archive/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry and restore/ })).toBeInTheDocument();
  });
  it("never turns a hostile ticket URL into a link on the Board", async () => {
    const t = { id: "i1", key: "ENG-1", title: "Evil", url: "javascript:window.__pwned=1", state: "Backlog", stateType: "backlog", labels: [], linearProject: "A", projectId: "a", projectName: "A", mode: "manual", job: null, canStart: true, reason: null };
    const good = { ...t, id: "i2", key: "ENG-2", title: "Fine", url: "https://linear.app/x/issue/ENG-2" };
    routes = { "/api/overview": overview(), "/api/board": { mode: "manual", query: "", items: [t, good], projects: [{ id: "a", name: "A", mode: "manual" }] } };
    const { container } = app("/board");
    expect(await screen.findByText("ENG-1")).toBeInTheDocument();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByRole("link", { name: /ENG-2/ })).toHaveAttribute("href", "https://linear.app/x/issue/ENG-2");
  });
  it("shows why a project cannot be removed while it has active jobs", async () => {
    routes = { "/api/overview": overview(), "/api/projects": { projects: [proj] }, "/api/setup": setupInfo, "/api/setup/linear": { teams: [] },
      "/api/settings/projects/my-app": { __status: 409, error: "my-app has 1 active job(s). Finish or cancel them before removing the project." } };
    app("/settings");
    await userEvent.click(await screen.findByRole("button", { name: /Remove/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Could not remove: my-app has 1 active job/)).toBeInTheDocument();
    cleanup();
    routes = { ...routes, "/api/projects": { projects: [{ ...proj, activeJobs: 2 }] } };
    app("/settings");
    expect(await screen.findByText(/2 active job\(s\) use this project/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove/ })).toBeDisabled();
  });
  it("Health: Re-check asks the server to probe again now", async () => {
    const report = { system: overview().system, health: [{ name: "github", status: "error", detail: "unreachable", checkedAt: 1 }] };
    routes = { "/api/health": report, "/api/health?refresh=1": { ...report, health: [{ name: "github", status: "ok", detail: "ok now", checkedAt: 2 }] } };
    render(<MemoryRouter><HealthPage /></MemoryRouter>);
    await userEvent.click(await screen.findByRole("button", { name: /Re-check/ }));
    expect(await screen.findByText(/ok now/)).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/health?refresh=1")).toHaveLength(1);
  });
});

