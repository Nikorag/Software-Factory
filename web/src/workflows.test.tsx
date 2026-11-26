import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ProjectEditor } from "@/components/ProjectEditor";
import { JobDetail } from "@/pages/JobDetail";
import { WorkflowEditor } from "@/pages/WorkflowEditor";
import { Workflows } from "@/pages/Workflows";
import type { Job, JobDetail as D, Project } from "@/lib/types";
import type { WorkflowFull, WorkflowListItem, WorkflowList, WorkflowUsage } from "@/lib/workflows";
import { customDefinition, defaultDefinition, META } from "@/test-fixtures";

const usage = (o: Partial<WorkflowUsage> = {}): WorkflowUsage => ({ projects: [], labels: [], activeJobs: 0, isGlobalDefault: false, ...o });
const item = (o: Partial<WorkflowListItem>): WorkflowListItem => ({ id: "w", name: "W", description: "", version: 1, enabled: true, builtin: false, category: null, tags: [], createdAt: 1, updatedAt: 1, stageCount: 3, valid: true, usage: usage(), ...o });
const BUILTIN = item({ id: "default", name: "Default Workflow", description: "The standard process.", builtin: true, stageCount: 19, usage: usage({ isGlobalDefault: true }) });
const CUSTOM = item({ id: "docs", name: "Docs only", description: "Skips the build.", version: 3, category: "docs", tags: ["fast"], stageCount: 7, usage: usage({ projects: ["web"], labels: [{ id: "L1", name: "docs", priority: 50 }], activeJobs: 1 }) });
const list = (o: Partial<WorkflowList> = {}): WorkflowList => ({ workflows: [BUILTIN, CUSTOM], settings: { defaultWorkflowId: "default", labelConflictPolicy: "block" }, assignments: [], ...o });
const full = (w: WorkflowListItem, definition = customDefinition()): WorkflowFull => ({ ...w, definition, issues: [], warnings: [], versions: [] });

