import { describe, expect, test } from "bun:test";
import {
  createCliAgentExecutor,
  defaultCommandFor,
  extractJson,
  type CliCommand,
  type CliCommandResult,
  type RunCommand,
} from "../src/index";

type Captured = { command: CliCommand; prompt: string; timeoutMs: number };

function fakeRunner(result: CliCommandResult, sink?: Captured[]): RunCommand {
  return async (command, prompt, timeoutMs) => {
    sink?.push({ command, prompt, timeoutMs });
    return result;
  };
}

describe("createCliAgentExecutor", () => {
  test("defaults to claude -p and returns trimmed stdout when no schema", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout: "  hello from claude  \n", stderr: "" }, captured),
    });

    const result = await agent("do the thing");

    expect(result).toBe("hello from claude");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.command.cmd).toBe("claude");
    expect(captured[0]?.command.args).toEqual(["-p"]);
    expect(captured[0]?.command.promptViaStdin).toBe(true);
    expect(captured[0]?.prompt).toBe("do the thing");
  });

  test("routes to codex exec when agentType is codex and passes the model", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout: "codex output", stderr: "" }, captured),
    });

    await agent("review this", { agentType: "codex", model: "gpt-5.4" });

    expect(captured[0]?.command.cmd).toBe("codex");
    expect(captured[0]?.command.args).toEqual(["exec", "-m", "gpt-5.4"]);
  });

  test("maps Claude-style logical tier names when routing to codex by default", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout: "codex output", stderr: "" }, captured),
    });

    await agent("triage", { agentType: "codex", model: "sonnet" });

    expect(captured[0]?.command.cmd).toBe("codex");
    expect(captured[0]?.command.args).toEqual(["exec", "-c", "model_reasoning_effort=\"high\"", "-m", "gpt-5.6-terra"]);
  });

  test("can override the default codex logical tier model", async () => {
    const previous = process.env.AGENT_WORKFLOW_KIT_CODEX_LOGICAL_MODEL;
    process.env.AGENT_WORKFLOW_KIT_CODEX_LOGICAL_MODEL = "provider/codex-balanced";
    try {
      const captured: Captured[] = [];
      const agent = createCliAgentExecutor({
        runCommand: fakeRunner({ status: 0, stdout: "codex output", stderr: "" }, captured),
      });

      await agent("triage", { agentType: "codex", model: "sonnet" });

      expect(captured[0]?.command.args).toEqual(["exec", "-c", "model_reasoning_effort=\"high\"", "-m", "provider/codex-balanced"]);
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKFLOW_KIT_CODEX_LOGICAL_MODEL;
      else process.env.AGENT_WORKFLOW_KIT_CODEX_LOGICAL_MODEL = previous;
    }
  });

  test("preserves the logical tier to select Codex reasoning effort", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout: "codex output", stderr: "" }, captured),
    });

    await agent("judge this", { agentType: "codex", model: "gpt-5.6-sol", requestedModel: "fable" });

    expect(captured[0]?.command.args).toEqual(["exec", "-c", "model_reasoning_effort=\"xhigh\"", "-m", "gpt-5.6-sol"]);
  });

  test("honors an explicit Codex reasoning effort", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout: "codex output", stderr: "" }, captured),
    });

    await agent("inspect", { agentType: "codex", model: "gpt-5.6-luna", effort: "low" });

    expect(captured[0]?.command.args).toEqual(["exec", "-c", "model_reasoning_effort=\"low\"", "-m", "gpt-5.6-luna"]);
  });

  test("can pass logical tier names to codex when explicitly enabled", async () => {
    const previous = process.env.AGENT_WORKFLOW_KIT_PASS_LOGICAL_MODELS;
    process.env.AGENT_WORKFLOW_KIT_PASS_LOGICAL_MODELS = "1";
    try {
      const captured: Captured[] = [];
      const agent = createCliAgentExecutor({
        runCommand: fakeRunner({ status: 0, stdout: "codex output", stderr: "" }, captured),
      });

      await agent("triage", { agentType: "codex", model: "sonnet" });

      expect(captured[0]?.command.args).toEqual(["exec", "-c", "model_reasoning_effort=\"high\"", "-m", "sonnet"]);
    } finally {
      if (previous === undefined) delete process.env.AGENT_WORKFLOW_KIT_PASS_LOGICAL_MODELS;
      else process.env.AGENT_WORKFLOW_KIT_PASS_LOGICAL_MODELS = previous;
    }
  });

  test("uses configured default agent type when agentType is omitted", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      defaultAgentType: "codex",
      runCommand: fakeRunner({ status: 0, stdout: "codex output", stderr: "" }, captured),
    });

    await agent("review this", { model: "gpt-5.4" });

    expect(captured[0]?.command.cmd).toBe("codex");
    expect(captured[0]?.command.args).toEqual(["exec", "-m", "gpt-5.4"]);
  });

  test("passes the model to claude via --model", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout: "ok", stderr: "" }, captured),
    });

    await agent("plan", { model: "opus" });

    expect(captured[0]?.command.args).toEqual(["-p", "--model", "opus"]);
  });

  test("appends a JSON-only instruction and parses bare JSON stdout when a schema is passed", async () => {
    const captured: Captured[] = [];
    const schema = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } };
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout: '{"verdict":"pass"}', stderr: "" }, captured),
    });

    const result = await agent("grill it", { schema });

    expect(result).toEqual({ verdict: "pass" });
    expect(captured[0]?.prompt).toContain("Return ONLY a single JSON value");
    expect(captured[0]?.prompt).toContain(JSON.stringify(schema));
  });

  test("extracts JSON embedded in prose / markdown fences", async () => {
    const stdout = "Here is my answer:\n```json\n{ \"count\": 3, \"items\": [\"a\"] }\n```\nDone.";
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 0, stdout, stderr: "" }),
    });

    const result = await agent("scan", { schema: { type: "object" } });

    expect(result).toEqual({ count: 3, items: ["a"] });
  });

  test("throws with stderr detail on a non-zero exit", async () => {
    const agent = createCliAgentExecutor({
      runCommand: fakeRunner({ status: 2, stdout: "", stderr: "auth required" }),
    });

    await expect(agent("anything")).rejects.toThrow(/exited with status 2.*auth required/);
  });

  test("dryRun returns schema-shaped stubs without spawning anything", async () => {
    let spawned = false;
    const agent = createCliAgentExecutor({
      dryRun: true,
      runCommand: async () => {
        spawned = true;
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    const result = await agent("grill", { schema: { type: "object", required: ["verdict"], properties: { verdict: { type: "string", enum: ["pass", "block"] } } } });

    expect(spawned).toBe(false);
    // schemaDefaultAgent: enum -> first value.
    expect(result).toEqual({ verdict: "pass" });
  });

  test("forwards the configured timeout to the runner", async () => {
    const captured: Captured[] = [];
    const agent = createCliAgentExecutor({
      timeoutMs: 12345,
      runCommand: fakeRunner({ status: 0, stdout: "x", stderr: "" }, captured),
    });

    await agent("hi");

    expect(captured[0]?.timeoutMs).toBe(12345);
  });

  test("awaits an async runner before reading its result", async () => {
    // A runner that resolves asynchronously must be awaited; otherwise reading result.status off a pending
    // Promise would throw or misbehave. This guards the spawnSync -> async spawn refactor.
    const slowRunner: RunCommand = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 0, stdout: "deferred output", stderr: "" };
    };
    const agent = createCliAgentExecutor({ runCommand: slowRunner });

    const result = await agent("do the thing");

    expect(result).toBe("deferred output");
  });

  test("runs concurrent agent() calls without serializing on each other", async () => {
    // The async runner must not block the event loop: two calls dispatched together should be in flight at the
    // same time. We assert peak concurrency reached 2, which a synchronous spawnSync runner could never do.
    let active = 0;
    let peak = 0;
    const concurrentRunner: RunCommand = async (_command, prompt) => {
      active += 1;
      peak = Math.max(peak, active);
      // Yield so both calls overlap before either resolves.
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: 0, stdout: prompt, stderr: "" };
    };
    const agent = createCliAgentExecutor({ runCommand: concurrentRunner });

    const [a, b] = await Promise.all([agent("branch-a"), agent("branch-b")]);

    expect(a).toBe("branch-a");
    expect(b).toBe("branch-b");
    expect(peak).toBe(2);
  });

  test("propagates a rejected runner (e.g. timeout or missing binary) as a thrown error", async () => {
    const failingRunner: RunCommand = async () => {
      throw new Error("cli-agent-executor: claude timed out after 1000ms");
    };
    const agent = createCliAgentExecutor({ runCommand: failingRunner });

    await expect(agent("anything")).rejects.toThrow(/timed out after 1000ms/);
  });

  test("default subprocess runner rejects promptly when the command times out", async () => {
    const agent = createCliAgentExecutor({
      timeoutMs: 50,
      commandFor: () => ({
        cmd: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        promptViaStdin: true,
      }),
    });

    await expect(agent("hang")).rejects.toThrow(/timed out after 50ms/);
  });
});

