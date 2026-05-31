import { describe, expect, test } from "bun:test";
import {
  createMemoryStore,
  createWorkflowRuntime,
  denyDynamicWorkflowPolicy,
  type WorkflowScript,
} from "../src/index";

describe("workflow runtime parity contract", () => {
  test("parallel returns input order while event stream records actual completion order", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({
      store,
      agent: async (prompt) => {
        if (prompt.includes("slow")) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { label: "slow" };
        }

        return { label: "fast" };
      },
    });

    const script: WorkflowScript = async ({ parallel, agent, phase }) => {
      phase("Parallel");
      return parallel([
        () => agent("slow agent"),
        () => agent("fast agent"),
      ]);
    };

    const run = await runtime.run({ name: "parallel-order", script });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual([{ label: "slow" }, { label: "fast" }]);
    expect(store.eventsFor(run.runId).filter((event) => event.type === "agent:done").map((event) => event.index)).toEqual([2, 1]);
  });

  test("pipeline starts each stage after prior stage completion and returns final stage result", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({
      store,
      agent: async (prompt) => ({ label: prompt }),
    });

    const script: WorkflowScript = async ({ pipeline, agent, phase }) => {
      phase("Pipeline");
      return pipeline(
        ["item"],
        (item) => agent(`${item}:stage-1`),
        (previous) => agent(`${previous.label}:stage-2`),
      );
    };

    const run = await runtime.run({ name: "pipeline", script });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual([{ label: "item:stage-1:stage-2" }]);
    expect(store.eventsFor(run.runId).filter((event) => event.type === "agent:start").map((event) => event.index)).toEqual([1, 2]);
  });

  test("child workflow is represented as a child phase and returns through parent result", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({ store, agent: async () => ({}) });

    const child: WorkflowScript = async ({ phase, log }) => {
      phase("Child");
      log("child entered");
      return { child: "ok" };
    };

    const parent: WorkflowScript = async ({ workflow }) => {
      const result = await workflow({ name: "child", script: child });
      return { nested: result };
    };

    const run = await runtime.run({ name: "parent", script: parent });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual({ nested: { child: "ok" } });
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "phase",
      kind: "child",
      title: "child",
    }));
  });

  test("workflow context exposes run args to parent and child scripts", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({ store, agent: async () => ({}) });

    const child: WorkflowScript = async ({ args }) => ({ child: args });
    const parent: WorkflowScript = async ({ args, workflow }) => ({
      parent: args,
      nested: await workflow({
        name: "child-with-args",
        script: child,
        args: { childId: args.parentId },
      }),
    });

    const run = await runtime.run({
      name: "parent-with-args",
      script: parent,
      args: { parentId: "parent-1" },
    });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual({
      parent: { parentId: "parent-1" },
      nested: { child: { childId: "parent-1" } },
    });
  });

  test("uncaught agent error fails run state even when caller process could still exit zero", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => {
        throw new Error("agent failed");
      },
    });

    const script: WorkflowScript = async ({ agent }) => agent("fail");

    const run = await runtime.run({ name: "failure", script });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("agent failed");
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "run:failed",
    }));
  });

  test("agent model override is passed to the adapter and persisted in events", async () => {
    const store = createMemoryStore();
    const seenModels: Array<string | undefined> = [];
    const runtime = createWorkflowRuntime({
      store,
      agent: async (_prompt, options) => {
        seenModels.push(options?.model);
        return { model: options?.model };
      },
    });

    const script: WorkflowScript = async ({ agent }) => agent("use fast worker", {
      model: "harness/fast-worker",
    });

    const run = await runtime.run({ name: "model-override", script });

    expect(run.status).toBe("completed");
    expect(seenModels).toEqual(["harness/fast-worker"]);
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "agent:start",
      model: "harness/fast-worker",
    }));
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "agent:done",
      model: "harness/fast-worker",
    }));
  });

  test("dontAsk permission policy denies dynamic workflow execution", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => ({}),
      permissionPolicy: denyDynamicWorkflowPolicy,
    });

    const run = await runtime.run({
      name: "blocked",
      script: async () => ({ ok: true }),
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Dynamic workflow execution denied");
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "permission:denied",
    }));
  });
});
