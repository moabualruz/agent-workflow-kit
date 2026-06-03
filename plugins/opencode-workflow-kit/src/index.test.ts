import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowKitPlugin from "./index";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("opencode workflow kit plugin", () => {
  test("workflow_run native tool exposes structured workflow args", async () => {
    const server = await workflowKitPlugin.server({ directory: process.cwd() } as any);
    const workflowRun = (server.tool as any).workflow_run;
    const argsSchema = workflowRun.args.args as any;

    expect(workflowRun.args.workflow).toBeDefined();
    expect(argsSchema).toBeDefined();
    expect(argsSchema.safeParse({ tenantId: "tenant-1" }).success).toBe(true);
    expect(argsSchema.safeParse(["tenant-1"]).success).toBe(true);
    expect(argsSchema.safeParse("tenant-1").success).toBe(true);
  });

  test("workflow_run asks OpenCode permission with dynamic workflow preview", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-opencode-permission-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    const scriptPath = join(workflowsRoot, "approval-probe.js");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(scriptPath, `
export default async function ({ agent }) {
  return agent("approval probe", { isolation: "worktree" });
}
`);
    const server = await workflowKitPlugin.server({ directory: projectRoot } as any);
    const askCalls: unknown[] = [];

    const run = JSON.parse(String(await (server.tool as any).workflow_run.execute({
      workflow: "approval-probe",
      args: { tenantId: "tenant-1" },
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
      ask: async (input: unknown) => {
        askCalls.push(input);
      },
    } as any)));

    expect(run.status).toBe("completed");
    expect(askCalls).toEqual([
      expect.objectContaining({
        permission: "agent-workflow-kit.workflow",
        patterns: expect.arrayContaining([
          "workflow:approval-probe",
          `script:${scriptPath}`,
          "origin:saved",
          "write:worktree",
        ]),
        always: ["agent-workflow-kit.workflow"],
        metadata: expect.objectContaining({
          name: "approval-probe",
          approvalTitle: "Run workflow approval-probe",
          costCaution: "Workflow runs can launch multiple agents and consume more tokens than a normal turn.",
          actions: ["once", "always", "deny", "view-script"],
          scriptPath,
          argsPreview: "{\"tenantId\":\"tenant-1\"}",
          origin: "saved",
          generated: false,
          agentCountEstimate: 1,
          isolationHints: ["worktree"],
          writeHints: ["worktree"],
        }),
      }),
    ]);
  });

  test("workflow_run returns display summary in parsed JSON output", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-opencode-display-"));
    roots.push(projectRoot);
    const server = await workflowKitPlugin.server({ directory: projectRoot } as any);

    const run = JSON.parse(String(await (server.tool as any).workflow_run.execute({
      workflow: "no-write-probe",
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
    } as any)));

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "completed",
      display: expect.objectContaining({
        summary: "1/1 agents done, 3 tokens",
        actions: [{ id: "save", label: "Save workflow command", enabled: true }],
      }),
    }));
  });

  test("ultracode native tool returns display summary in parsed JSON output", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-opencode-ultracode-"));
    roots.push(projectRoot);
    const server = await workflowKitPlugin.server({ directory: projectRoot } as any);

    const status = JSON.parse(String(await (server.tool as any).ultracode.execute({
      action: "status",
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
    } as any)));

    expect(status).toEqual(expect.objectContaining({
      ultracode: false,
      display: expect.objectContaining({
        title: "Ultracode",
        status: "disabled",
        actions: expect.arrayContaining([{ id: "enable", label: "Enable ultracode", enabled: true }]),
      }),
    }));
  });

  test("workflow_run fails closed when OpenCode denies dynamic workflow permission", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-opencode-deny-"));
    roots.push(projectRoot);
    const server = await workflowKitPlugin.server({ directory: projectRoot } as any);

    const run = JSON.parse(String(await (server.tool as any).workflow_run.execute({
      workflow: "no-write-probe",
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
      ask: async () => {
        throw new Error("denied by OpenCode");
      },
    } as any)));

    expect(run).toEqual(expect.objectContaining({
      name: "no-write-probe",
      status: "failed",
      error: "OpenCode permission denied: denied by OpenCode",
    }));
  });
});
