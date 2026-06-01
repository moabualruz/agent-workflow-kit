import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowCommandNames, workflowToolNames } from "../packages/core/src/index";
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

    expect(Object.keys(hooks.tool ?? {})).toEqual(workflowToolNames);

    const generated = JSON.parse(String(await hooks.tool?.workflow?.execute({
      task: "native generated",
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
    } as any)));
    const generatedName = generated.args.workflow.name;

    expect(generated).toEqual(expect.objectContaining({
      name: "native-generated",
      status: "completed",
      result: expect.objectContaining({ ok: true, task: "native generated" }),
      args: expect.objectContaining({
        task: "native generated",
        workflow: {
          name: "native-generated",
          path: join(projectRoot, ".agent-workflow-kit", "workflows", "native-generated.js"),
        },
      }),
    }));

    const generatedRun = JSON.parse(String(await hooks.tool?.workflow_run?.execute({
      workflow: generatedName,
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
    } as any)));

    expect(generatedRun).toEqual(expect.objectContaining({
      name: "native-generated",
      status: "completed",
      result: expect.objectContaining({ ok: true, task: "native generated" }),
    }));

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

    const events = JSON.parse(String(await hooks.tool?.workflow_events?.execute({
      runId: generatedRun.runId,
      projectRoot,
    }, {
      directory: projectRoot,
      worktree: projectRoot,
    } as any)));
    expect(events).toContainEqual(expect.objectContaining({ runId: generatedRun.runId, type: "run:completed" }));
  });

  test("OpenCode native tools inherit model aliases from the harness environment", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-opencode-tools-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "model-alias.js"), `
export default async function ({ agent }) {
  return agent("model probe", { model: "sonnet" });
}
`);
    const previousAliases = process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES;
    process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES = "sonnet=provider/balanced-worker";

    try {
      const hooks = await openCodeWorkflowServer({
        directory: projectRoot,
        worktree: projectRoot,
      } as any);

      const run = JSON.parse(String(await hooks.tool?.workflow_run?.execute({
        workflow: "model-alias",
        projectRoot,
      }, {
        directory: projectRoot,
        worktree: projectRoot,
      } as any)));
      const events = JSON.parse(String(await hooks.tool?.workflow_events?.execute({
        runId: run.runId,
        projectRoot,
      }, {
        directory: projectRoot,
        worktree: projectRoot,
      } as any)));

      expect(events).toContainEqual(expect.objectContaining({
        type: "agent:start",
        requestedModel: "sonnet",
        model: "provider/balanced-worker",
      }));
    } finally {
      if (previousAliases === undefined) delete process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES;
      else process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES = previousAliases;
    }
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
    expect(commands.map((command) => command.name)).toEqual(workflowCommandNames);
    expect(tools.map((tool) => tool.name)).toEqual(workflowToolNames);

    const generated = await commands.find((command) => command.name === "workflow")?.handler("native generated");
    const generatedWorkflow = (generated as any).args.workflow;

    expect(generated).toEqual(expect.objectContaining({
      name: "native-generated",
      status: "completed",
      result: expect.objectContaining({ ok: true, task: "native generated" }),
      args: expect.objectContaining({
        task: "native generated",
        workflow: {
          name: "native-generated",
          path: join(process.cwd(), ".agent-workflow-kit", "workflows", "native-generated.js"),
        },
      }),
    }));

    const generatedRun = await commands.find((command) => command.name === "workflow-run")?.handler(generatedWorkflow.name);

    expect(generatedRun).toEqual(expect.objectContaining({
      name: "native-generated",
      status: "completed",
      result: expect.objectContaining({ ok: true, task: "native generated" }),
    }));

    const commandRun = await commands.find((command) => command.name === "workflow-run")?.handler("no-write-probe");
    expect(commandRun).toEqual(expect.objectContaining({ status: "completed", result: { ok: true } }));

    const toolGenerated = await tools.find((tool) => tool.name === "workflow")?.execute("call-generated", {
      task: "tool generated",
      projectRoot,
    });
    const toolGeneratedName = (toolGenerated as any).details.args.workflow.name;

    expect(toolGenerated).toEqual(expect.objectContaining({
      content: [{ type: "text", text: expect.stringContaining("\"name\":\"tool-generated\"") }],
      details: expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ ok: true, task: "tool generated" }),
      }),
    }));

    const toolGeneratedRun = await tools.find((tool) => tool.name === "workflow_run")?.execute("call-generated-run", {
      workflow: toolGeneratedName,
      projectRoot,
    });

    expect(toolGeneratedRun).toEqual(expect.objectContaining({
      details: expect.objectContaining({
        name: "tool-generated",
        status: "completed",
        result: expect.objectContaining({ ok: true, task: "tool generated" }),
      }),
    }));

    const toolRun = await tools.find((tool) => tool.name === "workflow_run")?.execute("call-1", {
      workflow: "no-write-probe",
      projectRoot,
    });

    expect(toolRun).toEqual(expect.objectContaining({
      content: [{ type: "text", text: expect.stringContaining("\"status\":\"completed\"") }],
      details: expect.objectContaining({ status: "completed", result: { ok: true } }),
    }));
  });

  test("Pi native tools inherit model aliases from the harness environment", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-pi-tools-"));
    roots.push(projectRoot);
    const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
    mkdirSync(workflowsRoot, { recursive: true });
    writeFileSync(join(workflowsRoot, "model-alias.js"), `
export default async function ({ agent }) {
  return agent("model probe", { model: "sonnet" });
}
`);
    const previousAliases = process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES;
    process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES = "sonnet=provider/balanced-worker";

    try {
      const extension = workflowKitExtension();
      const run = await extension.tools.find((tool) => tool.name === "workflow_run")?.execute("call-model", {
        workflow: "model-alias",
        projectRoot,
      });
      const events = await extension.tools.find((tool) => tool.name === "workflow_events")?.execute("call-events", {
        runId: (run as any).details.runId,
        projectRoot,
      });

      expect((events as any).details).toContainEqual(expect.objectContaining({
        type: "agent:start",
        requestedModel: "sonnet",
        model: "provider/balanced-worker",
      }));
    } finally {
      if (previousAliases === undefined) delete process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES;
      else process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES = previousAliases;
    }
  });

  test("Antigravity plugin is skills-only and CLI based", () => {
    const pluginRoot = join(repoRoot, "plugins/antigravity-workflow-kit");
    const plugin = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
    const skill = readFileSync(join(pluginRoot, "skills/workflow-run/SKILL.md"), "utf8");

    expect(plugin.name).toBe("antigravity-workflow-kit");
    expect(existsSync(join(pluginRoot, "mcp_config.json"))).toBe(false);
    expect(skill).toContain("agent-workflow-kit workflow-run");
    expect(skill.toLowerCase()).not.toContain("mcp");
  });
});
