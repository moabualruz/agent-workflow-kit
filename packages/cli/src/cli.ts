#!/usr/bin/env bun

import {
  createAliasModelPolicy,
  createWorkflowCommandService,
  denyDynamicWorkflowPolicy,
  dispatchWorkflowCommand,
  findWorkflowCommandSpec,
  inputForCliArguments,
  type PermissionPolicy,
  workflowCommandNames,
} from "@agent-workflow-kit/core";

type ParsedArgs = {
  command: string | undefined;
  positional: string[];
  projectRoot: string;
  json: boolean;
  modelAliases: Record<string, string>;
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
    modelPolicy: createAliasModelPolicy(args.modelAliases),
    permissionPolicy: permissionPolicyFor(args.permissionMode),
  });
  const spec = findWorkflowCommandSpec(args.command);

  if (!spec) throw new Error(`Expected command: ${workflowCommandNames.join(", ")}`);

  const result = await dispatchWorkflowCommand(service, spec.name, inputForCliArguments(spec, args.positional));
  print(result, args.json);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let projectRoot = process.cwd();
  let json = false;
  const modelAliases: Record<string, string> = {};
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

    if (arg === "--model-alias") {
      const value = argv[index + 1];
      if (!value) throw new Error("--model-alias requires a value");
      const [alias, ...modelParts] = value.split("=");
      const model = modelParts.join("=").trim();
      if (!alias?.trim() || !model) throw new Error("--model-alias requires alias=model");
      modelAliases[alias.trim()] = model;
      index += 1;
      continue;
    }

    if (!command) {
      command = arg;
      continue;
    }

    positional.push(arg);
  }

  return { command, positional, projectRoot, json, modelAliases, permissionMode };
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
