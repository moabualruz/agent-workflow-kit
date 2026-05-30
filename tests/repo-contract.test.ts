import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("standalone repository contract", () => {
  test("ships one implementation pack per non-Claude CLI", () => {
    for (const dir of [
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

  test("keeps Claude as reference-only because Claude has native Workflows", () => {
    expect(existsSync(join(repoRoot, "plugins/claude-workflow-kit"))).toBe(false);
    expect(existsSync(join(repoRoot, "reference/claude-workflows/README.md"))).toBe(true);
    expect(existsSync(join(repoRoot, "reference/claude-workflows/no-write-probe.js"))).toBe(true);
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

  test("OpenCode plugin exposes a server entrypoint accepted by opencode plugin install", () => {
    const plugin = JSON.parse(readFileSync(join(repoRoot, "plugins/opencode-workflow-kit/package.json"), "utf8"));

    expect(plugin.exports?.["./server"] ?? plugin.main).toBeDefined();
  });

  test("root package exposes the shared workflow CLI", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(rootPackage.bin?.["agent-workflow-kit"]).toBe("packages/cli/src/cli.ts");
  });

  test("non-Claude command shims point at the shared CLI instead of placeholder prose", () => {
    const commandFiles = [
      "plugins/codex-workflow-kit/skills/workflow-kit/SKILL.md",
      "plugins/gemini-workflow-kit/commands/workflow-run.toml",
      "plugins/opencode-workflow-kit/commands/workflow-run.md",
      "plugins/grok-workflow-kit/commands/workflow-run.md",
      "plugins/pi-workflow-kit/skills/workflow-kit/SKILL.md",
    ];

    for (const file of commandFiles) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(text).toContain("agent-workflow-kit");
      expect(text).toContain("workflow-run");
      expect(text).toContain("workflow-status");
      expect(text).toContain("workflow-resume");
      expect(text).toContain("workflow-stop");
      expect(text).toContain("deep-research");
    }
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
