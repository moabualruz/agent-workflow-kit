import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileStore,
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

  test("parallel agent calls run with no kit-imposed concurrency cap (harness owns limits)", async () => {
    const store = createMemoryStore();
    let active = 0;
    let maxActive = 0;
    const runtime = createWorkflowRuntime({
      store,
      agent: async (prompt) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { prompt };
      },
    });

    const script: WorkflowScript = async ({ parallel, agent }) => parallel([
      () => agent("one"),
      () => agent("two"),
      () => agent("three"),
      () => agent("four"),
    ]);

    const run = await runtime.run({ name: "agent-concurrency", script });

    expect(run.status).toBe("completed");
    // All four run concurrently — the kit does not throttle; the harness does.
    expect(maxActive).toBe(4);
    expect(run.result).toEqual([
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      { prompt: "four" },
    ]);
  });

  test("agent calls are not bounded by a kit-imposed per-run count limit", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const runtime = createWorkflowRuntime({
      store,
      agent: async (prompt) => {
        calls += 1;
        return { prompt };
      },
    });

    const script: WorkflowScript = async ({ agent }) => {
      for (let i = 0; i < 50; i += 1) await agent(`call-${i}`);
      return { calls: 50 };
    };

    const run = await runtime.run({ name: "agent-no-limit", script });

    expect(run.status).toBe("completed");
    expect(calls).toBe(50);
  });

  test("explicit max agent call limit fails before the adapter exceeds policy", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const runtime = createWorkflowRuntime({
      store,
      executionLimits: { maxAgentCalls: 2 },
      agent: async (prompt) => {
        calls += 1;
        return { prompt };
      },
    });

    const script: WorkflowScript = async ({ agent }) => {
      await agent("first");
      await agent("second");
      return agent("third");
    };

    const run = await runtime.run({ name: "agent-limit", script });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Agent call limit exceeded");
    expect(calls).toBe(2);
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "agent:limit",
      prompt: "third",
      error: "Agent call limit exceeded: maxAgentCalls=2",
    }));
  });

  test("explicit estimated token limit can stop the run after budget spend exceeds policy", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const runtime = createWorkflowRuntime({
      store,
      executionLimits: { maxEstimatedTokens: 10, stopOnEstimatedTokenLimit: true },
      estimateTokens: () => 8,
      agent: async (prompt) => {
        calls += 1;
        return { prompt };
      },
    });

    const script: WorkflowScript = async ({ agent }) => {
      await agent("first");
      return agent("second");
    };

    const run = await runtime.run({ name: "token-limit", script });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Estimated token limit exceeded");
    expect(calls).toBe(2);
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "agent:limit",
      prompt: "second",
      error: "Estimated token limit exceeded: maxEstimatedTokens=10",
    }));
  });

  test("explicit child workflow depth limit can block child workflow execution", async () => {
    const store = createMemoryStore();
    let childAgentCalls = 0;
    const runtime = createWorkflowRuntime({
      store,
      executionLimits: { maxChildWorkflowDepth: 0 },
      agent: async () => {
        childAgentCalls += 1;
        return { ok: true };
      },
    });
    const child: WorkflowScript = async ({ agent }) => agent("child work");
    const parent: WorkflowScript = async ({ workflow }) => workflow({ name: "child", script: child });

    const run = await runtime.run({ name: "depth-limit", script: parent });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Child workflow depth limit exceeded");
    expect(childAgentCalls).toBe(0);
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "workflow:limit",
      title: "child",
      error: "Child workflow depth limit exceeded: maxChildWorkflowDepth=0",
    }));
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
    const parent: WorkflowScript = async ({ args, workflow }) => {
      const parentArgs = args as { parentId: string };
      return {
        parent: args,
        nested: await workflow({
          name: "child-with-args",
          script: child,
          args: { childId: parentArgs.parentId },
        }),
      };
    };

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

  test("pipeline runs items independently with no barrier: a slow item's late stage does not gate a fast item", async () => {
    const store = createMemoryStore();
    const completions: string[] = [];
    const runtime = createWorkflowRuntime({
      store,
      agent: async (prompt) => {
        if (prompt.startsWith("slow")) await new Promise((resolve) => setTimeout(resolve, 25));
        completions.push(prompt);
        return { label: prompt };
      },
    });

    const script: WorkflowScript = async ({ pipeline, agent }) => pipeline(
      ["slow", "fast"],
      (item) => agent(`${item}:stage-1`),
      (previous) => agent(`${previous.label}:stage-2`),
    );

    const run = await runtime.run({ name: "pipeline-independent", script });

    expect(run.status).toBe("completed");
    // Result order follows input order...
    expect(run.result).toEqual([
      { label: "slow:stage-1:stage-2" },
      { label: "fast:stage-1:stage-2" },
    ]);
    // ...but the fast item finishes both stages before the slow item's first
    // stage resolves — proving there is no barrier between stages.
    expect(completions[0]).toBe("fast:stage-1");
    expect(completions[1]).toBe("fast:stage-1:stage-2");
  });

  test("pipeline drops a throwing item to null and skips its remaining stages", async () => {
    const store = createMemoryStore();
    let stageTwoCalls = 0;
    const runtime = createWorkflowRuntime({
      store,
      agent: async (prompt) => {
        if (prompt.includes("boom")) throw new Error("stage failed");
        if (prompt.includes("stage-2")) stageTwoCalls += 1;
        return { label: prompt };
      },
    });

    const script: WorkflowScript = async ({ pipeline, agent }) => pipeline(
      ["ok", "boom"],
      (item) => agent(`${item}:stage-1`),
      (previous) => agent(`${previous.label}:stage-2`),
    );

    const run = await runtime.run({ name: "pipeline-throw", script });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual([{ label: "ok:stage-1:stage-2" }, null]);
    // Only the surviving item reaches stage 2.
    expect(stageTwoCalls).toBe(1);
  });

  test("parallel never rejects: a throwing thunk resolves to null in the result array", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({
      store,
      agent: async (prompt) => {
        if (prompt === "boom") throw new Error("agent failed");
        return { prompt };
      },
    });

    const script: WorkflowScript = async ({ parallel, agent }) => parallel([
      () => agent("one"),
      () => agent("boom"),
      () => agent("three"),
    ]);

    const run = await runtime.run({ name: "parallel-null", script });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual([{ prompt: "one" }, null, { prompt: "three" }]);
  });

  test("resume replays the unchanged agent() prefix from the prior journal without re-calling the adapter", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-resume-"));
    try {
      const store = createFileStore({ projectRoot });
      let liveCalls = 0;
      const runtime = createWorkflowRuntime({
        store,
        agent: async (prompt) => {
          liveCalls += 1;
          return { prompt, call: liveCalls };
        },
      });

      const script: WorkflowScript = async ({ agent }) => {
        const a = await agent("alpha");
        const b = await agent("beta");
        return { a, b };
      };

      const first = await runtime.run({ name: "resume-target", script });
      expect(first.status).toBe("completed");
      expect(liveCalls).toBe(2);

      // Same script + same args => 100% cache hit, zero new adapter calls.
      const resumed = await runtime.run({ name: "resume-target", script }, { resumeFromRunId: first.runId });
      expect(resumed.status).toBe("completed");
      expect(resumed.result).toEqual(first.result);
      expect(liveCalls).toBe(2);

      const cachedEvents = store.eventsFor(resumed.runId).filter((event) => event.type === "agent:cached");
      expect(cachedEvents.map((event) => event.index)).toEqual([1, 2]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("resume replays only the unchanged prefix and re-runs from the first changed agent() call", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-resume-prefix-"));
    try {
      const store = createFileStore({ projectRoot });
      const seen: string[] = [];
      const runtime = createWorkflowRuntime({
        store,
        agent: async (prompt) => {
          seen.push(prompt);
          return { prompt };
        },
      });

      const original: WorkflowScript = async ({ agent }) => {
        const a = await agent("alpha");
        const b = await agent("beta");
        const c = await agent("gamma");
        return { a, b, c };
      };
      const first = await runtime.run({ name: "resume-prefix", script: original });
      expect(seen).toEqual(["alpha", "beta", "gamma"]);

      // Second call keeps the first prompt but changes the second: the first
      // call is served from cache, the changed call and everything after runs live.
      seen.length = 0;
      const changed: WorkflowScript = async ({ agent }) => {
        const a = await agent("alpha");
        const b = await agent("beta-changed");
        const c = await agent("gamma");
        return { a, b, c };
      };
      const resumed = await runtime.run({ name: "resume-prefix", script: changed }, { resumeFromRunId: first.runId });

      expect(resumed.status).toBe("completed");
      expect(seen).toEqual(["beta-changed", "gamma"]);
      const events = store.eventsFor(resumed.runId);
      expect(events.filter((event) => event.type === "agent:cached").map((event) => event.index)).toEqual([1]);
      expect(events.filter((event) => event.type === "agent:start").map((event) => event.index)).toEqual([2, 3]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("resume invalidates across scopes: a parent divergence before a child workflow re-runs the child live", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-resume-crossscope-"));
    try {
      const store = createFileStore({ projectRoot });
      const seen: string[] = [];
      const runtime = createWorkflowRuntime({
        store,
        agent: async (prompt) => {
          seen.push(prompt);
          return { prompt };
        },
      });

      const child: WorkflowScript = async ({ agent }) => ({ c: await agent("child-call") });
      const makeParent = (head: string): WorkflowScript => async ({ agent, workflow }) => {
        const a = await agent(head);
        const nested = await workflow({ name: "child", script: child });
        return { a, nested };
      };

      const first = await runtime.run({ name: "cross-scope", script: makeParent("alpha") });
      expect(seen).toEqual(["alpha", "child-call"]);

      // The parent call BEFORE the child workflow diverges. Under a true global
      // prefix, the child's agent() call executes after the divergence point and
      // must run live — not replay its cached result.
      seen.length = 0;
      const resumed = await runtime.run(
        { name: "cross-scope", script: makeParent("alpha-changed") },
        { resumeFromRunId: first.runId },
      );

      expect(resumed.status).toBe("completed");
      expect(seen).toEqual(["alpha-changed", "child-call"]);
      const cached = store.eventsFor(resumed.runId).filter((event) => event.type === "agent:cached");
      expect(cached).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("resume of an unchanged parent+child workflow is a 100% cache hit (parent and child calls)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-resume-childhit-"));
    try {
      const store = createFileStore({ projectRoot });
      const seen: string[] = [];
      const runtime = createWorkflowRuntime({
        store,
        agent: async (prompt) => {
          seen.push(prompt);
          return { prompt };
        },
      });

      const child: WorkflowScript = async ({ agent }) => ({ c: await agent("child-work") });
      const parent: WorkflowScript = async ({ agent, workflow }) => {
        const head = await agent("head");
        const nested = await workflow({ name: "child", script: child });
        const tail = await agent("tail");
        return { head, nested, tail };
      };

      const first = await runtime.run({ name: "child-hit", script: parent });
      expect(seen).toEqual(["head", "child-work", "tail"]);

      // Identical script + args resumed: every call — parent head/tail AND the
      // child's call — replays from cache; the adapter is never re-invoked.
      seen.length = 0;
      const resumed = await runtime.run(
        { name: "child-hit", script: parent },
        { resumeFromRunId: first.runId },
      );

      expect(resumed.status).toBe("completed");
      expect(seen).toEqual([]);
      const cachedPrompts = store
        .eventsFor(resumed.runId)
        .filter((event) => event.type === "agent:cached")
        .map((event) => event.prompt)
        .sort();
      expect(cachedPrompts).toEqual(["child-work", "head", "tail"]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("stop aborts a live run between agent calls and transitions it to stopped", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-stop-"));
    try {
      const store = createFileStore({ projectRoot });
      let started = 0;
      let runIdForStop = "";
      const runtime = createWorkflowRuntime({
        store,
        agent: async (prompt) => {
          started += 1;
          // After the first agent resolves, request a stop so the next gated
          // agent call observes the abort signal and unwinds.
          if (started === 1) store.stop(runIdForStop);
          return { prompt };
        },
      });

      const script: WorkflowScript = async ({ agent }) => {
        const a = await agent("first");
        const b = await agent("second");
        return { a, b };
      };

      // Capture the run id before the script reaches its second agent call.
      const createRun = store.createRun;
      store.createRun = (name, args) => {
        const run = createRun(name, args);
        runIdForStop = run.runId;
        return run;
      };

      const run = await runtime.run({ name: "stop-live", script });

      expect(run.status).toBe("stopped");
      // Only the first agent ran; the second was aborted before execution.
      expect(started).toBe(1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("stop halts a run whose final work is inside parallel() and terminates as stopped (barrier re-raises abort)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-stop-parallel-"));
    try {
      const store = createFileStore({ projectRoot });
      let parallelStarted = 0;
      let runIdForStop = "";
      const runtime = createWorkflowRuntime({
        store,
        agent: async (prompt) => {
          if (prompt === "trigger") {
            store.stop(runIdForStop); // abort BEFORE the parallel barrier runs
            return { prompt };
          }
          parallelStarted += 1;
          return { prompt };
        },
      });

      // A bare agent() that fires the stop, then a parallel() barrier holding the
      // remaining work — the previously-swallowed abort path. With the signal
      // already tripped, every barrier thunk throws at its gated signal check and
      // the barrier re-raises, so the run unwinds to "stopped" rather than
      // swallowing the aborts into nulls and completing.
      const script: WorkflowScript = async ({ parallel, agent }) => {
        await agent("trigger");
        return parallel([
          () => agent("one"),
          () => agent("two"),
          () => agent("three"),
        ]);
      };

      const createRun = store.createRun;
      store.createRun = (name, args, scriptPath) => {
        const run = createRun(name, args, scriptPath);
        runIdForStop = run.runId;
        return run;
      };

      const run = await runtime.run({ name: "stop-parallel", script });

      expect(run.status).toBe("stopped");
      // No barrier agent ran — all saw the tripped signal and threw.
      expect(parallelStarted).toBe(0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("nested workflow() beyond one level throws (matches Claude one-level nesting)", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({ store, agent: async () => ({}) });

    const grandchild: WorkflowScript = async () => ({ deep: true });
    const child: WorkflowScript = async ({ workflow }) => {
      // This second-level workflow() call must throw.
      return workflow({ name: "grandchild", script: grandchild });
    };
    const parent: WorkflowScript = async ({ workflow }) => workflow({ name: "child", script: child });

    const run = await runtime.run({ name: "nesting", script: parent });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("nest one level only");
  });

  test("resume replay is stable under parallel completion-order reordering (scope-keyed journal)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-replay-parallel-"));
    try {
      const store = createFileStore({ projectRoot });
      let liveCalls = 0;
      const runtime = createWorkflowRuntime({
        store,
        agent: async (prompt) => {
          liveCalls += 1;
          // "slow" finishes last on the first run; resume must still match by
          // stable key, not by completion order.
          if (prompt.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 15));
          return { prompt };
        },
      });

      const script: WorkflowScript = async ({ parallel, agent }) => parallel([
        () => agent("slow-one"),
        () => agent("fast-two"),
        () => agent("fast-three"),
      ]);

      const first = await runtime.run({ name: "replay-parallel", script });
      expect(first.status).toBe("completed");
      expect(liveCalls).toBe(3);

      const resumed = await runtime.run({ name: "replay-parallel", script }, { resumeFromRunId: first.runId });
      expect(resumed.status).toBe("completed");
      expect(resumed.result).toEqual(first.result);
      // 100% cache hit despite completion-order differing from source order.
      expect(liveCalls).toBe(3);
      expect(store.eventsFor(resumed.runId).filter((e) => e.type === "agent:cached")).toHaveLength(3);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("schema-constrained agent retries on mismatch then succeeds, recording retry events", async () => {
    const store = createMemoryStore();
    let call = 0;
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => {
        call += 1;
        // First response violates the schema (count is a string); second conforms.
        return call === 1 ? { count: "nope" } : { count: 3 };
      },
    });

    const schema = { type: "object", required: ["count"], properties: { count: { type: "integer" } } };
    const script: WorkflowScript = async ({ agent }) => agent("produce a count", { schema });

    const run = await runtime.run({ name: "schema-retry", script });

    expect(run.status).toBe("completed");
    expect(run.result).toEqual({ count: 3 });
    expect(call).toBe(2);
    expect(store.eventsFor(run.runId).filter((e) => e.type === "agent:retry")).toHaveLength(1);
  });

  test("schema-constrained agent fails the run after exhausting retries", async () => {
    const store = createMemoryStore();
    let call = 0;
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => {
        call += 1;
        return { count: "never valid" };
      },
    });

    const schema = { type: "object", required: ["count"], properties: { count: { type: "integer" } } };
    const script: WorkflowScript = async ({ agent }) => agent("produce a count", { schema });

    const run = await runtime.run({ name: "schema-fail", script });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("failed schema validation");
    // initial attempt + 2 retries = 3 adapter calls.
    expect(call).toBe(3);
  });

  test("agentType, label, and active phase group are recorded on agent events", async () => {
    const store = createMemoryStore();
    const seen: Array<Record<string, unknown>> = [];
    const runtime = createWorkflowRuntime({
      store,
      agent: async (_prompt, options) => {
        seen.push({ agentType: options?.agentType });
        return { ok: true };
      },
    });

    const script: WorkflowScript = async ({ phase, agent }) => {
      phase("Review");
      return agent("review it", { agentType: "code-reviewer", label: "reviewer-1" });
    };

    const run = await runtime.run({ name: "agent-meta", script });

    expect(run.status).toBe("completed");
    expect(seen).toEqual([{ agentType: "code-reviewer" }]);
    expect(store.eventsFor(run.runId)).toContainEqual(expect.objectContaining({
      type: "agent:start",
      agentType: "code-reviewer",
      label: "reviewer-1",
      group: "Review",
    }));
  });

  test("omitted opts.model inherits the session model", async () => {
    const store = createMemoryStore();
    const seenModels: Array<string | undefined> = [];
    const runtime = createWorkflowRuntime({
      store,
      sessionModel: "session/default-model",
      agent: async (_prompt, options) => {
        seenModels.push(options?.model);
        return { ok: true };
      },
    });

    const script: WorkflowScript = async ({ agent }) => agent("no model specified");

    const run = await runtime.run({ name: "session-model", script });

    expect(run.status).toBe("completed");
    expect(seenModels).toEqual(["session/default-model"]);
  });

  test("budget exposes total/spent/remaining for self-pacing but never enforces (no throw)", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({
      store,
      tokenBudget: 10, // a self-pacing target, not a ceiling
      estimateTokens: () => 8, // each call spends 8 tokens
      agent: async () => ({ ok: true }),
    });

    const observed: Array<{ total: number | null; remaining: number; spent: number }> = [];
    const script: WorkflowScript = async ({ agent, budget }) => {
      observed.push({ total: budget.total, remaining: budget.remaining(), spent: budget.spent() });
      await agent("first"); // spends 8 → remaining 2
      observed.push({ total: budget.total, remaining: budget.remaining(), spent: budget.spent() });
      // remaining is 2 but the kit does NOT block — this call still runs.
      await agent("second"); // spends 8 → remaining clamps at 0, spent 16
      observed.push({ total: budget.total, remaining: budget.remaining(), spent: budget.spent() });
      // Over the target, still no throw — the harness owns real limits.
      return agent("third");
    };

    const run = await runtime.run({ name: "budget", script });

    expect(run.status).toBe("completed");
    expect(observed[0]).toEqual({ total: 10, remaining: 10, spent: 0 });
    expect(observed[1]).toEqual({ total: 10, remaining: 2, spent: 8 });
    expect(observed[2]).toEqual({ total: 10, remaining: 0, spent: 16 }); // remaining clamped, never negative
  });

  test("budget spend is replay-stable: a resumed cache hit re-applies the original token cost", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-budget-resume-"));
    try {
      const store = createFileStore({ projectRoot });
      const runtime = createWorkflowRuntime({
        store,
        tokenBudget: 100,
        estimateTokens: () => 8,
        agent: async () => ({ ok: true }),
      });

      let freshSpent = 0;
      let resumedSpent = 0;
      const makeScript = (sink: (n: number) => void): WorkflowScript => async ({ agent, budget }) => {
        await agent("a");
        await agent("b");
        sink(budget.spent());
        return { done: true };
      };

      const first = await runtime.run({ name: "budget-resume", script: makeScript((n) => { freshSpent = n; }) });
      expect(freshSpent).toBe(16); // two calls × 8

      // Identical resume: both calls are cache hits, but spent() must match the
      // fresh run so a budget-sensitive branch behaves identically.
      const resumed = await runtime.run(
        { name: "budget-resume", script: makeScript((n) => { resumedSpent = n; }) },
        { resumeFromRunId: first.runId },
      );
      expect(resumed.status).toBe("completed");
      expect(resumedSpent).toBe(16);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("budget is unbounded by default (total null, remaining Infinity)", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({ store, agent: async () => ({ ok: true }) });

    let snapshot: { total: number | null; remaining: number } | undefined;
    const script: WorkflowScript = async ({ agent, budget }) => {
      snapshot = { total: budget.total, remaining: budget.remaining() };
      return agent("anything");
    };

    const run = await runtime.run({ name: "budget-unbounded", script });

    expect(run.status).toBe("completed");
    expect(snapshot?.total).toBeNull();
    expect(snapshot?.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  test("budget charges every schema generation, not just the accepted one", async () => {
    const store = createMemoryStore();
    let call = 0;
    let spentAfter: number | undefined;
    const runtime = createWorkflowRuntime({
      store,
      estimateTokens: () => 100, // each generation costs 100
      agent: async () => {
        call += 1;
        return call < 3 ? { count: "bad" } : { count: 3 }; // fail twice, succeed on 3rd
      },
    });

    const schema = { type: "object", required: ["count"], properties: { count: { type: "integer" } } };
    const script: WorkflowScript = async ({ agent, budget }) => {
      const r = await agent("produce count", { schema });
      spentAfter = budget.spent();
      return r;
    };

    const run = await runtime.run({ name: "budget-retry", script });

    expect(run.status).toBe("completed");
    expect(call).toBe(3);
    // 3 generations × 100 = 300, not 100.
    expect(spentAfter).toBe(300);
  });

  test("budget is charged for retried generations even when validation never succeeds", async () => {
    const store = createMemoryStore();
    let call = 0;
    const runtime = createWorkflowRuntime({
      store,
      estimateTokens: () => 100,
      agent: async () => {
        call += 1;
        return { count: "always bad" };
      },
    });

    const schema = { type: "object", required: ["count"], properties: { count: { type: "integer" } } };
    const script: WorkflowScript = async ({ agent }) => agent("produce count", { schema });

    const run = await runtime.run({ name: "budget-retry-fail", script });

    expect(run.status).toBe("failed");
    expect(call).toBe(3);
    // All 3 failed generations are still charged (was 0 before the fix).
    const events = store.eventsFor(run.runId);
    expect(events.some((e) => e.type === "agent:retry")).toBe(true);
  });

  test("runDetached returns a running handle immediately then completes in the background with a notify event", async () => {
    const store = createMemoryStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => ({ ok: true }),
    });

    const script: WorkflowScript = async ({ agent }) => {
      await gate; // hold the run open until the test releases it
      return agent("work");
    };

    const handle = await runtime.runDetached({ name: "detached", script });
    // Returns before the script finishes.
    expect(handle.status).toBe("running");

    release?.();
    await waitForEvent(store, handle.runId, "run:completed");

    const events = store.eventsFor(handle.runId);
    expect(events).toContainEqual(expect.objectContaining({ type: "run:completed" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "run:notify", message: "completed" }));
  });

  test("runDetached still denies synchronously under a deny policy", async () => {
    const store = createMemoryStore();
    const runtime = createWorkflowRuntime({
      store,
      agent: async () => ({}),
      permissionPolicy: denyDynamicWorkflowPolicy,
    });

    const handle = await runtime.runDetached({ name: "denied", script: async () => ({ ok: true }) });

    expect(handle.status).toBe("failed");
    expect(handle.error).toContain("denied");
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

async function waitForEvent(
  store: ReturnType<typeof createMemoryStore>,
  runId: string,
  type: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (store.eventsFor(runId).some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${type}`);
}
