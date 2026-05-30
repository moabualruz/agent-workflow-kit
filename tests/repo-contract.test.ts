import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("standalone repository contract", () => {
  test("ships one harness-native pack per supported CLI", () => {
    for (const dir of [
      "plugins/claude-workflow-kit",
      "plugins/codex-workflow-kit",
      "plugins/gemini-workflow-kit",
      "plugins/opencode-workflow-kit",
      "plugins/grok-workflow-kit",
      "plugins/pi-workflow-kit",
    ]) {
      expect(existsSync(join(repoRoot, dir))).toBe(true);
      expect(existsSync(join(repoRoot, dir, "README.md"))).toBe(true);
    }
  });

  test("Codex plugin has marketplace and plugin manifests", () => {
    const marketplace = JSON.parse(readFileSync(join(repoRoot, ".agents/plugins/marketplace.json"), "utf8"));
    const plugin = JSON.parse(readFileSync(join(repoRoot, "plugins/codex-workflow-kit/.codex-plugin/plugin.json"), "utf8"));

    expect(marketplace.name).toBe("agent-workflow-kit");
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({
      name: "codex-workflow-kit",
      source: { source: "local", path: "./plugins/codex-workflow-kit" },
    }));
    expect(plugin.name).toBe("codex-workflow-kit");
    expect(plugin.skills).toBe("./skills/");
    expect(plugin.mcpServers).toBe("./.mcp.json");
  });

  test("generic repo files do not mention downstream project names", () => {
    const offenders: string[] = [];
    for (const file of walk(repoRoot)) {
      if (file.includes("/.git/") || file.includes("/node_modules/") || file.endsWith("bun.lock")) continue;
      const text = readFileSync(file, "utf8");
      const banned = new RegExp([
        ["cura", "os"].join(""),
        ["cura", " os"].join(""),
        ["care", " oriented stack"].join(""),
      ].join("|"), "i");
      if (banned.test(text)) offenders.push(file.replace(repoRoot, ""));
    }

    expect(offenders).toEqual([]);
  });
});

function walk(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }

  return files;
}
