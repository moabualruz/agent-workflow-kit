import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowCommandService } from "../src/index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow command service", () => {
  test("runs, lists, stops, resumes, and reads workflow state from one shared service", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async () => ({ ok: true }),
    });

    const run = await service.runSavedWorkflow("no-write-probe");
    const listed = service.listRuns();
    const stopped = service.stopRun(run.runId);
    const resumed = service.resumeRun(run.runId);
    const status = service.getRun(run.runId);

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "completed",
      result: { ok: true },
    }));
    expect(listed).toContainEqual(expect.objectContaining({ runId: run.runId }));
    expect(stopped).toEqual(expect.objectContaining({ runId: run.runId, status: "stopped" }));
    expect(resumed).toEqual(expect.objectContaining({ runId: run.runId, status: "stopped" }));
    expect(status).toEqual(expect.objectContaining({ runId: run.runId, status: "stopped" }));
  });

  test("runs ad hoc and deep-research workflows without exposing transcript text", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({
      projectRoot,
      agent: async () => ({ ok: true }),
    });

    const workflow = await service.runAdHocWorkflow("inspect repo");
    const research = await service.runDeepResearch("compare workflow harnesses");

    expect(workflow.result).toEqual({ ok: true, task: "inspect repo" });
    expect(research.result).toEqual({ ok: true, question: "compare workflow harnesses" });
  });
});
