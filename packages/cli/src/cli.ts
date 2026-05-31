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
  argsJson?: string | undefined;
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

  const input = inputForCliCommand(spec, args);
  const result = await dispatchWorkflowCommand(service, spec.name, input);
  print(result, args.json);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let projectRoot = process.cwd();
  let json = false;
  const modelAliases: Record<string, string> = parseModelAliases(process.env.AGENT_WORKFLOW_KIT_MODEL_ALIASES);
  let argsJson: string | undefined;
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

    if (arg === "--args-json") {
      const value = argv[index + 1];
      if (!value) throw new Error("--args-json requires a value");
      argsJson = value;
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

  return { command, positional, projectRoot, json, argsJson, modelAliases, permissionMode };
}

function inputForCliCommand(
  spec: NonNullable<ReturnType<typeof findWorkflowCommandSpec>>,
  args: ParsedArgs,
): Record<string, unknown> {
  const input = inputForCliArguments(spec, args.positional);
  const positionalArgsJson = spec.acceptsArgs ? args.positional[1] : undefined;
  const argsJson = args.argsJson ?? positionalArgsJson;

  if (!argsJson) return input;
  if (!spec.acceptsArgs) throw new Error(`--args-json does not apply to ${spec.name}`);

  return {
    ...input,
    args: parseWorkflowArgsJson(argsJson),
  };
}

function permissionPolicyFor(permissionMode: string | undefined): PermissionPolicy | undefined {
  if (!permissionMode || permissionMode === "bypassPermissions") return undefined;
  if (permissionMode === "dontAsk") return denyDynamicWorkflowPolicy;
  throw new Error(`Unsupported permission mode: ${permissionMode}`);
}

function parseModelAliases(value: string | undefined): Record<string, string> {
  const aliases: Record<string, string> = {};
  if (!value?.trim()) return aliases;

  for (const entry of value.split(",")) {
    const [alias, ...modelParts] = entry.split("=");
    const model = modelParts.join("=").trim();
    if (!alias?.trim() || !model) throw new Error("AGENT_WORKFLOW_KIT_MODEL_ALIASES entries must be alias=model");
    aliases[alias.trim()] = model;
  }

  return aliases;
}

function parseWorkflowArgsJson(value: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--args-json requires valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--args-json requires a JSON object");
  }

  return parsed as Record<string, unknown>;
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