describe("defaultCommandFor", () => {
  test("maps only supported agentTypes", () => {
    expect(defaultCommandFor(undefined, "claude").cmd).toBe("claude");
    expect(defaultCommandFor(undefined, "codex").cmd).toBe("codex");
    expect(() => defaultCommandFor(undefined, "some-host-subagent")).toThrow("unsupported agent type");
  });
});

describe("extractJson", () => {
  test("returns parsed bare JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  test("ignores braces inside strings when scanning", () => {
    expect(extractJson('prefix {"text":"a } b"} suffix')).toEqual({ text: "a } b" });
  });

  test("returns the trimmed raw text when no JSON is present", () => {
    expect(extractJson("  no json here  ")).toBe("no json here");
  });

  test("skips an earlier non-JSON brace span and returns valid JSON appearing later", () => {
    // The first balanced {...} is a prose fragment / pseudo-code that does not parse; the real result follows
    // after a fence. A first-span-only scan would abort and return raw text; the multi-span scan must find it.
    const stdout = [
      "Plan: I will return an object like { key: value } with the verdict.",
      "```json",
      '{ "verdict": "pass", "score": 9 }',
      "```",
    ].join("\n");
    expect(extractJson(stdout)).toEqual({ verdict: "pass", score: 9 });
  });

  test("skips an earlier non-JSON array span and returns a valid array later", () => {
    const stdout = 'first try [a, b, c] then the real one: ["x","y"]';
    expect(extractJson(stdout)).toEqual(["x", "y"]);
  });

  test("returns the FIRST parseable span when multiple valid JSON spans appear", () => {
    const stdout = 'leading {"first":1} trailing {"second":2}';
    expect(extractJson(stdout)).toEqual({ first: 1 });
  });
});
