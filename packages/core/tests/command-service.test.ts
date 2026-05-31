import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowCommandService, denyDynamicWorkflowPolicy } from "../src/index";

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

    expect(workflow.result).toEqual(expect.objectContaining({ ok: true, task: "inspect repo" }));
    expect(research.result).toEqual({ ok: true, question: "compare workflow harnesses" });
  });

  test("ad hoc workflow persists a generated workflow that workflow-run can invoke", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    const generated = await service.runAdHocWorkflow("inspect repo");
    const workflow = (generated.result as any).workflow;

    expect(workflow).toEqual({
      name: "inspect-repo",
      path: join(projectRoot, ".agent-workflow-kit", "workflows", "inspect-repo.js"),
    });
    expect(existsSync(workflow.path)).toBe(true);

    const rerun = await service.runSavedWorkflow(workflow.name);

    expect(rerun).toEqual(expect.objectContaining({
      name: "inspect-repo",
      status: "completed",
      result: { ok: true, task: "inspect repo" },
    }));
  });

  test("applies permission policy before running saved workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({
      projectRoot,
      permissionPolicy: denyDynamicWorkflowPolicy,
    });

    const run = await service.runSavedWorkflow("no-write-probe");

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "Dynamic workflow execution denied by permission policy",
    }));
  });

  test("default agent returns schema-shaped values for structural workflow runs", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-command-service-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "schema-default.js"), `
export default async function ({ agent }) {
  return agent("schema default", {
    schema: {
      type: "object",
      required: ["items", "decision", "count", "ok"],
      properties: {
        items: { type: "array", items: { type: "string" } },
        decision: { type: "string", enum: ["skip", "run"] },
        count: { type: "integer" },
        ok: { type: "boolean" },
        nested: {
          type: "object",
          properties: {
            note: { type: "string" }
          }
        }
      }
    }
  });
}
`);
    const service = createWorkflowCommandService({ projectRoot });

    const run = await service.runSavedWorkflow("schema-default");

    expect(run.result).toEqual({
      items: [],
      decision: "skip",
      count: 0,
      ok: false,
      nested: { note: "" },
    });
  });
});
