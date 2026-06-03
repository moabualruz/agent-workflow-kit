import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowKitExtension from "./index";

describe("pi workflow kit extension", () => {
  test("registers workflow message renderer when the host supports native rendering", () => {
    const renderers: Array<{ type: string; renderer: (entry: unknown) => string[] }> = [];

    const extension = workflowKitExtension({
      registerMessageRenderer: (type, renderer) => {
        renderers.push({ type, renderer });
      },
    });

    expect(extension.name).toBe("pi-workflow-kit");
    expect(renderers.map((renderer) => renderer.type)).toContain("agent-workflow-kit.workflow");
    expect(renderers[0]?.renderer({
      data: {
        runId: "wf_pi",
        name: "no-write-probe",
        status: "completed",
        display: { summary: "1/1 agents done", actions: [{ id: "save", enabled: true }] },
      },
    })).toEqual([
      "wf_pi no-write-probe completed",
      "summary: 1/1 agents done",
      "actions: save",
    ]);
  });

  test("workflow_run native tool exposes structured workflow args", () => {
    const extension = workflowKitExtension();
    const workflowRun = extension.tools.find((tool) => tool.name === "workflow_run");

    expect(workflowRun?.parameters).toEqual(expect.objectContaining({
      type: "object",
      properties: expect.objectContaining({
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
      }),
      required: ["workflow"],
    }));
  });

  test("workflow_run native tool returns display details while preserving machine-readable JSON", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-pi-display-"));
    const extension = workflowKitExtension();
    const workflowRun = extension.tools.find((tool) => tool.name === "workflow_run");

    try {
      const result = await workflowRun?.execute("call-display", { workflow: "no-write-probe", projectRoot });

      expect(result?.details).toEqual(expect.objectContaining({
        name: "no-write-probe",
        status: "completed",
        display: expect.objectContaining({
          summary: "1/1 agents done, 3 tokens",
          actions: [{ id: "save", label: "Save workflow command", enabled: true }],
        }),
      }));
      expect(result?.content[0]?.text).toContain("\"display\"");
      expect(result?.content[0]?.text).toContain("\"status\":\"completed\"");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("ultracode native tool returns display details while preserving machine-readable JSON", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-pi-ultracode-"));
    const extension = workflowKitExtension();
    const ultracode = extension.tools.find((tool) => tool.name === "ultracode");

    try {
      const result = await ultracode?.execute("call-ultracode", { action: "status", projectRoot });

      expect(result?.details).toEqual(expect.objectContaining({
        ultracode: false,
        display: expect.objectContaining({
          title: "Ultracode",
          status: "disabled",
          actions: expect.arrayContaining([{ id: "enable", label: "Enable ultracode", enabled: true }]),
        }),
      }));
      expect(result?.content[0]?.text).toContain("\"display\"");
      expect(result?.content[0]?.text).toContain("\"ultracode\":false");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
