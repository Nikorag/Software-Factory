import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { deriveFlow } from "@/lib/pipeline";
import { JobDetail } from "@/pages/JobDetail";
import { Settings } from "@/pages/Settings";
import { Setup } from "@/pages/Setup";
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
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const app = (path: string) => render(
  <MemoryRouter initialEntries={[path]}><Routes><Route element={<Shell />}><Route index element={<Overview />} /><Route path="jobs/:id" element={<JobDetail />} /><Route path="settings" element={<Settings />} /><Route path="setup" element={<Setup />} /></Route></Routes></MemoryRouter>,
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
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(j, [{ ...exec("DISCOVERED", "failed"), error: XSS }], { decisions: [{ id: 1, kind: XSS, decision: XSS, rationale: XSS, actor: XSS, at: 1 }], invocations: [{ id: 1, stageExecutionId: null, agent: XSS, model: XSS, exitCode: 0, durationMs: 1, usage: null, hasLog: false, at: 1 }] }) };
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
const setupInfo = { configDir: null, homeConfigDir: "~/.software-factory/config", usingDefaults: true, projectCount: 1, linear: { keyPresent: true, env: "LINEAR_API_KEY", keychainService: "svc" } };

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
    routes = { "/api/overview": overview(), "/api/projects": { projects: [] }, "/api/setup": { ...setupInfo, projectCount: 0, linear: { ...setupInfo.linear, keyPresent: false } }, "/api/setup/linear": { teams: [] },
      "/api/health": { system: overview().system, health: [{ name: "claude code", status: "fail", detail: "not logged in", checkedAt: 1 }, { name: "sandbox", status: "ok", detail: "ready", checkedAt: 1 }], scheduler: null } };
    app("/setup");
    expect(await screen.findByText("not logged in")).toBeInTheDocument();
    expect(screen.getByText(/run `claude`, then \/login/i)).toBeInTheDocument(); // the fix is shown next to the failure
    await userEvent.click(screen.getByRole("button", { name: /Continue anyway/ }));
    expect(await screen.findByText("Connect Linear")).toBeInTheDocument();
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
    expect(await screen.findByText("global: 3")).toBeInTheDocument(); // the fix-cycle default is shown beside the field
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
    const run = { id: 7, stageExecutionId: null, agent: "anthropic/implementer", model: "claude-opus-5-5", exitCode: 0, durationMs: 5000, usage: null, hasLog: true, at: 1 };
    routes = { "/api/overview": overview(), "/api/jobs/j1": detail(job(), [], { invocations: [run] }), "/api/jobs/j1/invocations/7/conversation?after=0": { offset: 500, done: true, agent: "anthropic/implementer", model: "claude-opus-5-5", turns: [
      { kind: "prompt", text: "Implement the due-date feature" }, { kind: "session", model: "claude-opus-5-5", tools: 6 }, { kind: "text", text: "I'll start by reading the tests." },
      { kind: "tool", id: "t1", name: "Bash", input: "npm test" }, { kind: "tool_result", id: "t1", text: "12 passed", error: false }, { kind: "result", ok: true, text: "Done", turns: 3 } ] } };
    app("/jobs/j1");
    await userEvent.click(await screen.findByRole("tab", { name: "Agent runs" }));
    await userEvent.click(await screen.findByRole("button", { name: "Conversation" }));
    expect(await screen.findByText("I'll start by reading the tests.")).toBeInTheDocument();
    expect(screen.getByText("Prompt sent to Claude")).toBeInTheDocument();
    expect(screen.queryByText("Implement the due-date feature")).toBeNull();          // the prompt is collapsed until asked for
    const tool = screen.getByRole("button", { name: /Bash.*npm test/ });
    expect(screen.queryByText("12 passed")).toBeNull();                               // so is the tool output
    await userEvent.click(tool);
    expect(screen.getByText("12 passed")).toBeInTheDocument();
    expect(screen.getByText(/Finished after 3 turns/)).toBeInTheDocument();
  });
  it("renders hostile text in a conversation as inert text", async () => {
    const run = { id: 8, stageExecutionId: null, agent: "anthropic/implementer", model: null, exitCode: 0, durationMs: 1, usage: null, hasLog: true, at: 1 };
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
    expect(box.getByText("Almost there")).toBeInTheDocument();
    expect(box.getByText(/merge it, then press Validate/)).toBeInTheDocument();      // it says what to do next
    expect(box.getAllByLabelText("done")).toHaveLength(2); expect(box.getAllByLabelText("to do")).toHaveLength(1);
    await userEvent.click(within(nav).getByRole("button", { name: /Done/ }));
    expect(await screen.findByText("Ready: tickets will be picked up")).toBeInTheDocument();
  });
});
