#!/usr/bin/env bun

import { connectWorkflowMcpServer } from "../../packages/mcp/src/index";

if (import.meta.main) {
  await connectWorkflowMcpServer({ name: "agent-workflow-kit", version: "0.1.0" });
}
