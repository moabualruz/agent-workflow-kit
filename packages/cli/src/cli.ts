#!/usr/bin/env bun

import {
  createAliasModelPolicy,
  createWorkflowCommandService,
  dispatchWorkflowCommand,
  findWorkflowCommandSpec,
  inputForCliArguments,
  isPermissionMode,
  parseModelAliases,
  PERMISSION_MODES,
  type PermissionPolicy,
  permissionPolicyForMode,
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
  sessionModel?: string | undefined;
  tokenBudget?: number | undefined;
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
    sessionModel: args.sessionModel,
    tokenBudget: args.tokenBudget,
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
  let sessionModel: string | undefined;
  let tokenBudget: number | undefined;

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

    if (arg === "--session-model") {
      const value = argv[index + 1];
      if (!value) throw new Error("--session-model requires a value");
      sessionModel = value;
      index += 1;
      continue;
    }

    if (arg === "--token-budget") {
      const value = argv[index + 1];
      if (!value) throw new Error("--token-budget requires a value");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--token-budget requires a positive number");
      tokenBudget = parsed;
      index += 1;
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

  return { command, positional, projectRoot, json, argsJson, modelAliases, permissionMode, sessionModel, tokenBudget };
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
  if (!permissionMode) return undefined;
  if (!isPermissionMode(permissionMode)) {
    throw new Error(`Unsupported permission mode: ${permissionMode}. Expected one of: ${PERMISSION_MODES.join(", ")}`);
  }
  return permissionPolicyForMode(permissionMode);
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

  if (isRecord(value) && "runId" in value && "status" in value) {
    return formatRun(value as Record<string, unknown>);
  }

  if (isRecord(value) && "type" in value && "runId" in value) {
    return formatEvent(value as Record<string, unknown>);
  }

  return JSON.stringify(value);
}

// A run record: header line plus any error, result summary, and artifact path —
// instead of dropping everything but runId/name/status.
function formatRun(run: Record<string, unknown>): string {
  const lines = [[run.runId, run.name, run.status].filter(Boolean).join(" ")];
  if (typeof run.error === "string" && run.error) lines.push(`  error: ${run.error}`);
  if (run.result !== undefined) lines.push(`  result: ${summarize(run.result)}`);
  const artifacts = run.artifacts as { runJson?: string } | undefined;
  if (artifacts?.runJson) lines.push(`  run.json: ${artifacts.runJson}`);
  return lines.join("\n");
}

// An event: index, type, and the most relevant detail (title/model/error/message).
function formatEvent(event: Record<string, unknown>): string {
  const head = [event.index !== undefined ? `#${event.index}` : undefined, event.type]
    .filter(Boolean)
    .join(" ");
  const detail = event.title ?? event.message ?? event.error ?? event.model;
  return detail ? `${head} ${detail}` : head;
}

function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