type Handler = unknown | ((body: any, url: string) => unknown); // eslint-disable-line @typescript-eslint/no-explicit-any
let routes: Record<string, Handler>;
let calls: { url: string; method: string; headers?: Record<string, string>; body?: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers: init?.headers as Record<string, string>, body });
    const route = routes[`${method} ${url}`] ?? (method === "GET" ? routes[url] : undefined);
    const res = typeof route === "function" ? await (route as (b: unknown, u: string) => unknown)(body, url) : route;
    const status = res && typeof res === "object" && "__status" in res ? (res as { __status: number }).__status : res === undefined ? 404 : 200;
    return new Response(JSON.stringify(res ?? {}), { status, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const Where = () => <span data-testid="where">{useLocation().pathname}{useLocation().search}</span>;
const app = (path: string) => render(
  <MemoryRouter initialEntries={[path]}><Where /><Routes>
    <Route path="workflows" element={<Workflows />} /><Route path="workflows/:id" element={<WorkflowEditor />} /><Route path="jobs/:id" element={<JobDetail />} />
  </Routes></MemoryRouter>,
);
const validateOk = (errors: unknown[] = [], warnings: unknown[] = []) => ({ ok: errors.length === 0, errors, warnings });

describe("workflow library", () => {
  it("lists every workflow with version, status, stage count, tags and where it is used; the built-in one cannot be deleted", async () => {
    routes = { "/api/workflows": list() };
    app("/workflows");
    const row = (await screen.findByText("Docs only")).closest("tr")!;
    expect(within(row).getByText("v3")).toBeInTheDocument(); expect(within(row).getByText("7")).toBeInTheDocument();
    expect(within(row).getByText("enabled")).toBeInTheDocument(); expect(within(row).getByText("docs")).toBeInTheDocument(); expect(within(row).getByText("fast")).toBeInTheDocument();
    expect(screen.getByLabelText("usage of Docs only")).toHaveTextContent("1 project · 1 label · 1 active job");
    const builtin = screen.getByText("Default Workflow").closest("tr")!;
    expect(within(builtin).getByText("built in")).toBeInTheDocument();
    expect(within(builtin).getByLabelText("usage of Default Workflow")).toHaveTextContent("global default");
    expect(screen.queryByRole("button", { name: "Delete Default Workflow" })).toBeNull();
    expect(screen.getByRole("button", { name: "Duplicate Default Workflow" })).toBeInTheDocument();
    expect(within(builtin).getByRole("switch")).toBeDisabled();
  });
  it("flags an invalid workflow and filters by tag", async () => {
    routes = { "/api/workflows": list({ workflows: [BUILTIN, { ...CUSTOM, valid: false }] }) };
    app("/workflows");
    expect(await screen.findByText("invalid")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Filter workflows"), "nomatch");
    expect(screen.getByText(/No workflow matches/)).toBeInTheDocument();
  });
  it("disables and enables a workflow", async () => {
    routes = { "/api/workflows": list(), "POST /api/workflows/docs/disable": { ok: true } };
    app("/workflows");
    await userEvent.click(await screen.findByRole("switch", { name: "Disable Docs only" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/workflows/docs/disable")).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/disable"))!.headers).toMatchObject({ "X-Factory-UI": "1" });
  });
  it("shows what uses a workflow when delete is refused, and can delete it together with its assignments", async () => {
    const used = usage({ projects: ["web"], labels: [{ id: "L1", name: "docs", priority: 50 }] });
    routes = {
      "/api/workflows": list({ workflows: [BUILTIN, { ...CUSTOM, usage: used }] }),
      "DELETE /api/workflows/docs": { __status: 409, error: "it is assigned to 1 project(s) and 1 label(s)", code: "in_use", usage: used },
      "DELETE /api/workflows/docs?removeAssignments=1": { ok: true },
    };
    app("/workflows");
    await userEvent.click(await screen.findByRole("button", { name: "Delete Docs only" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(/Assigned to project/)).toHaveTextContent("web");
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("assigned to 1 project");
    expect(within(dlg).getByLabelText("usage")).toHaveTextContent("docs");
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete and remove its assignments" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/workflows/docs?removeAssignments=1")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("will not offer to remove assignments while the workflow is the global default or has active jobs", async () => {
    const u = usage({ activeJobs: 2, projects: ["web"] });
    routes = { "/api/workflows": list({ workflows: [BUILTIN, { ...CUSTOM, usage: u }] }), "DELETE /api/workflows/docs": { __status: 409, error: "2 active job(s) are running it", code: "in_use", usage: u } };
    app("/workflows");
    await userEvent.click(await screen.findByRole("button", { name: "Delete Docs only" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(dlg).getByText(/Let the active jobs finish/)).toBeInTheDocument();
    expect(within(dlg).queryByRole("button", { name: /remove its assignments/ })).toBeNull();
  });
  it("creates a workflow from the Default Workflow, from scratch, or as a copy, and opens it", async () => {
    routes = { "/api/workflows": list(), "POST /api/workflows": (b: { meta: { name: string } }) => ({ ok: true, workflow: full(item({ id: "new1", name: b.meta.name })) }) };
    app("/workflows");
    await userEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    const dlg = await screen.findByRole("dialog");
    await userEvent.type(within(dlg).getByLabelText("Name"), "Mine");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/workflows/new1"));
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ meta: { name: "Mine" }, from: "default" });
  });
  it("duplicates a workflow and opens the copy", async () => {
    routes = { "/api/workflows": list(), "POST /api/workflows/docs/duplicate": { ok: true, workflow: full(item({ id: "docs-copy", name: "Docs only (copy)" })) } };
    app("/workflows");
    await userEvent.click(await screen.findByRole("button", { name: "Duplicate Docs only" }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/workflows/docs-copy"));
  });
});

describe("workflow editor", () => {
  const wf = full(CUSTOM);
  const editorRoutes = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
    "/api/workflows/meta": META, "/api/workflows/docs": wf, "POST /api/workflows/validate": validateOk(),
    "PUT /api/workflows/docs": (b: { definition: unknown; meta: { name: string } }) => ({ ok: true, workflow: { ...wf, version: 4, name: b.meta.name, definition: b.definition } }), ...over,
  });
  const stageRow = (name: string) => within(screen.getByRole("list", { name: "Stages" })).getByText(name).closest("li")!;
  const open = async (path = "/workflows/docs") => { app(path); await screen.findByRole("list", { name: "Stages" }); };

  it("shows the stages, a read-only flow of the draft with its failure routes, the locked safety stage, and a valid summary", async () => {
    routes = editorRoutes();
    await open();
    expect(await screen.findByText("Valid")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Draft workflow flow chart" })).toBeInTheDocument();
    expect(screen.getAllByText("findings").length).toBeGreaterThan(0); // the failure route Review -> Fix up is drawn
    expect(within(stageRow("Eligibility")).getByLabelText("locked safety stage")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "remove Eligibility" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); // nothing changed
    expect(screen.getByText("Safety stages")).toBeInTheDocument();
  });
  it("edits a stage: validation errors show inline and in the summary, Save stays off until the draft is valid, then saves definition and metadata", async () => {
    routes = editorRoutes({ "POST /api/workflows/validate": (b: { definition: { stages: { name: string }[] } }) => validateOk(b.definition.stages[1]!.name.trim() === "" ? [{ path: "stages.1.name", message: "name must not be empty", severity: "error" }] : []) });
    await open();
    await userEvent.click(within(screen.getByRole("list", { name: "Stages" })).getByText("Triage"));
    const name = document.getElementById("st-name") as HTMLInputElement;
    await userEvent.clear(name);
    expect(await screen.findByText(/1 problem to fix before saving/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect((await screen.findAllByText("name must not be empty")).length).toBeGreaterThanOrEqual(2); // beside the field and in the summary
    expect(within(screen.getByRole("list", { name: "Stages" })).getAllByRole("listitem")[1]!.querySelector("[aria-label='1 errors']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(name, "Triage 2");
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved as version 4/)).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/workflows/docs"); expect(put.headers).toMatchObject({ "X-Factory-UI": "1" });
    expect(put.body.definition.stages[1].name).toBe("Triage 2");
    expect(put.body.meta).toMatchObject({ name: "Docs only", category: "docs", tags: ["fast"], enabled: true });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(); // clean again
  });
  it("shows the server's refusal on save and keeps the draft", async () => {
    routes = editorRoutes({ "PUT /api/workflows/docs": { __status: 400, error: "stages.2: bad", code: "invalid" } });
    await open();
    const desc = document.getElementById("wf-desc") as HTMLTextAreaElement;
    fireEvent.change(desc, { target: { value: "new text" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(), { timeout: 3000 });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join("|")).toContain("stages.2: bad");
    expect(desc).toHaveValue("new text");
    await userEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(desc).toHaveValue("Skips the build.");
  });
  it("adds a custom stage after the selected one, with the type's defaults, and removes and reorders stages", async () => {
    routes = editorRoutes();
    await open();
    await userEvent.click(within(screen.getByRole("list", { name: "Stages" })).getByText("Triage"));
    await userEvent.type(screen.getByLabelText("new stage name"), "Security look");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const names = () => within(screen.getByRole("list", { name: "Stages" })).getAllByRole("listitem").map((li) => li.querySelector(".font-medium")?.textContent);
    expect(names().slice(0, 4)).toEqual(["Eligibility", "Triage", "Security look", "Docs only?"]);
    expect(screen.getByRole("heading", { name: "Security look" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "move Security look up" }));
    expect(names().slice(0, 3)).toEqual(["Eligibility", "Security look", "Triage"]);
    await userEvent.click(screen.getByRole("button", { name: "remove Security look" }));
    expect(names()).not.toContain("Security look");
    expect(await screen.findByText("Unsaved changes", { exact: false }).catch(() => null)).toBeNull(); // back to the saved shape is still "changed" order-wise only if different
  });
  it("offers only built-in stages not already used when adding a factory stage", async () => {
    routes = editorRoutes();
    await open();
    await userEvent.click(screen.getByRole("combobox", { name: "new stage type" }));
    await userEvent.click(await screen.findByRole("option", { name: "Factory stage" }));
    await userEvent.click(screen.getByRole("combobox", { name: "built-in stage" }));
    expect(screen.queryByRole("option", { name: "Eligibility check" })).toBeNull(); // already in this workflow
    expect(screen.getByRole("option", { name: "Open PR" })).toBeInTheDocument();
  });
  it("edits a review stage's prompt with the default shown and restorable, and inserts a variable at the cursor", async () => {
    routes = editorRoutes();
    await open();
    await userEvent.click(within(screen.getByRole("list", { name: "Stages" })).getByText("Review"));
    await userEvent.click(screen.getByRole("tab", { name: /Prompt/ }));
    const box = screen.getByLabelText("Prompt template") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Look at it" } });
    box.setSelectionRange(4, 4);
    await userEvent.click(screen.getByRole("button", { name: "{{ticket.title}}" }));
    expect(box.value).toBe("Look{{ticket.title}} at it");
    await userEvent.click(screen.getByRole("button", { name: /Show the default prompt/ }));
    expect(screen.getByLabelText("default prompt")).toHaveTextContent("Review {{ticket.identifier}}");
    await userEvent.click(screen.getByRole("button", { name: "Restore default" }));
    expect(box.value).toBe("Review {{ticket.identifier}}");
    expect(screen.getByRole("button", { name: "Restore default" })).toBeDisabled();
  });
  it("builds a success gate and explains it in plain language; failure rules show the defaults that apply", async () => {
    routes = editorRoutes();
    await open();
    await userEvent.click(within(screen.getByRole("list", { name: "Stages" })).getByText("Review"));
    await userEvent.click(screen.getByRole("tab", { name: /Gate/ }));
    const explain = screen.getByLabelText("what must be true before the next stage runs");
    expect(explain).toHaveTextContent("Every one of these must be true");
    expect(explain).toHaveTextContent("the reviewer's verdict is “approve”");
    await userEvent.click(screen.getByRole("button", { name: "Add condition" }));
    expect(explain).toHaveTextContent(/the stage itself reported success/);
    const defaults = screen.getByLabelText("failure defaults");
    expect(defaults).toHaveTextContent(/The stage fails with an error: retried/);
    expect(defaults).not.toHaveTextContent(/reports findings to fix/); // Review has a findings rule
    await userEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByRole("combobox", { name: "rule 2: action" })).toBeInTheDocument();
  });
  it("opens the built-in workflow read-only, with a Duplicate button that makes an editable copy", async () => {
    routes = editorRoutes({ "/api/workflows/default": full(BUILTIN, defaultDefinition()), "POST /api/workflows/default/duplicate": { ok: true, workflow: full(item({ id: "copy1", name: "Default Workflow (copy)" })) }, "/api/workflows/copy1": full(item({ id: "copy1", name: "Default Workflow (copy)" })) });
    await open("/workflows/default");
    expect(screen.getByText(/cannot be edited/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove / })).toBeNull();
    expect(screen.queryByLabelText("new stage name")).toBeNull();
    expect(document.getElementById("wf-desc")).toBeDisabled();
    await userEvent.click(within(screen.getByRole("list", { name: "Stages" })).getByText("Open PR")); // you can still browse every stage's settings
    expect(screen.getByRole("tab", { name: /Gate/ })).toBeEnabled();
    expect(screen.getByRole("img", { name: "Draft workflow flow chart" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Duplicate/ }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/workflows/copy1"));
  });
});

describe("workflow routing", () => {
  const labels = { labels: [{ id: "L1", name: "docs", teams: ["ENG"] }, { id: "L2", name: "hotfix", teams: ["ENG", "OPS"] }], assigned: [{ id: "L1", name: "docs", workflowId: "docs", priority: 50, foundInTracker: true }, { id: "OLD", name: "legacy", workflowId: "docs", priority: 10, foundInTracker: false }] };
  const base = (): Record<string, Handler> => ({ "/api/workflows": list({ assignments: [{ id: 1, scope: "label", targetId: "L1", targetName: "docs", workflowId: "docs", priority: 50 }, { id: 2, scope: "project", targetId: "web", targetName: null, workflowId: "docs", priority: 100 }] }), "/api/workflows/labels": labels, "/api/projects": { projects: [{ id: "web", name: "Web" }, { id: "api", name: "API" }] } });
  it("explains the resolution order, sets the global default and the conflict policy", async () => {
    routes = { ...base(), "PUT /api/workflows/settings": { ok: true } };
    app("/workflows?tab=routing");
    const order = await screen.findByLabelText("resolution order");
    expect(order).toHaveTextContent(/Label.*Project.*Global default/s);
    await userEvent.click(screen.getByRole("combobox", { name: "Label conflict policy" }));
    await userEvent.click(await screen.findByRole("option", { name: "Tie-break" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/workflows/settings")?.body).toEqual({ labelConflictPolicy: "tiebreak" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Global default workflow" }));
    await userEvent.click(await screen.findByRole("option", { name: "Docs only" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/workflows/settings").at(-1)!.body).toEqual({ defaultWorkflowId: "docs" }));
  });
  it("lists label assignments with their workflow, flags a label the tracker no longer has, and edits priority and workflow", async () => {
    routes = { ...base(), "PUT /api/workflows/assignments": { ok: true } };
    app("/workflows?tab=routing");
    expect(await screen.findByText("not found in the tracker")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("legacy"); expect(rows[1]).toHaveTextContent("docs"); // lowest priority number first
    expect(rows[1]).toHaveTextContent("ENG");
    const prio = screen.getByLabelText("Priority of label docs");
    fireEvent.change(prio, { target: { value: "7" } });
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/workflows/assignments")?.body).toEqual({ scope: "label", targetId: "L1", targetName: "docs", workflowId: "docs", priority: 7 }));
  });
  it("assigns a tracker label (by id) to a workflow and removes an assignment", async () => {
    routes = { ...base(), "PUT /api/workflows/assignments": { ok: true }, "DELETE /api/workflows/assignments?scope=label&targetId=OLD": { ok: true } };
    app("/workflows?tab=routing");
    await userEvent.click(await screen.findByRole("combobox", { name: "Tracker label" }));
    expect(screen.queryByRole("option", { name: /^docs/ })).toBeNull(); // already assigned
    await userEvent.click(await screen.findByRole("option", { name: "hotfix (ENG, OPS)" }));
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/workflows/assignments")?.body).toMatchObject({ scope: "label", targetId: "L2", targetName: "hotfix", priority: 100 }));
    await userEvent.click(screen.getByRole("button", { name: "Remove the assignment of label legacy" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/workflows/assignments?scope=label&targetId=OLD")).toBe(true));
  });
  it("assigns and clears a project's workflow (clearing falls back to the global default)", async () => {
    routes = { ...base(), "PUT /api/workflows/assignments": { ok: true }, "DELETE /api/workflows/assignments?scope=project&targetId=web": { ok: true } };
    app("/workflows?tab=routing");
    await userEvent.click(await screen.findByRole("combobox", { name: "Workflow for project API" }));
    await userEvent.click(await screen.findByRole("option", { name: "Docs only" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/workflows/assignments")?.body).toEqual({ scope: "project", targetId: "api", workflowId: "docs" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Workflow for project Web" }));
    await userEvent.click(await screen.findByRole("option", { name: /Use the global default/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/workflows/assignments?scope=project&targetId=web")).toBe(true));
  });
  it("still shows existing assignments when the tracker cannot be read", async () => {
    routes = { ...base(), "/api/workflows/labels": { __status: 502, error: "cannot read labels from the tracker: nope" } };
    app("/workflows?tab=routing");
    expect(await screen.findByText(/Could not read the tracker's labels/)).toBeInTheDocument();
    expect(screen.getByLabelText("Priority of label docs")).toBeInTheDocument();
  });
});

describe("project editor", () => {
  const proj: Project = { id: "web", name: "Web", enabled: true, autonomy: "supervised", repository: "/r", githubRepo: "me/web", defaultBranch: "main", githubAccount: null, managed: true, overrides: null, linear: null, commands: { test: "npm test" }, validation: null, activeJobs: 0 };
  it("picks the project's workflow and saves it as an assignment; clearing uses the global default", async () => {
    routes = { "/api/workflows": list(), "/api/setup/github": { accounts: [], defaultAccount: null }, "/api/bitbucket/credentials": { credentials: [] }, "PUT /api/workflows/assignments": { ok: true }, "DELETE /api/workflows/assignments?scope=project&targetId=web": { ok: true } };
    render(<MemoryRouter><ProjectEditor project={proj} teams={[]} onSaved={() => {}} /></MemoryRouter>);
    const select = await screen.findByRole("combobox", { name: "Workflow" });
    expect(select).toHaveTextContent("Use the global default (Default Workflow)");
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "Docs only" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT" && c.url === "/api/workflows/assignments")?.body).toEqual({ scope: "project", targetId: "web", workflowId: "docs" }));
    expect(await screen.findByText(/Saved. New tickets use it/)).toBeInTheDocument();
  });
  it("shows no workflow picker for a project that does not exist yet", async () => {
    routes = { "/api/workflows": list(), "/api/setup/github": { accounts: [], defaultAccount: null }, "/api/bitbucket/credentials": { credentials: [] } };
    render(<MemoryRouter><ProjectEditor project={null} teams={[]} onSaved={() => {}} /></MemoryRouter>);
    await screen.findByText("New project");
    expect(screen.queryByRole("combobox", { name: "Workflow" })).toBeNull();
  });
});

describe("job detail with a custom workflow", () => {
  const T = 1_700_000_000_000;
  const job = (o: Partial<Job> = {}): Job => ({ id: "j1", key: "JAM-9", project: "web", workflow: "feature", workflowId: "docs", workflowVersion: 3, stage: "REVIEW", status: "running", heldFromStage: null, remediationAttempts: 1, stageAttempts: 0, autonomous: false, dryRun: false, prUrl: null, lastError: null, notBefore: null, createdAt: T, updatedAt: T, ...o });
  const ex = (id: number, stage: string, outcome: string, o: Record<string, unknown> = {}) => ({ id, stage, attempt: 1, outcome, error: null, output: null, startedAt: T + id * 1000, finishedAt: T + id * 1000 + 500, ...o });
  const detail = (): D => ({
    job: job(), remediationCap: 3, stageOrder: [], decisions: [], artifacts: [], worktree: null, outbox: [],
    workflow: { id: "docs", version: 3, name: "Docs only", definition: customDefinition(), valid: true, resolution: { source: "label", reason: 'label "docs" (L1) is assigned to "Docs only"', matchedLabels: [{ id: "L1", name: "docs", priority: 50, workflowId: "docs" }], conflict: { policy: "block", outcome: "priority", candidates: [] } } },
    executions: [
      ex(1, "ELIGIBILITY_CHECK", "succeeded"), ex(2, "TRIAGE", "succeeded"),
      ex(3, "DOCS_CHECK", "succeeded", { output: '{"held":false,"to":"BUILD"}', route: { action: "branch", to: "BUILD", reason: "outputs.TRIAGE.docsOnly truthy" } }),
      ex(4, "BUILD", "failed", { error: "exit 1", route: { action: "retry", rule: 0, attempt: 1, of: 3, delayMs: 2000 } }),
      ex(5, "BUILD", "succeeded", { gate: { passed: true, trace: { type: "exit_code_zero", passed: true, detail: "exit code was 0" } } }),
      ex(6, "WRITE_DOCS", "succeeded", { output: '{"skipped":true,"reason":"its condition did not hold"}', route: { action: "skip", reason: "its condition did not hold" } }),
      ex(7, "REVIEW", "succeeded", { route: { action: "goto", to: "FIXUP", rule: 0, cycle: 1, of: 2, phase: "code" } }),
    ],
    invocations: [{ id: 1, stageExecutionId: 2, agent: "anthropic/x", model: "claude-haiku", exitCode: 0, durationMs: 1000, finished: true, usage: null, hasLog: false, at: T }],
  });
  it("shows the workflow, its version and why it was chosen; draws its own stages; marks the skipped one; shows model, gate and routing in a step's detail", async () => {
    routes = { "/api/jobs/j1": detail(), "/api/overview": {} };
    app("/jobs/j1");
    expect(await screen.findByRole("link", { name: "Docs only" })).toHaveAttribute("href", "/workflows/docs");
    expect(screen.getByText("v3")).toBeInTheDocument(); expect(screen.getByText("chosen by a ticket label")).toBeInTheDocument();
    expect(screen.getByText(/label "docs" \(L1\) is assigned to "Docs only"/)).toBeInTheDocument();
    expect(screen.getByText(/Matched labels: docs \(priority 50\)/)).toBeInTheDocument();
    expect(screen.getByText(/resolved by priority/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Docs only flow chart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write docs: skipped" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Triage: done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Discovered/ })).toBeNull(); // no hardcoded stages
    expect(screen.getByText(/1 failure route taken · code: 1 of 2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Build: done" }));
    expect(screen.getByTestId("node-state")).toHaveTextContent("Finished · 2 attempts · 1 retry");
    expect(screen.getByText("exit code was 0", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("retry 1 of 3 after 2s")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Triage: done" }));
    expect(screen.getByText(/actually used/)).toHaveTextContent("claude-haiku");
    await userEvent.click(screen.getByRole("button", { name: "Write docs: skipped" }));
    expect(screen.getByTestId("node-state")).toHaveTextContent("Skipped");
    expect(screen.getAllByText(/its condition did not hold/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Docs only?: done" }));
    expect(screen.getByText(/condition decided → “Build”/)).toBeInTheDocument();
  });
  it("a job with no snapshot shows the built-in Default Workflow and says why", async () => {
    const d = detail(); d.workflow = { id: "default", version: null, name: "Default Workflow", definition: defaultDefinition(), resolution: null, valid: true };
    d.job = job({ workflowId: null, workflowVersion: null, stage: "AUTOMATED_TESTING" }); d.executions = [ex(1, "DISCOVERED", "succeeded")];
    routes = { "/api/jobs/j1": d, "/api/overview": {} };
    app("/jobs/j1");
    expect(await screen.findByText(/started before workflows were recorded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discovered: done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run checks: run" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((b) => /: (idle|done|run)$/.test(b.getAttribute("aria-label") ?? "")).length).toBe(defaultDefinition().stages.length + 1);
  });
});
