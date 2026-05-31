import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertHeadlessWorkflowArtifactsExist,
  approvedModelAliasMaps,
  approvedPiFallbackModels,
  headlessSmokeTargets,
  runHeadlessSmoke,
  validateHeadlessSmokeOutput,
} from "../scripts/headless-smoke";

describe("headless smoke contract", () => {
  test("covers Claude reference plus every supported implementation harness", () => {
    expect(headlessSmokeTargets.map((target) => target.harness)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "grok",
      "pi",
      "antigravity",
    ]);

    for (const target of headlessSmokeTargets) {
      expect(target.prompt).toContain("agent-workflow-kit workflow-run no-write-probe --json");
      expect(target.prompt).toContain('cd "{tempProject}" &&');
      expect(JSON.stringify(target).toLowerCase()).not.toContain("mcp");
    }
  });

  test("uses approved OpenCode/Pi model families instead of Claude-family models", () => {
    expect(approvedModelAliasMaps.opencode).toEqual({
      opus: "opencode-go/deepseek-v4-pro",
      sonnet: "opencode-go/qwen3.6-plus",
      haiku: "opencode/deepseek-v4-flash-free",
    });
    expect(approvedModelAliasMaps.pi).toEqual({
      opus: "openai-codex/gpt-5.5",
      sonnet: "openai-codex/gpt-5.3-codex",
      haiku: "opencode/deepseek-v4-flash-free",
    });

    const serializedMaps = JSON.stringify(approvedModelAliasMaps);
    expect(serializedMaps).not.toContain("claude-opus");
    expect(serializedMaps).not.toContain("claude-sonnet");
    expect(serializedMaps).not.toContain("claude-haiku");
    expect(approvedPiFallbackModels).toEqual([
      "opencode-go/deepseek-v4-pro",
      "opencode-go/qwen3.6-plus",
      "opencode-go/deepseek-v4-flash",
      "opencode/grok-build-0.1",
      "xai-auth/grok-4.3",
      "xai-auth/grok-4.20-0309-reasoning",
      "xai-auth/grok-4.20-0309-non-reasoning",
    ]);
  });

  test("exposes dry-run and live headless smoke package scripts", () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));

    expect(packageJson.scripts["headless-smoke"]).toBe("bun scripts/headless-smoke.ts --require-tools");
    expect(packageJson.scripts["headless-smoke:live"]).toBe(
      "bun scripts/headless-smoke.ts --require-tools --run",
    );
  });

  test("filters headless smoke targets by harness for focused live probes", async () => {
    const results = await runHeadlessSmoke({ harnesses: ["pi"] });

    expect(results).toHaveLength(1);
    expect(results[0]?.harness).toBe("pi");
    expect(results[0]?.status).toBe("dry-run");
    expect(results[0]?.command.join(" ")).not.toContain("{tempProject}");
  });

  test("runs Gemini headless smoke with shell-capable approval while preserving auth state", () => {
    const gemini = headlessSmokeTargets.find((target) => target.harness === "gemini");

    expect(gemini?.args).toContain("--yolo");
    expect(gemini?.env).toBeUndefined();
  });

  test("runs OpenCode headless smoke in the temporary project directory", () => {
    const opencode = headlessSmokeTargets.find((target) => target.harness === "opencode");

    expect(opencode?.args).toEqual(expect.arrayContaining(["--dir", "{tempProject}"]));
    expect(opencode?.args).toContain("--dangerously-skip-permissions");
  });

  test("runs Grok headless smoke with current single-turn and cwd flags", () => {
    const grok = headlessSmokeTargets.find((target) => target.harness === "grok");

    expect(grok?.args).toEqual(expect.arrayContaining(["--cwd", "{tempProject}", "-p", "{prompt}"]));
    expect(grok?.args).not.toContain("--prompt");
    expect(grok?.model).toBe("grok-build");
  });

  test("validates live smoke output as completed workflow JSON with artifacts", () => {
    const output = [
      "model preface",
      JSON.stringify({
        runId: "wf_live",
        name: "no-write-probe",
        status: "completed",
        artifacts: {
          root: "/tmp/awk/runs/wf_live",
          runJson: "/tmp/awk/runs/wf_live/run.json",
          eventsJsonl: "/tmp/awk/runs/wf_live/events.jsonl",
        },
      }),
    ].join("\n");

    expect(validateHeadlessSmokeOutput(output)).toEqual({
      runId: "wf_live",
      name: "no-write-probe",
      status: "completed",
      artifacts: {
        root: "/tmp/awk/runs/wf_live",
        runJson: "/tmp/awk/runs/wf_live/run.json",
        eventsJsonl: "/tmp/awk/runs/wf_live/events.jsonl",
      },
    });

    expect(() => validateHeadlessSmokeOutput('{"name":"no-write-probe","status":"failed"}')).toThrow(
      "expected completed no-write-probe workflow JSON",
    );
    expect(() => validateHeadlessSmokeOutput("not-json model output")).toThrow("not-json model output");
  });

  test("validates Pi JSON event streams with workflow JSON embedded in text content", () => {
    const workflow = {
      runId: "wf_pi",
      name: "no-write-probe",
      status: "completed",
      artifacts: {
        root: "/tmp/pi/wf_pi",
        runJson: "/tmp/pi/wf_pi/run.json",
        eventsJsonl: "/tmp/pi/wf_pi/events.jsonl",
      },
      result: { ok: true },
    } as const;
    const event = {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_end",
        content: JSON.stringify(workflow),
      },
    };

    expect(validateHeadlessSmokeOutput(JSON.stringify(event))).toEqual(workflow);
  });

  test("verifies live smoke artifact files before temporary state is cleaned", () => {
    const root = mkdtempSync(join(tmpdir(), "awk-headless-artifacts-"));
    const runJson = join(root, "run.json");
    const eventsJsonl = join(root, "events.jsonl");
    writeFileSync(runJson, "{}\n");
    writeFileSync(eventsJsonl, "{}\n");

    try {
      assertHeadlessWorkflowArtifactsExist({
        runId: "wf_live",
        name: "no-write-probe",
        status: "completed",
        artifacts: { root, runJson, eventsJsonl },
      });

      unlinkSync(eventsJsonl);
      expect(() => assertHeadlessWorkflowArtifactsExist({
        runId: "wf_live",
        name: "no-write-probe",
        status: "completed",
        artifacts: { root, runJson, eventsJsonl },
      })).toThrow("missing workflow artifact");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
