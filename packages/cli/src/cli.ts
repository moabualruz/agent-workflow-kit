#!/usr/bin/env bun

import {
  createWorkflowCommandService,
  denyDynamicWorkflowPolicy,
  type PermissionPolicy,
} from "@agent-workflow-kit/core";

type ParsedArgs = {
  command: string | undefined;
  positional: string[];
  projectRoot: string;
  json: boolean;
  permissionMode?: string | undefined;
};

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(argv: string[]) {
  const args = parseArgs(argv);
  const service = createWorkflowCommandService({
    projectRoot: args.projectRoot,
    permissionPolicy: permissionPolicyFor(args.permissionMode),
  });

  switch (args.command) {
    case "workflow": {
      const task = args.positional.join(" ").trim();
      const run = await service.runAdHocWorkflow(task);
      print(run, args.json);
      return;
    }

    case "workflow-run": {
      const name = args.positional[0];
      const run = await service.runSavedWorkflow(name ?? "");
      print(run, args.json);
      return;
    }

    case "workflow-status": {
      const runId = args.positional[0];
      const run = service.getRun(runId ?? "");
      print(run, args.json);
      return;
    }

    case "workflow-events": {
      const runId = args.positional[0];
      print(service.eventsFor(runId ?? ""), args.json);
      return;
    }

    case "workflows": {
      print(service.listRuns(), args.json);
      return;
    }

    case "workflow-resume": {
      const runId = args.positional[0];
      print(service.resumeRun(runId ?? ""), args.json);
      return;
    }

    case "workflow-stop": {
      const runId = args.positional[0];
      print(service.stopRun(runId ?? ""), args.json);
      return;
    }

    case "deep-research": {
      const question = args.positional.join(" ").trim();
      const run = await service.runDeepResearch(question);
      print(run, args.json);
      return;
    }

    default:
      throw new Error("Expected command: workflow, workflow-run, workflow-status, workflow-events, workflow-resume, workflow-stop, workflows, deep-research");
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let projectRoot = process.cwd();
  let json = false;
  let permissionMode: string | undefined;
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--project-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--project-root requires a value");
      projectRoot = value;
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--permission-mode") {
      const value = argv[index + 1];
      if (!value) throw new Error("--permission-mode requires a value");
      permissionMode = value;
      index += 1;
      continue;
    }

    if (!command) {
      command = arg;
      continue;
    }

    positional.push(arg);
  }

  return { command, positional, projectRoot, json, permissionMode };
}

function permissionPolicyFor(permissionMode: string | undefined): PermissionPolicy | undefined {
  if (!permissionMode || permissionMode === "bypassPermissions") return undefined;
  if (permissionMode === "dontAsk") return denyDynamicWorkflowPolicy;
  throw new Error(`Unsupported permission mode: ${permissionMode}`);
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }

  console.log(formatHuman(value));
}

function formatHuman(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatHuman(entry)).join("\n");
  }

  if (value && typeof value === "object" && "runId" in value && "status" in value) {
    const run = value as { runId: string; name?: string; status: string };
    return [run.runId, run.name, run.status].filter(Boolean).join(" ");
  }

  return JSON.stringify(value);
}
