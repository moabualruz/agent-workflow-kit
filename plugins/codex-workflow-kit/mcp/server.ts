#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWorkflowCommandService } from "../../../packages/core/src/index";

type WorkflowToolName =
  | "workflow"
  | "workflow_run"
  | "workflow_status"
  | "workflow_resume"
  | "workflow_stop"
  | "workflows"
  | "deep_research";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

type WorkflowTool = {
  name: WorkflowToolName;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
};

const optionalProjectRoot = {
  projectRoot: z.string().optional().describe("Project root for .agent-workflow-kit state. Defaults to the MCP server cwd."),
};

export const codexWorkflowTools: WorkflowTool[] = [
  {
    name: "workflow",
    description: "Run an ad hoc no-write workflow for a task.",
    inputSchema: { task: z.string(), ...optionalProjectRoot },
  },
  {
    name: "workflow_run",
    description: "Run a saved Agent Workflow Kit workflow.",
    inputSchema: { workflow: z.string(), ...optionalProjectRoot },
  },
  {
    name: "workflow_status",
    description: "Read workflow run status from persisted state.",
    inputSchema: { runId: z.string(), ...optionalProjectRoot },
  },
  {
    name: "workflow_resume",
    description: "Resume a stopped workflow record without deleting artifacts.",
    inputSchema: { runId: z.string(), ...optionalProjectRoot },
  },
  {
    name: "workflow_stop",
    description: "Stop a workflow record while keeping it resumable.",
    inputSchema: { runId: z.string(), ...optionalProjectRoot },
  },
  {
    name: "workflows",
    description: "List persisted workflow runs without transcript spam.",
    inputSchema: optionalProjectRoot,
  },
  {
    name: "deep_research",
    description: "Run the bundled deep-research workflow.",
    inputSchema: { question: z.string(), ...optionalProjectRoot },
  },
];

export async function callCodexWorkflowTool(name: string, input: Record<string, unknown> = {}): Promise<ToolResult> {
  const service = createWorkflowCommandService({
    projectRoot: readString(input.projectRoot) ?? process.cwd(),
  });

  switch (name) {
    case "workflow":
      return jsonContent(await service.runAdHocWorkflow(requireString(input.task, "workflow requires task")));
    case "workflow_run":
      return jsonContent(await service.runSavedWorkflow(requireString(input.workflow, "workflow_run requires workflow")));
    case "workflow_status":
      return jsonContent(service.getRun(requireString(input.runId, "workflow_status requires runId")));
    case "workflow_resume":
      return jsonContent(service.resumeRun(requireString(input.runId, "workflow_resume requires runId")));
    case "workflow_stop":
      return jsonContent(service.stopRun(requireString(input.runId, "workflow_stop requires runId")));
    case "workflows":
      return jsonContent(service.listRuns());
    case "deep_research":
      return jsonContent(await service.runDeepResearch(requireString(input.question, "deep_research requires question")));
    default:
      throw new Error(`Unknown workflow tool: ${name}`);
  }
}

export function createCodexWorkflowMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-workflow-kit",
    version: "0.1.0",
  });

  for (const tool of codexWorkflowTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => callCodexWorkflowTool(tool.name, input),
    );
  }

  return server;
}

if (import.meta.main) {
  const server = createCodexWorkflowMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function jsonContent(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function requireString(value: unknown, message: string): string {
  const text = readString(value);
  if (!text) throw new Error(message);
  return text;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
