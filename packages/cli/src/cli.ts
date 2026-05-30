#!/usr/bin/env bun

import {
  createFileStore,
  createWorkflowRuntime,
  type WorkflowScript,
} from "@agent-workflow-kit/core";

type ParsedArgs = {
  command: string | undefined;
  positional: string[];
  projectRoot: string;
  json: boolean;
};

const workflows = new Map<string, WorkflowScript>([
  [
    "no-write-probe",
    async ({ phase, agent, log }) => {
      phase("Probe");
      log("no-write probe entered");
      return agent("Return exact JSON {\"ok\":true}");
    },
  ],
]);

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(argv: string[]) {
  const args = parseArgs(argv);
  const store = createFileStore({ projectRoot: args.projectRoot });

  switch (args.command) {
    case "workflow-run": {
      const name = args.positional[0];
      if (!name) throw new Error("workflow-run requires workflow name");
      const script = workflows.get(name);
      if (!script) throw new Error(`Unknown workflow: ${name}`);
      const runtime = createWorkflowRuntime({
        store,
        agent: async () => ({ ok: true }),
      });
      const run = await runtime.run({ name, script });
      print(run, args.json);
      return;
    }

    case "workflow-status": {
      const runId = args.positional[0];
      if (!runId) throw new Error("workflow-status requires run id");
      const run = store.getRun(runId);
      print(run, args.json);
      return;
    }

    case "workflows": {
      print(store.listRuns(), args.json);
      return;
    }

    default:
      throw new Error("Expected command: workflow-run, workflow-status, workflows");
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let projectRoot = process.cwd();
  let json = false;
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

    if (!command) {
      command = arg;
      continue;
    }

    positional.push(arg);
  }

  return { command, positional, projectRoot, json };
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
