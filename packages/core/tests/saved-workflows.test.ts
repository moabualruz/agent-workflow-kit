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

  test("command service passes args to project saved workflow files", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-saved-workflows-"));
    try {
      const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "args-probe.js"), `
export default function ({ args }) {
  return { args };
}
`);
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow("args-probe", { tenantId: "tenant-1" });

      expect(run).toEqual(expect.objectContaining({
        name: "args-probe",
        status: "completed",
        result: { args: { tenantId: "tenant-1" } },
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

  test("command service runs Claude-style workflow script bodies with scriptPath children", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-claude-style-workflows-"));
    try {
      const childPath = join(projectRoot, "child.workflow.js");
      const parentPath = join(projectRoot, "parent.workflow.js");

      writeFileSync(childPath, `
export const meta = { name: "child", phases: [{ title: "Child" }] };
phase("Child");
return { childArg: args.childArg };
`);
      writeFileSync(parentPath, `
export const meta = { name: "parent", phases: [{ title: "Parent" }] };
phase("Parent");
const child = await workflow({ scriptPath: ${JSON.stringify(childPath)} }, { childArg: args.parentArg });
return { source: "claude-style", child };
`);
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow(parentPath, { parentArg: "from-parent" });
      const events = service.eventsFor(run.runId);

      expect(run).toEqual(expect.objectContaining({
        name: "parent.workflow",
        status: "completed",
        result: {
          source: "claude-style",
          child: { childArg: "from-parent" },
        },
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "phase",
        title: "Parent",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "phase",
        title: "child.workflow",
        kind: "child",
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "phase",
        title: "Child",
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("command service resolves named project workflow executors from scripts/workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-project-workflows-"));
    try {
      const workflowsRoot = join(projectRoot, "scripts", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "project-library.workflow.js"), `
export const meta = { name: "project-library", phases: [{ title: "Project Library" }] };
phase("Project Library");
return { args };
`);
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow("project-library", { project: "ok" });

      expect(run).toEqual(expect.objectContaining({
        name: "project-library",
        status: "completed",
        result: { args: { project: "ok" } },
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("command service falls back to personal Claude workflow files and keeps project precedence", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-project-workflows-"));
    const homeRoot = mkdtempSync(join(tmpdir(), "awk-home-workflows-"));
    try {
      const projectWorkflowsRoot = join(projectRoot, ".claude", "workflows");
      const personalWorkflowsRoot = join(homeRoot, ".claude", "workflows");
      mkdirSync(projectWorkflowsRoot, { recursive: true });
      mkdirSync(personalWorkflowsRoot, { recursive: true });
      writeFileSync(join(projectWorkflowsRoot, "same-name.js"), `
export default function () {
  return { source: "project" };
}
`);
      writeFileSync(join(personalWorkflowsRoot, "same-name.js"), `
export default function () {
  return { source: "personal" };
}
`);
      writeFileSync(join(personalWorkflowsRoot, "personal-only.js"), `
export default function () {
  return { source: "personal-only" };
}
`);
      const service = createWorkflowCommandService({ projectRoot, homeRoot });

      const projectRun = await service.runSavedWorkflow("same-name");
      const personalRun = await service.runSavedWorkflow("personal-only");

      expect(projectRun).toEqual(expect.objectContaining({
        name: "same-name",
        status: "completed",
        result: { source: "project" },
      }));
      expect(personalRun).toEqual(expect.objectContaining({
        name: "personal-only",
        status: "completed",
        result: { source: "personal-only" },
      }));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });
});
