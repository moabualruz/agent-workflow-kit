import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowCommandService,
  dispatchWorkflowCommand,
  workflowCommandToolInputSchema,
  workflowCommandCatalog,
  workflowCommandNames,
  workflowCommandToolInputs,
  workflowToolNames,
} from "../src/index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow command catalog", () => {
  test("owns every public command and native tool name in one place", () => {
    expect(workflowCommandNames).toEqual([
      "workflow",
      "workflow-run",
      "workflow-status",
      "workflow-events",
      "workflow-resume",
      "workflow-stop",
      "workflows",
      "deep-research",
      "ultracode",
    ]);
    expect(workflowToolNames).toEqual([
      "workflow",
      "workflow_run",
      "workflow_status",
      "workflow_events",
      "workflow_resume",
      "workflow_stop",
      "workflows",
      "deep_research",
      "ultracode",
    ]);
    expect(workflowCommandCatalog.map((command) => command.description.everywhere)).not.toContain("");
  });

  test("dispatches commands through the shared command service", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-catalog-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const run = await dispatchWorkflowCommand(service, "workflow-run", { workflow: "no-write-probe" });
    const events = await dispatchWorkflowCommand(service, "workflow-events", { runId: run.runId });

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "completed",
      result: { ok: true },
    }));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: run.runId, type: "run:started" }),
      expect.objectContaining({ runId: run.runId, type: "run:completed" }),
    ]));
  });

  test("owns native tool input contracts in the shared catalog", () => {
    const workflowRun = workflowCommandCatalog.find((command) => command.name === "workflow-run");
    if (!workflowRun) throw new Error("missing workflow-run command");

    expect(workflowCommandToolInputs(workflowRun)).toEqual([
      { name: "projectRoot", kind: "string", required: false },
      { name: "workflow", kind: "string", required: true },
      { name: "args", kind: "json", required: false },
      { name: "resumeFromRunId", kind: "string", required: false },
      { name: "detach", kind: "boolean", required: false },
    ]);
    expect(workflowCommandToolInputSchema(workflowRun)).toEqual({
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        workflow: { type: "string" },
        args: {
          anyOf: [
            { type: "object", additionalProperties: true },
            { type: "array" },
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "null" },
          ],
        },
        resumeFromRunId: { type: "string" },
        detach: { type: "boolean" },
      },
      required: ["workflow"],
      additionalProperties: false,
    });

    const ultracode = workflowCommandCatalog.find((command) => command.name === "ultracode");
    if (!ultracode) throw new Error("missing ultracode command");
    expect(workflowCommandToolInputs(ultracode)).toEqual([
      { name: "projectRoot", kind: "string", required: false },
      { name: "action", kind: "string", required: false },
    ]);
    expect(workflowCommandToolInputSchema(ultracode)).toEqual({
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        action: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    });
  });

  test("dispatch exposes detached workflow-run for native host tools", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-catalog-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const run = await dispatchWorkflowCommand(service, "workflow-run", {
      workflow: "no-write-probe",
      detach: true,
    });

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "running",
    }));
  });

  test("workflow-run dispatch passes list args as structured workflow data", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-catalog-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const run = await dispatchWorkflowCommand(service, "workflow-run", {
      workflow: "no-write-probe",
      args: ["1024", "1025"],
    });

    expect(run.args).toEqual(["1024", "1025"]);
  });

  test("workflow-run dispatch can resume from a prior run through the same invocation input", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-catalog-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const first = await dispatchWorkflowCommand(service, "workflow-run", {
      workflow: "no-write-probe",
    });
    const resumed = await dispatchWorkflowCommand(service, "workflow-run", {
      workflow: "no-write-probe",
      resumeFromRunId: first.runId,
    });

    expect(resumed).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "completed",
    }));
    expect(resumed.runId).not.toBe(first.runId);
    expect(service.eventsFor(resumed.runId).some((event) => event.type === "agent:cached")).toBe(true);
  });

  test("workflow-run dispatch rejects non-JSON args", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-catalog-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    await expect(dispatchWorkflowCommand(service, "workflow-run", {
      workflow: "no-write-probe",
      args: new Date("2026-06-03T00:00:00Z"),
    })).rejects.toThrow("workflow-run args must be JSON data");
  });
});
