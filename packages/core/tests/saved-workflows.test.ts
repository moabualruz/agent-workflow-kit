import { describe, expect, test } from "bun:test";
import { createMemoryWorkflowRegistry, type WorkflowScript } from "../src/index";

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
});
