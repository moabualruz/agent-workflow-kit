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
  type AgentExecutionLimits,
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
  resumeFromRunId?: string | undefined;
  disableWorkflows: boolean;
  maxAgentCalls?: number | undefined;
  maxConcurrentAgents?: number | undefined;
  maxChildWorkflowDepth?: number | undefined;
  maxEstimatedTokens?: number | undefined;
  stopOnEstimatedTokenLimit: boolean;
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
    sessionDisableWorkflows: args.disableWorkflows,
    executionLimits: executionLimitsFor(args),
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
  let resumeFromRunId: string | undefined;
  let disableWorkflows = false;
  let maxAgentCalls: number | undefined;
  let maxConcurrentAgents: number | undefined;
  let maxChildWorkflowDepth: number | undefined;
  let maxEstimatedTokens: number | undefined;
  let stopOnEstimatedTokenLimit = false;

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

    if (arg === "--disable-workflows") {
      disableWorkflows = true;
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

    if (arg === "--max-agent-calls") {
      const value = argv[index + 1];
      if (!value) throw new Error("--max-agent-calls requires a value");
      maxAgentCalls = parsePositiveInteger(value, "--max-agent-calls");
      index += 1;
      continue;
    }

    if (arg === "--max-child-workflow-depth") {
      const value = argv[index + 1];
      if (!value) throw new Error("--max-child-workflow-depth requires a value");
      maxChildWorkflowDepth = parseNonNegativeInteger(value, "--max-child-workflow-depth");
      index += 1;
      continue;
    }

    if (arg === "--max-estimated-tokens") {
      const value = argv[index + 1];
      if (!value) throw new Error("--max-estimated-tokens requires a value");
      maxEstimatedTokens = parsePositiveInteger(value, "--max-estimated-tokens");
      index += 1;
      continue;
    }

    if (arg === "--stop-on-estimated-token-limit") {
      stopOnEstimatedTokenLimit = true;
      continue;
    }

    if (arg === "--max-concurrent-agents") {
      const value = argv[index + 1];
      if (!value) throw new Error("--max-concurrent-agents requires a value");
      maxConcurrentAgents = parsePositiveInteger(value, "--max-concurrent-agents");
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

    if (arg === "--resume-from-run-id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--resume-from-run-id requires a value");
      resumeFromRunId = value;
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

  return { command, positional, projectRoot, json, argsJson, modelAliases, permissionMode, sessionModel, tokenBudget, resumeFromRunId, disableWorkflows, maxAgentCalls, maxConcurrentAgents, maxChildWorkflowDepth, maxEstimatedTokens, stopOnEstimatedTokenLimit };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} requires a non-negative integer`);
  return parsed;
}

function executionLimitsFor(args: ParsedArgs): AgentExecutionLimits | undefined {
  if (
    args.maxAgentCalls === undefined &&
    args.maxConcurrentAgents === undefined &&
    args.maxChildWorkflowDepth === undefined &&
    args.maxEstimatedTokens === undefined &&
    !args.stopOnEstimatedTokenLimit
  ) return undefined;
  return {
    ...(args.maxAgentCalls !== undefined ? { maxAgentCalls: args.maxAgentCalls } : {}),
    ...(args.maxConcurrentAgents !== undefined ? { maxConcurrentAgents: args.maxConcurrentAgents } : {}),
    ...(args.maxChildWorkflowDepth !== undefined ? { maxChildWorkflowDepth: args.maxChildWorkflowDepth } : {}),
    ...(args.maxEstimatedTokens !== undefined ? { maxEstimatedTokens: args.maxEstimatedTokens } : {}),
    ...(args.stopOnEstimatedTokenLimit ? { stopOnEstimatedTokenLimit: true } : {}),
  };
}

function inputForCliCommand(
  spec: NonNullable<ReturnType<typeof findWorkflowCommandSpec>>,
  args: ParsedArgs,
): Record<string, unknown> {
  const input = inputForCliArguments(spec, args.positional);
  const positionalArgsJson = spec.acceptsArgs ? args.positional[1] : undefined;
  const argsJson = args.argsJson ?? positionalArgsJson;
  if (args.resumeFromRunId && spec.name !== "workflow-run") {
    throw new Error("--resume-from-run-id only applies to workflow-run");
  }
  const resumeInput = args.resumeFromRunId ? { resumeFromRunId: args.resumeFromRunId } : {};

  if (!argsJson) return { ...input, ...resumeInput };
  if (!spec.acceptsArgs) throw new Error(`--args-json does not apply to ${spec.name}`);

  return {
    ...input,
    args: parseWorkflowArgsJson(argsJson),
    ...resumeInput,
  };
}

function permissionPolicyFor(permissionMode: string | undefined): PermissionPolicy | undefined {
  if (!permissionMode) return undefined;
  if (!isPermissionMode(permissionMode)) {
    throw new Error(`Unsupported permission mode: ${permissionMode}. Expected one of: ${PERMISSION_MODES.join(", ")}`);
  }
  return permissionPolicyForMode(permissionMode);
}

function parseWorkflowArgsJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("--args-json requires valid JSON");
  }
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
  const progress = formatProgress(run.progress);
  if (progress) lines.push(`  progress: ${progress}`);
  const artifacts = run.artifacts as { runJson?: string; transcriptDir?: string } | undefined;
  if (artifacts?.runJson) lines.push(`  run.json: ${artifacts.runJson}`);
  if (artifacts?.transcriptDir) lines.push(`  transcripts: ${artifacts.transcriptDir}`);
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

function formatProgress(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const done = value.agentDone;
  const total = value.agentTotal;
  if (typeof done !== "number" || typeof total !== "number") return undefined;
  const parts = [`${done}/${total} agents done`];
  if (typeof value.agentRunning === "number" && value.agentRunning > 0) parts.push(`${value.agentRunning} running`);
  if (typeof value.agentFailed === "number" && value.agentFailed > 0) parts.push(`${value.agentFailed} failed`);
  if (typeof value.tokenTotal === "number" && value.tokenTotal > 0) parts.push(`${value.tokenTotal} tokens`);
  return parts.join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
