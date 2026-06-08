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
  return (command, prompt, timeoutMs) => {
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
      runCommand: () => {
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
});

describe("defaultCommandFor", () => {
  test("maps claude / codex / unknown agentTypes", () => {
    expect(defaultCommandFor(undefined, "claude").cmd).toBe("claude");
    expect(defaultCommandFor(undefined, "codex").cmd).toBe("codex");
    // Unknown agentType falls through to claude so the call still runs a real model.
    expect(defaultCommandFor(undefined, "some-host-subagent").cmd).toBe("claude");
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
});
