import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryWorkflowRegistry, createWorkflowCommandService, type WorkflowScript } from "../src/index";

describe("saved workflow registry", () => {
  test("resolves saved workflow names without exposing project-specific paths", async () => {
    const script: WorkflowScript = async () => ({ saved: "ok" });
    const registry = createMemoryWorkflowRegistry();

    registry.save({ name: "probe-saved-workflow", script });

    const resolved = registry.resolve({ name: "probe-saved-workflow" });

    expect(resolved.name).toBe("probe-saved-workflow");
    expect(await resolved.script({} as never)).toEqual({ saved: "ok" });
  });

  test("project scope wins over personal scope for matching workflow names", () => {
    const registry = createMemoryWorkflowRegistry();

    registry.save({ scope: "personal", name: "same-name", script: async () => ({ source: "personal" }) });
    registry.save({ scope: "project", name: "same-name", script: async () => ({ source: "project" }) });

    expect(registry.resolve({ name: "same-name" }).scope).toBe("project");
  });

  test("command service runs project saved workflow files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-saved-workflows-"));
    try {
      const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "project-saved.js"), `
export default async function ({ phase, log, agent }) {
  phase("Saved File");
  log("project saved workflow entered");
  const result = await agent("project saved agent", { model: "harness/saved-worker" });
  return { source: "project", result };
}
`);
      const service = createWorkflowCommandService({
        projectRoot,
        agent: async (_prompt, options) => ({ ok: true, model: options?.model }),
      });

      const run = await service.runSavedWorkflow("project-saved");
      const events = service.eventsFor(run.runId);

      expect(run).toEqual(expect.objectContaining({
        name: "project-saved",
        status: "completed",
        result: { source: "project", result: { ok: true, model: "harness/saved-worker" } },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "phase",
        title: "Saved File",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "agent:start",
        model: "harness/saved-worker",
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("command service runs direct workflow script paths", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-saved-workflows-"));
    try {
      const scriptPath = join(projectRoot, "direct-path.js");
      writeFileSync(scriptPath, `
export default async function ({ phase, log }) {
  phase("Direct Path");
  log("direct path workflow entered");
  return { source: "script-path" };
}
`);
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow(scriptPath);
      const events = service.eventsFor(run.runId);

      expect(run).toEqual(expect.objectContaining({
        name: "direct-path",
        status: "completed",
        result: { source: "script-path" },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "phase",
        title: "Direct Path",
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
