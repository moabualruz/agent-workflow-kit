import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { workflowCommandNames } from "../packages/core/src/index";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("standalone repository contract", () => {
  test("ships one implementation pack per non-Claude CLI", () => {
    for (const dir of [
      "plugins/codex-workflow-kit",
      "plugins/gemini-workflow-kit",
      "plugins/opencode-workflow-kit",
      "plugins/grok-workflow-kit",
      "plugins/pi-workflow-kit",
      "plugins/antigravity-workflow-kit",
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
    expect(plugin.mcpServers).toBeUndefined();
  });

  test("ships no MCP workflow surfaces", () => {
    const offenders: string[] = [];
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(rootPackage.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();

    for (const file of walk(repoRoot)) {
      const relative = file.replace(repoRoot, "");
      if (relative.includes("/.git/") || relative.includes("/node_modules/") || relative.endsWith("bun.lock")) continue;
      // .agent-workflow-kit/ is gitignored runtime + research data, never shipped.
      if (relative.includes(".agent-workflow-kit/")) continue;
      if (relative.includes("tests/")) continue;

      const lowerPath = relative.toLowerCase();
      if (lowerPath.includes("/mcp") || lowerPath.includes(".mcp")) offenders.push(relative);

      const text = readFileSync(file, "utf8");
      if (/\bmcp\b|modelcontextprotocol/i.test(text)) offenders.push(relative);
    }

    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  test("lockfile does not ship first-party MCP packages or SDK entries", () => {
    const lockfile = readFileSync(join(repoRoot, "bun.lock"), "utf8");

    expect(lockfile).not.toMatch(/packages\/mcp|@agent-workflow-kit\/mcp|@modelcontextprotocol\/sdk/);
  });

  test("OpenCode plugin exposes a server entrypoint accepted by opencode plugin install", () => {
    const plugin = JSON.parse(readFileSync(join(repoRoot, "plugins/opencode-workflow-kit/package.json"), "utf8"));

    expect(plugin.exports?.["./server"] ?? plugin.main).toBeDefined();
  });

  test("root package exposes the shared workflow CLI", () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(rootPackage.bin?.["agent-workflow-kit"]).toBe("packages/cli/src/cli.ts");
  });

  test("README command summary names every shared workflow command", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const summary = readme.match(/Use familiar commands: (?<commands>.+)\./)?.groups?.commands ?? "";

    for (const command of workflowCommandNames) {
      expect(summary, command).toContain(`\`${command}\``);
    }
  });

  test("source and docs files stay text-clean", () => {
    const offenders: string[] = [];
    for (const file of walk(repoRoot)) {
      const relative = file.replace(repoRoot, "");
      if (relative.includes("/.git/") || relative.includes("/node_modules/") || relative.endsWith("bun.lock")) continue;
      if (!/\.(?:ts|tsx|js|jsx|json|md|toml|yml|yaml|txt|gitignore)$/.test(relative)) continue;

      const bytes = readFileSync(file);
      if (bytes.includes(0)) offenders.push(relative);
    }

    expect(offenders).toEqual([]);
  });

  test("documentation does not present shell pipes as ultracode action placeholders", () => {
    const offenders: string[] = [];
    for (const file of walk(repoRoot)) {
      const relative = file.replace(repoRoot, "");
      if (relative.includes("/.git/") || relative.includes("/node_modules/") || relative.endsWith("bun.lock")) continue;
      if (!/\.(?:md|toml)$/.test(relative)) continue;

      const text = readFileSync(file, "utf8");
      if (text.includes("agent-workflow-kit ultracode on|off|status --json")) offenders.push(relative);
    }

    expect(offenders).toEqual([]);
  });

  test("non-Claude command shims point at the shared CLI instead of placeholder prose", () => {
    const commandFiles = [
      "plugins/codex-workflow-kit/skills/workflow-kit/SKILL.md",
      "plugins/gemini-workflow-kit/commands/workflow-run.toml",
      "plugins/opencode-workflow-kit/commands/workflow-run.md",
      "plugins/grok-workflow-kit/commands/workflow-run.md",
      "plugins/pi-workflow-kit/skills/workflow-kit/SKILL.md",
      "plugins/antigravity-workflow-kit/skills/workflow-run/SKILL.md",
    ];

    for (const file of commandFiles) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(text).toContain("agent-workflow-kit");
      expect(text).toContain("workflow-run");
      expect(text).toContain("workflow-status");
      expect(text).toContain("workflow-events");
      expect(text).toContain("workflow-resume");
      expect(text).toContain("workflow-stop");
      expect(text).toContain("deep-research");
      expect(text).toContain("ultracode");
    }
  });

  test("file-command harnesses expose every shared workflow command", () => {
    const harnesses = [
      { root: "plugins/gemini-workflow-kit/commands", extension: ".toml" },
      { root: "plugins/opencode-workflow-kit/commands", extension: ".md" },
      { root: "plugins/grok-workflow-kit/commands", extension: ".md" },
    ];

    for (const harness of harnesses) {
      for (const command of workflowCommandNames) {
        const file = join(repoRoot, harness.root, `${command}${harness.extension}`);
        expect(existsSync(file), `${harness.root}/${command}${harness.extension}`).toBe(true);
        expect(readFileSync(file, "utf8")).toContain(`agent-workflow-kit ${command}`);
      }
    }
  });

  test("Antigravity plugin exposes every shared workflow command as a skill slash-command", () => {
    for (const command of workflowCommandNames) {
      const file = join(repoRoot, "plugins/antigravity-workflow-kit/skills", command, "SKILL.md");
      expect(existsSync(file), `antigravity skill ${command}`).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toContain(`name: ${command}`);
      expect(text).toContain(`agent-workflow-kit ${command}`);
    }
  });

  test("Ultracode guidance copies stay synced from the canonical docs block", () => {
    const canonical = normalizedUltracodeBlock(readFileSync(join(repoRoot, "docs/ultracode.md"), "utf8"));
    for (const file of [
      "README.md",
      "plugins/antigravity-workflow-kit/skills/workflow/SKILL.md",
      "plugins/codex-workflow-kit/skills/workflow-kit/SKILL.md",
      "plugins/gemini-workflow-kit/commands/workflow.toml",
      "plugins/grok-workflow-kit/skills/workflow-kit/SKILL.md",
      "plugins/opencode-workflow-kit/commands/workflow.md",
      "plugins/pi-workflow-kit/skills/workflow-kit/SKILL.md",
    ]) {
      expect(normalizedUltracodeBlock(readFileSync(join(repoRoot, file), "utf8")), file).toBe(canonical);
    }
  });

  test("Ultracode guidance separates standing opt-in, keyword trigger, and model effort", () => {
    const canonical = normalizedUltracodeBlock(readFileSync(join(repoRoot, "docs/ultracode.md"), "utf8"));

    expect(canonical).toContain("standing opt-in");
    expect(canonical).toContain("keyword trigger");
    expect(canonical).toContain("model effort");
    expect(canonical).toContain("orchestration-only");
  });

  test("ignores Claude runtime locks without hiding project workflows", () => {
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    const ignoredLines = gitignore.split(/\r?\n/).map((line) => line.trim());

    expect(gitignore).toContain(".claude/scheduled_tasks.lock");
    expect(ignoredLines).not.toContain(".claude/");
    expect(ignoredLines).not.toContain(".claude/workflows");
    expect(ignoredLines).not.toContain(".claude/workflows/");
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
    if (entry === ".git" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...walk(path));
    } else {
      files.push(path);
    }
  }

  return files;
}

function normalizedUltracodeBlock(text: string): string {
  const match = /<!-- AGENT_WORKFLOW_KIT_ULTRACODE_START -->([\s\S]*?)<!-- AGENT_WORKFLOW_KIT_ULTRACODE_END -->/.exec(text);
  expect(match?.[1]).toBeDefined();
  return (match?.[1] ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*#\s?/gm, "")
    .trim();
}
