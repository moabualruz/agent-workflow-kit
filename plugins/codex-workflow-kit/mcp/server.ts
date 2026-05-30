#!/usr/bin/env bun

import {
  callWorkflowMcpTool,
  connectWorkflowMcpServer,
  createWorkflowMcpServer,
  workflowMcpTools,
} from "../../../packages/mcp/src/index";

export const codexWorkflowTools = workflowMcpTools;
export const callCodexWorkflowTool = callWorkflowMcpTool;

export function createCodexWorkflowMcpServer() {
  return createWorkflowMcpServer({ name: "agent-workflow-kit", version: "0.1.0" });
}

if (import.meta.main) {
  await connectWorkflowMcpServer({ name: "agent-workflow-kit", version: "0.1.0" });
}
