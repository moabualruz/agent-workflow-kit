import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callCodexWorkflowTool, codexWorkflowTools } from "../plugins/codex-workflow-kit/mcp/server";
import workflowKitExtension from "../plugins/pi-workflow-kit/extensions/index";

const repoRoot = new URL("..", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness direct workflow tools", () => {
  test("Codex MCP manifest exposes the workflow server", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "plugins/codex-workflow-kit/.mcp.json"), "utf8"));

    expect(manifest.mcpServers["agent-workflow-kit"]).toEqual(expect.objectContaining({
      command: "bun",
      cwd: ".",
    }));
    expect(manifest.mcpServers["agent-workflow-kit"].args).toContain("./mcp/server.ts");
  });

  test("Codex MCP tool handlers run and inspect persisted workflow state", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-codex-tools-"));
    roots.push(projectRoot);

    expect(codexWorkflowTools.map((tool) => tool.name)).toEqual([
      "workflow",
      "workflow_run",
      "workflow_status",
      "workflow_resume",
      "workflow_stop",
      "workflows",
      "deep_research",
    ]);

    const run = await callCodexWorkflowTool("workflow_run", {
      workflow: "no-write-probe",
      projectRoot,
    });
    const runPayload = JSON.parse(run.content[0]?.text ?? "{}");
    const status = await callCodexWorkflowTool("workflow_status", {
      runId: runPayload.runId,
      projectRoot,
    });

    expect(runPayload).toEqual(expect.objectContaining({ status: "completed", result: { ok: true } }));
    expect(JSON.parse(status.content[0]?.text ?? "{}")).toEqual(expect.objectContaining({
      runId: runPayload.runId,
      status: "completed",
    }));
  });

  test("Codex MCP server responds over stdio", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-codex-mcp-"));
    roots.push(projectRoot);
    const client = new Client({ name: "agent-workflow-kit-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["./mcp/server.ts"],
      cwd: join(repoRoot, "plugins/codex-workflow-kit"),
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "workflow_run",
        arguments: { workflow: "no-write-probe", projectRoot },
      });
      const content = result.content as Array<{ text?: string }> | undefined;
      const firstContent = content?.[0];
      const payload = firstContent && "text" in firstContent ? JSON.parse(String(firstContent.text)) : undefined;

      expect(tools.tools.map((tool) => tool.name)).toContain("workflow_run");
      expect(payload).toEqual(expect.objectContaining({ status: "completed", result: { ok: true } }));
    } finally {
      await client.close();
    }
  });

  test("Gemini MCP server responds over stdio with the shared workflow tools", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-gemini-mcp-"));
    roots.push(projectRoot);
    const client = new Client({ name: "agent-workflow-kit-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["./mcp-server.ts"],
      cwd: join(repoRoot, "plugins/gemini-workflow-kit"),
    });

    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: "workflow_run",
        arguments: { workflow: "no-write-probe", projectRoot },
      });
      const content = result.content as Array<{ text?: string }> | undefined;
      const firstContent = content?.[0];
      const payload = firstContent && "text" in firstContent ? JSON.parse(String(firstContent.text)) : undefined;

      expect(payload).toEqual(expect.objectContaining({ status: "completed", result: { ok: true } }));
    } finally {
      await client.close();
    }
  });

  test("Pi extension registers workflow commands and tools against the host API", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "awk-pi-tools-"));
    roots.push(projectRoot);
    const commands: Array<{ name: string }> = [];
    const tools: Array<{ name: string; run: (input?: Record<string, unknown>) => unknown | Promise<unknown> }> = [];

    const extension = workflowKitExtension({
      registerCommand: (command: { name: string }) => commands.push(command),
      registerTool: (tool: { name: string; run: (input?: Record<string, unknown>) => unknown | Promise<unknown> }) => tools.push(tool),
    });

    expect(extension.name).toBe("pi-workflow-kit");
    expect(commands.map((command) => command.name)).toEqual([
      "workflow",
      "workflow-run",
      "workflow-status",
      "workflow-resume",
      "workflow-stop",
      "workflows",
      "deep-research",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "workflow_run",
      "workflow_status",
      "workflow_resume",
      "workflow_stop",
      "workflows",
      "deep_research",
    ]);

    const run = await tools.find((tool) => tool.name === "workflow_run")?.run({
      workflow: "no-write-probe",
      projectRoot,
    });

    expect(run).toEqual(expect.objectContaining({ status: "completed", result: { ok: true } }));
  });
});
