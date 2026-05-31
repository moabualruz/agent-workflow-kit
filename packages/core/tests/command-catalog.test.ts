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
      { name: "args", kind: "object", required: false },
    ]);
    expect(workflowCommandToolInputSchema(workflowRun)).toEqual({
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        workflow: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
      required: ["workflow"],
      additionalProperties: false,
    });
  });
});
