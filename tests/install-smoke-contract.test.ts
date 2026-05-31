import { describe, expect, test } from "bun:test";
import { installSmokeTargets } from "../scripts/install-smoke";

describe("install smoke contract", () => {
  test("covers every non-Claude harness with isolated install state", () => {
    expect(installSmokeTargets.map((target) => target.harness)).toEqual([
      "codex",
      "gemini",
      "opencode",
      "grok",
      "pi",
      "antigravity",
    ]);

    for (const target of installSmokeTargets) {
      expect(target.env).not.toEqual({});
      expect(target.expectedOutput).toContain(target.pluginName);
      expect(JSON.stringify(target).toLowerCase()).not.toContain("mcp");
    }
  });

  test("preseeds Gemini local-extension trust instead of relying on interactive prompts", () => {
    const gemini = installSmokeTargets.find((target) => target.harness === "gemini");

    expect(gemini?.preseedTrustedPluginPath).toBe("plugins/gemini-workflow-kit");
    expect(gemini?.commands[0]?.args).toContain("--consent");
    expect(gemini?.commands[0]?.args).toContain("--skip-settings");
  });
});
