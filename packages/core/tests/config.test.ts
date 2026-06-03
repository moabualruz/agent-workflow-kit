import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowCommandService, readConfig, setUltracode, setWorkflowsDisabled, writeConfig } from "../src/index";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ultracode config toggle", () => {
  test("defaults to off and persists explicit on/off", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);

    expect(readConfig(projectRoot).ultracode).toBe(false);
    expect(readConfig(projectRoot).ultracodeKeywordTriggerEnabled).toBe(false);
    expect(readConfig(projectRoot).ultracodeEffortMode).toBe("off");
    expect(readConfig(projectRoot).disableWorkflows).toBe(false);
    expect(setUltracode(projectRoot, "status").ultracode).toBe(false);

    const on = setUltracode(projectRoot, "on");
    expect(on.ultracode).toBe(true);
    expect(on.standingOptIn).toBe(true);
    expect(on.keywordTriggerEnabled).toBe(true);
    expect(on.effortMode).toBe("orchestration-only");
    expect(on.effort).toEqual({
      modelEffort: "unsupported",
      orchestration: "enabled",
    });
    expect(existsSync(on.path)).toBe(true);
    expect(JSON.parse(readFileSync(on.path, "utf8")).ultracode).toBe(true);
    expect(JSON.parse(readFileSync(on.path, "utf8")).ultracodeKeywordTriggerEnabled).toBe(true);
    expect(JSON.parse(readFileSync(on.path, "utf8")).ultracodeEffortMode).toBe("orchestration-only");
    expect(readConfig(projectRoot).ultracode).toBe(true);

    expect(setUltracode(projectRoot, "off").ultracode).toBe(false);
    expect(readConfig(projectRoot).ultracodeKeywordTriggerEnabled).toBe(false);
    expect(readConfig(projectRoot).ultracodeEffortMode).toBe("off");
    expect(readConfig(projectRoot).ultracode).toBe(false);
  });

  test("status does not create config and does not flip the flag", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);

    const result = setUltracode(projectRoot, "status");
    expect(result.ultracode).toBe(false);
    expect(existsSync(result.path)).toBe(false);
  });

  test("service ultracode command toggles and validates the action", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);
    const service = createWorkflowCommandService({ projectRoot });

    expect(service.ultracode("on")).toEqual(expect.objectContaining({ ultracode: true, action: "on" }));
    expect(service.ultracode("status")).toEqual(expect.objectContaining({ ultracode: true, action: "status" }));
    expect(service.ultracode("off")).toEqual(expect.objectContaining({ ultracode: false, action: "off" }));
    expect(() => service.ultracode("nonsense")).toThrow("ultracode requires one of: on, off, status");
  });

  test("ultracode status reports workflow disablement without conflating effort support", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);
    setUltracode(projectRoot, "on");
    writeConfig(projectRoot, { ...readConfig(projectRoot), disableWorkflows: true });
    const service = createWorkflowCommandService({ projectRoot });

    expect(service.ultracode("status")).toEqual(expect.objectContaining({
      ultracode: true,
      standingOptIn: true,
      keywordTriggerEnabled: false,
      disabledReason: "project config",
      effortMode: "orchestration-only",
      effort: {
        modelEffort: "unsupported",
        orchestration: "disabled",
      },
    }));
  });

  test("disableWorkflows defaults off and persists explicit on/off", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);

    expect(readConfig(projectRoot).disableWorkflows).toBe(false);

    const disabled = setWorkflowsDisabled(projectRoot, "on");
    expect(disabled.disableWorkflows).toBe(true);
    expect(JSON.parse(readFileSync(disabled.path, "utf8")).disableWorkflows).toBe(true);
    expect(readConfig(projectRoot).disableWorkflows).toBe(true);

    expect(setWorkflowsDisabled(projectRoot, "off").disableWorkflows).toBe(false);
    expect(readConfig(projectRoot).disableWorkflows).toBe(false);
  });

  test("service denies workflow execution when project config disables workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);
    writeConfig(projectRoot, { ...readConfig(projectRoot), disableWorkflows: true });
    const service = createWorkflowCommandService({ projectRoot });

    const run = await service.runSavedWorkflow("no-write-probe");

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "Dynamic workflow execution disabled by project config",
    }));
  });

  test("service denies workflow execution when user config disables workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    const homeRoot = mkdtempSync(join(tmpdir(), "awk-home-config-"));
    roots.push(projectRoot, homeRoot);
    writeConfig(homeRoot, { ...readConfig(homeRoot), disableWorkflows: true });
    const service = createWorkflowCommandService({ projectRoot, homeRoot });

    const run = await service.runSavedWorkflow("no-write-probe");

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "Dynamic workflow execution disabled by user config",
    }));
  });

  test("service denies workflow execution when managed or session controls disable workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);

    const managed = await createWorkflowCommandService({
      projectRoot,
      managedDisableWorkflows: true,
    }).runSavedWorkflow("no-write-probe");
    const session = await createWorkflowCommandService({
      projectRoot,
      sessionDisableWorkflows: true,
    }).runSavedWorkflow("no-write-probe");

    expect(managed).toEqual(expect.objectContaining({
      status: "failed",
      error: "Dynamic workflow execution disabled by managed policy",
    }));
    expect(session).toEqual(expect.objectContaining({
      status: "failed",
      error: "Dynamic workflow execution disabled by session override",
    }));
  });

  test("disable hierarchy reports the highest-priority active source", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    const homeRoot = mkdtempSync(join(tmpdir(), "awk-home-config-"));
    roots.push(projectRoot, homeRoot);
    writeConfig(projectRoot, { ...readConfig(projectRoot), disableWorkflows: true });
    writeConfig(homeRoot, { ...readConfig(homeRoot), disableWorkflows: true });
    const previous = process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS;
    process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS = "1";
    try {
      const run = await createWorkflowCommandService({
        projectRoot,
        homeRoot,
        managedDisableWorkflows: true,
        sessionDisableWorkflows: true,
      }).runSavedWorkflow("no-write-probe");

      expect(run.error).toBe("Dynamic workflow execution disabled by managed policy");
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS;
      else process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS = previous;
    }
  });

  test("service denies workflow execution when environment disables workflows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-config-"));
    roots.push(projectRoot);
    const previous = process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS;
    process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS = "1";
    try {
      const service = createWorkflowCommandService({ projectRoot });

      const run = await service.runSavedWorkflow("no-write-probe");

      expect(run).toEqual(expect.objectContaining({
        name: "no-write-probe",
        status: "failed",
        error: "Dynamic workflow execution disabled by environment",
      }));
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS;
      else process.env.AGENT_WORKFLOW_KIT_DISABLE_WORKFLOWS = previous;
    }
  });
});
