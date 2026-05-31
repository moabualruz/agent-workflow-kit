import { describe, expect, test } from "bun:test";
import workflowKitExtension from "./index";

describe("pi workflow kit extension", () => {
  test("workflow_run native tool exposes structured workflow args", () => {
    const extension = workflowKitExtension();
    const workflowRun = extension.tools.find((tool) => tool.name === "workflow_run");

    expect(workflowRun?.parameters).toEqual(expect.objectContaining({
      type: "object",
      properties: expect.objectContaining({
        workflow: { type: "string" },
        args: { type: "object", additionalProperties: true },
      }),
      required: ["workflow"],
    }));
  });
});
