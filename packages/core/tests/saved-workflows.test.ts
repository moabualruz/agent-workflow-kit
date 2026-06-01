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

  test("command service returns Claude save-dialog final expression values", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-claude-save-dialog-"));
    try {
      const workflowsRoot = join(projectRoot, ".claude", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "save-dialog.js"), `
export const meta = {
  name: 'save-dialog',
  description: 'Save dialog shape',
  phases: [
    { title: 'Probe' }
  ]
}

phase('Probe')
log('saved through Claude UI')

const result = { ok: true, source: 'save-dialog' }
result
`);
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow("save-dialog");

      expect(run).toEqual(expect.objectContaining({
        name: "save-dialog",
        status: "completed",
        result: { ok: true, source: "save-dialog" },
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

  test("Claude-style bodies cannot call Math.random() (determinism guard for resume)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-determinism-"));
    try {
      const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "rand.js"), `
export const meta = { name: "rand", phases: [{ title: "Rand" }] };
phase("Rand");
return { r: Math.random() };
`);
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow("rand");

      expect(run.status).toBe("failed");
      expect(run.error).toContain("Non-deterministic API is not allowed");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("Claude-style bodies cannot call Date.now() or new Date() but keep deterministic Date helpers", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-determinism-date-"));
    try {
      const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "now.js"), `
export const meta = { name: "now", phases: [{ title: "Now" }] };
phase("Now");
return { t: Date.now() };
`);
      writeFileSync(join(workflowsRoot, "parse.js"), `
export const meta = { name: "parse", phases: [{ title: "Parse" }] };
phase("Parse");
return { ms: Date.parse("2020-01-01T00:00:00Z") };
`);
      const service = createWorkflowCommandService({ projectRoot });

      const now = await service.runSavedWorkflow("now");
      expect(now.status).toBe("failed");
      expect(now.error).toContain("Non-deterministic API is not allowed");

      // Date.parse is deterministic and must still work.
      const parse = await service.runSavedWorkflow("parse");
      expect(parse.status).toBe("completed");
      expect(parse.result).toEqual({ ms: 1577836800000 });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("per-phase meta model is applied to agent calls within that phase", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-phase-model-"));
    try {
      const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "phased.js"), `
export const meta = {
  name: "phased",
  description: "phase model probe",
  model: "run-default",
  phases: [
    { title: "Review", model: "review-model" },
    { title: "Plain" }
  ]
};
phase("Review");
const a = await agent("review step");
phase("Plain");
const b = await agent("plain step");
return { a, b };
`);
      const service = createWorkflowCommandService({
        projectRoot,
        agent: async (_prompt, options) => ({ model: options?.model }),
      });

      const run = await service.runSavedWorkflow("phased");

      expect(run.status).toBe("completed");
      // Review phase → its phase model; Plain phase (no phase model) → run model.
      expect(run.result).toEqual({ a: { model: "review-model" }, b: { model: "run-default" } });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("Claude-style bodies do not get require injected (no casual filesystem use)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-determinism-fs-"));
    try {
      const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
      mkdirSync(workflowsRoot, { recursive: true });
      writeFileSync(join(workflowsRoot, "fs.js"), `
export const meta = { name: "fs", phases: [{ title: "Fs" }] };
phase("Fs");
return { has: typeof require };
`);
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow("fs");

      // require is undefined in the sandbox, so the body completes but cannot reach fs.
      expect(run.status).toBe("completed");
      expect(run.result).toEqual({ has: "undefined" });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
