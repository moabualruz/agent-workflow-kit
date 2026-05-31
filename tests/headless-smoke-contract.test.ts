import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedModelAliasMaps, approvedPiFallbackModels, headlessSmokeTargets } from "../scripts/headless-smoke";

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
    expect(approvedPiFallbackModels).toContain("opencode/grok-build-0.1");
  });

  test("exposes dry-run and live headless smoke package scripts", () => {
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));

    expect(packageJson.scripts["headless-smoke"]).toBe("bun scripts/headless-smoke.ts --require-tools");
    expect(packageJson.scripts["headless-smoke:live"]).toBe(
      "bun scripts/headless-smoke.ts --require-tools --run",
    );
  });
});
