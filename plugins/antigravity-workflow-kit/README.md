# Antigravity Workflow Kit

Skills-only Antigravity plugin that routes workflow commands through the shared `agent-workflow-kit` CLI.

Install:

```sh
agy plugin validate ./plugins/antigravity-workflow-kit
agy plugin install ./plugins/antigravity-workflow-kit
```

Available skills mirror the shared command catalog:

- `/workflow`
- `/workflow-run`
- `/workflow-status`
- `/workflow-events`
- `/workflow-resume`
- `/workflow-stop`
- `/workflows`
- `/deep-research`

This plugin intentionally ships only skills. Runtime state, event streams, resume/stop operations, artifacts, saved workflow files, and permission behavior are owned by `@agent-workflow-kit/core` and exposed through the CLI.
