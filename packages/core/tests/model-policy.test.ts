import { describe, expect, test } from "bun:test";
import {
  createAliasModelPolicy,
  createMemoryStore,
  createWorkflowRuntime,
  type WorkflowScript,
} from "../src/index";

describe("workflow model policy", () => {
  test("resolves Claude-style model aliases before calling the harness adapter", async () => {
    const store = createMemoryStore();
    const seenModels: Array<string | undefined> = [];
    const runtime = createWorkflowRuntime({
      store,
      modelPolicy: createAliasModelPolicy({
        haiku: "provider/fast-worker",
      }),
      agent: async (_prompt, options) => {
        seenModels.push(options?.model);
        return { model: options?.model };
      },
    });

    const script: WorkflowScript = async ({ agent }) => agent("summarize", {
      model: "haiku",
    });

    const run = await runtime.run({ name: "model-policy", script });

    expect(run.status).toBe("completed");
    expect(seenModels).toEqual(["provider/fast-worker"]);
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "agent:start",
      requestedModel: "haiku",
      model: "provider/fast-worker",
    }));
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "agent:done",
      requestedModel: "haiku",
      model: "provider/fast-worker",
    }));
  });
});
