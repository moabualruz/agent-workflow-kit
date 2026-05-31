import { describe, expect, test } from "bun:test";
import workflowKitPlugin from "./index";

describe("opencode workflow kit plugin", () => {
  test("workflow_run native tool exposes structured workflow args", async () => {
    const server = await workflowKitPlugin.server({ directory: process.cwd() } as any);
    const workflowRun = (server.tool as any).workflow_run;
    const argsSchema = workflowRun.args.args as any;

    expect(workflowRun.args.workflow).toBeDefined();
    expect(argsSchema).toBeDefined();
    expect(argsSchema.safeParse({ tenantId: "tenant-1" }).success).toBe(true);
    expect(argsSchema.safeParse(["tenant-1"]).success).toBe(false);
  });
});
