import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { JobsTable } from "@/components/JobsTable";
import type { Job } from "@/lib/types";

const job = (o: Partial<Job> = {}): Job => ({ id: "j", key: "JAM-1", project: "p", workflow: "feature", stage: "MERGING", status: "queued", heldFromStage: null, remediationAttempts: 0, stageAttempts: 0, autonomous: false, dryRun: false, prUrl: "https://github.com/o/r/pull/1", lastError: null, notBefore: 1, createdAt: 0, updatedAt: 0, ...o });
afterEach(cleanup);

describe("JobsTable status badge", () => {
  it("shows a job awaiting a human merge as done, and other queued jobs as queued", () => {
    render(<MemoryRouter><JobsTable jobs={[job(), job({ id: "k", key: "JAM-2", stage: "DISCOVERED" })]} /></MemoryRouter>);
    expect(screen.getAllByText("done")).toHaveLength(1);
    expect(screen.getAllByText("queued")).toHaveLength(1);
  });
});
