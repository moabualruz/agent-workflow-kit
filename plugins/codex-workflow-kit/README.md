# Codex Workflow Kit

Codex plugin pack for Agent Workflow Kit.

Native surfaces:

- Codex plugin manifest at `.codex-plugin/plugin.json`
- skill prompts under `skills/`
- MCP server manifest at `.mcp.json`
- MCP tools: `workflow`, `workflow_run`, `workflow_status`, `workflow_resume`, `workflow_stop`, `workflows`, `deep_research`

Runtime work stays in the shared core command service; this pack only adapts Codex packaging and invocation.
