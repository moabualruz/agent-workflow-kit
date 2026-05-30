import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server as openCodeWorkflowServer } from "../plugins/opencode-workflow-kit/src/index";
import workflowKitExtension from "../plugins/pi-workflow-kit/extensions/index";

const repoRoot = new URL("..", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness direct workflow tools", () => {
  test("Codex plugin remains skill and CLI based", () => {
    const plugin = JSON.parse(readFileSync(join(repoRoot, "plugins/codex-workflow-kit/.codex-plugin/plugin.json"), "utf8"));
    const skill = readFileSync(join(repoRoot, "plugins/codex-workflow-kit/skills/workflow-kit/SKILL.md"), "utf8");

    expect(plugin.skills).toBe("./skills/");
    expect(plugin.mcpServers).toBeUndefined();
    expect(skill).toContain("agent-workflow-kit workflow-run");
    expect(skill.toLowerCase()).not.toContain("mcp");
  });

  test("Gemini extension remains command and CLI based", () => {
    const extension = JSON.parse(readFileSync(join(repoRoot, "plugins/gemini-workflow-kit/gemini-extension.json"), "utf8"));
    const command = readFileSync(join(repoRoot, "plugins/gemini-workflow-kit/commands/workflow-run.toml"), "utf8");

    expect(extension.mcpServers).toBeUndefined();
    expect(command).toContain("agent-workflow-kit workflow-run");
    expect(command.toLowerCase()).not.toContain("mcp");
  });

  test("OpenCode plugin registers native workflow tools", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-opencode-tools-"));
    roots.push(projectRoot);

    const hooks = await openCodeWorkflowServer({
      directory: projectRoot,
      worktree: projectRoot,
    } as any);

    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "workflow",
      "workflow_run",
      "workflow_status",
      "workflow_events",
      "workflow_resume",
      "workflow_stop",
      "workflows",
      "deep_research",
    ]);

    const result = await hooks.tool?.workflow_run?.execute({
      workflow: "no-write-probe",
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
    } as any);

    expect(JSON.parse(String(result))).toEqual(expect.objectContaining({
      status: "completed",
      result: { ok: true },
    }));
  });

  test("Pi extension registers workflow commands and tools against the host API", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-pi-tools-"));
    roots.push(projectRoot);
    const commands: Array<{ name: string; description: string; handler: (args?: string) => unknown | Promise<unknown> }> = [];
    const tools: Array<{ name: string; parameters: unknown; execute: (_toolCallId: string, input: Record<string, unknown>) => unknown | Promise<unknown> }> = [];

    const extension = workflowKitExtension({
      registerCommand: (name: string, command: { description: string; handler: (args?: string) => unknown | Promise<unknown> }) => {
        commands.push({ name, ...command });
      },
      registerTool: (tool: { name: string; parameters: unknown; execute: (_toolCallId: string, input: Record<string, unknown>) => unknown | Promise<unknown> }) => {
        tools.push(tool);
      },
    });

    expect(extension.name).toBe("pi-workflow-kit");
    expect(commands.map((command) => command.name)).toEqual([
      "workflow",
      "workflow-run",
      "workflow-status",
      "workflow-events",
      "workflow-resume",
      "workflow-stop",
      "workflows",
      "deep-research",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "workflow_run",
      "workflow_status",
      "workflow_events",
      "workflow_resume",
      "workflow_stop",
      "workflows",
      "deep_research",
    ]);

    const commandRun = await commands.find((command) => command.name === "workflow-run")?.handler("no-write-probe");
    expect(commandRun).toEqual(expect.objectContaining({ status: "completed", result: { ok: true } }));

    const toolRun = await tools.find((tool) => tool.name === "workflow_run")?.execute("call-1", {
      workflow: "no-write-probe",
      projectRoot,
    });

    expect(toolRun).toEqual(expect.objectContaining({
      content: [{ type: "text", text: expect.stringContaining("\"status\":\"completed\"") }],
      details: expect.objectContaining({ status: "completed", result: { ok: true } }),
    }));
  });
});
