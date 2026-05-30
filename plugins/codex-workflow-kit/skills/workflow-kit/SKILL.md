---
name: workflow-kit
description: Run, inspect, resume, and stop Agent Workflow Kit workflows from Codex.
---

# Workflow Kit

Use this skill when the user asks for workflow orchestration, `/workflow`, `/workflows`, `/workflow-run`, `/workflow-status`, `/workflow-resume`, `/workflow-stop`, or `/deep-research`.

Use the shared CLI or script calls directly:

```sh
agent-workflow-kit workflow-run no-write-probe --json
agent-workflow-kit workflow-status <run-id> --json
agent-workflow-kit workflow-resume <run-id> --json
agent-workflow-kit workflow-stop <run-id> --json
agent-workflow-kit workflows --json
agent-workflow-kit deep-research "<question>" --json
```

Return run ids and artifact paths, not full intermediate transcripts.
