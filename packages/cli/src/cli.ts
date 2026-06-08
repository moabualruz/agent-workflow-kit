#!/usr/bin/env bun

import {
  createAliasModelPolicy,
  createCliAgentExecutor,
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
  type WorkflowCatalogEntry,
  type WorkflowCommandService,
  type WorkflowRun,
  workflowCommandNames,
} from "@agent-workflow-kit/core";
import { formatHuman, formatRunTree } from "./workflows-view";

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
  tree: boolean;
  watch: boolean;
  realAgents: boolean;
  agentTimeoutMs?: number | undefined;
};

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(argv: string[]) {
  const args = parseArgs(argv);
  const service = createWorkflowCommandService({
    projectRoot: args.projectRoot,
    // Default (no --real-agents): omit `agent`, so the command service falls back to schemaDefaultAgent (the
    // legacy stub behavior), preserved for control-flow/plan-only runs that must not spawn real agents.
    // With --real-agents: shell to `claude -p` / `codex exec` per agentType (workflow-defect #508 fix).
    ...(args.realAgents
      ? { agent: createCliAgentExecutor({ ...(args.agentTimeoutMs !== undefined ? { timeoutMs: args.agentTimeoutMs } : {}) }) }
      : {}),
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
  if (!args.json && args.watch) {
    await watchCommand(service, spec, input, args);
    return;
  }

  const result = await dispatchWorkflowCommand(service, spec.name, input);
  if (!args.json && args.tree && spec.name === "workflow-status" && isRunRecord(result)) {
    const runId = typeof input.runId === "string" ? input.runId : result.runId;
    printTree(result as WorkflowRun, service.eventsFor(runId));
    return;
  }

  print(result, { json: args.json });
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
  let tree = false;
  let watch = false;
  let realAgents = false;
  let agentTimeoutMs: number | undefined;

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

    if (arg === "--tree") {
      tree = true;
      continue;
    }

    if (arg === "--watch") {
      watch = true;
      continue;
    }

    if (arg === "--disable-workflows") {
      disableWorkflows = true;
      continue;
    }

    if (arg === "--real-agents") {
      realAgents = true;
      continue;
    }

    if (arg === "--agent-timeout-ms") {
      const value = argv[index + 1];
      if (!value) throw new Error("--agent-timeout-ms requires a value");
      agentTimeoutMs = parsePositiveInteger(value, "--agent-timeout-ms");
      index += 1;
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

  // Fail fast: a timeout without --real-agents is a no-op (the stub path never spawns a child), so silently
  // ignoring it would let a user believe a timeout is active when it is not. Checked after the loop so it holds
  // regardless of the order the two flags appear in argv.
  if (agentTimeoutMs !== undefined && !realAgents) {
    throw new Error("--agent-timeout-ms requires --real-agents");
  }

  return { command, positional, projectRoot, json, argsJson, modelAliases, permissionMode, sessionModel, tokenBudget, resumeFromRunId, disableWorkflows, maxAgentCalls, maxConcurrentAgents, maxChildWorkflowDepth, maxEstimatedTokens, stopOnEstimatedTokenLimit, tree, watch, realAgents, agentTimeoutMs };
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

function print(value: unknown, options: { json: boolean }): void {
  if (options.json) {
    console.log(JSON.stringify(value));
    return;
  }

  console.log(formatHuman(value));
}

function printTree(run: WorkflowRun, events: Parameters<typeof formatRunTree>[1]): void {
  console.log(formatRunTree(run, events));
}

async function watchCommand(
  service: WorkflowCommandService,
  spec: WorkflowCatalogEntry,
  input: Record<string, unknown>,
  args: ParsedArgs,
): Promise<void> {
  if (!isWatchableCommand(spec.name)) {
    throw new Error("--watch only applies to read-only commands: workflows, workflow-status, workflow-events");
  }

  const intervalMs = watchIntervalMs();
  const iterations = watchIterations();
  for (let iteration = 1; iterations === undefined || iteration <= iterations; iteration += 1) {
    const body = await renderReadOnlyCommand(service, spec, input, args);
    writeWatchFrame(`watch: ${spec.name} refreshing every ${intervalMs}ms`, body, iteration);
    if (iterations !== undefined && iteration >= iterations) break;
    await sleep(intervalMs);
  }
}

async function renderReadOnlyCommand(
  service: WorkflowCommandService,
  spec: WorkflowCatalogEntry,
  input: Record<string, unknown>,
  args: ParsedArgs,
): Promise<string> {
  const result = await dispatchWorkflowCommand(service, spec.name, input);
  if (args.tree && spec.name === "workflow-status" && isRunRecord(result)) {
    const runId = typeof input.runId === "string" ? input.runId : result.runId;
    return formatRunTree(result, service.eventsFor(runId));
  }
  return formatHuman(result);
}

function writeWatchFrame(header: string, body: string, iteration: number): void {
  const interactive = Boolean(process.stdout.isTTY);
  const clear = interactive ? "\x1b[2J\x1b[H" : "";
  const separator = !interactive && iteration > 1 ? "\n" : "";
  process.stdout.write(`${separator}${clear}${header}\n${body}\n`);
}

function isWatchableCommand(command: string): boolean {
  return command === "workflows" || command === "workflow-status" || command === "workflow-events";
}

function watchIntervalMs(): number {
  return positiveEnvInteger("AGENT_WORKFLOW_KIT_WATCH_INTERVAL_MS") ?? 1_000;
}

function watchIterations(): number | undefined {
  return positiveEnvInteger("AGENT_WORKFLOW_KIT_WATCH_ITERATIONS");
}

function positiveEnvInteger(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} requires a positive integer`);
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRunRecord(value: unknown): value is WorkflowRun {
  return isRecord(value) && typeof value.runId === "string" && typeof value.name === "string" && typeof value.status === "string";
}
