import type { AgentFunction, AgentOptions } from "./domain";
import { schemaDefaultAgent } from "./schema-default-agent";

// The agent-workflow-kit CLI historically injected `schemaDefaultAgent` as `options.agent`, which returns
// schema-shaped STUBS and never runs a model (enum -> first value, string -> "", array -> []). That makes a
// committed orchestration workflow such as milestone-wave produce structurally-empty "nothing to do" output
// (workflow-defect #508). This module gives the CLI a REAL executor: it shells to `claude -p` / `codex exec`
// per `agentType`, captures stdout as the agent result, and (when the workflow passes a JSON Schema) instructs
// the model to emit JSON and parses it back. The runtime's bounded schema-retry loop validates the parsed
// value and re-prompts on mismatch, so this executor only has to produce a best-effort parse.
//
// Dry-run / stub behavior is preserved behind an explicit flag: with `dryRun: true` (or the CLI default, which
// does NOT wire this executor at all) the kit keeps returning `schemaDefaultAgent` stubs so control-flow tests
// and plan-only runs never burn tokens.

export type CliCommand = {
  // The executable to spawn, e.g. "claude" or "codex".
  cmd: string;
  // Argv (excluding the prompt, which is appended last unless promptViaStdin is set).
  args: string[];
  // When true, the prompt is written to stdin instead of appended as the final argv entry.
  promptViaStdin?: boolean;
};

export type CliCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type RunCommand = (command: CliCommand, prompt: string, timeoutMs: number) => CliCommandResult;

export type AgentTypeCommandBuilder = (model: string | undefined, agentType: string) => CliCommand;

export type CliAgentExecutorOptions = {
  // When true, return schemaDefaultAgent stubs instead of shelling to a model. Preserves the legacy CLI
  // behavior so control-flow tests + plan-only runs do not spawn real agents.
  dryRun?: boolean;
  // Bounded per-call timeout (ms). Default 600000 (10 min).
  timeoutMs?: number;
  // Override how an agentType maps to a CLI invocation. Defaults to claude/codex builders below.
  commandFor?: AgentTypeCommandBuilder;
  // Injection seam for tests; defaults to a node:child_process.spawnSync runner.
  runCommand?: RunCommand;
  // The agentType used when a workflow's agent() call omits one. Default "claude".
  defaultAgentType?: string;
};

const DEFAULT_TIMEOUT_MS = 600_000;

// claude -p "<prompt>" [--model <model>]: non-interactive print mode. Prompt passed via stdin to avoid argv
// length limits + shell quoting hazards on long orchestration prompts.
function claudeCommand(model: string | undefined): CliCommand {
  const args = ["-p"];
  if (model) args.push("--model", model);
  return { cmd: "claude", args, promptViaStdin: true };
}

// codex exec "<prompt>" [-m <model>]: non-interactive exec mode. Prompt via stdin for the same reasons.
function codexCommand(model: string | undefined): CliCommand {
  const args = ["exec"];
  if (model) args.push("-m", model);
  return { cmd: "codex", args, promptViaStdin: true };
}

export function defaultCommandFor(model: string | undefined, agentType: string): CliCommand {
  const type = (agentType || "claude").trim().toLowerCase();
  if (type === "codex") return codexCommand(model);
  // Default + explicit "claude": route to Claude. Unknown agentTypes fall through to Claude so a workflow
  // naming a host-specific subagent type still runs SOMETHING real rather than silently stubbing.
  return claudeCommand(model);
}

// Default subprocess runner. Resolved lazily so importing this module in a non-Node host (or a meta-only parse)
// does not require node:child_process up front.
function nodeRunCommand(command: CliCommand, prompt: string, timeoutMs: number): CliCommandResult {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const argv = command.promptViaStdin ? command.args : [...command.args, prompt];
  const result = spawnSync(command.cmd, argv, {
    input: command.promptViaStdin ? prompt : undefined,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`cli-agent-executor: command not found: ${command.cmd}. Is it installed + on PATH?`);
    }
    throw new Error(`cli-agent-executor: failed to run ${command.cmd}: ${err.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Append a JSON-only contract to the prompt when the workflow passed a schema, so the model returns parseable
// structured output. The runtime still validates the parsed value against the schema with bounded retry.
function withSchemaInstruction(prompt: string, schema: unknown): string {
  return [
    prompt,
    "",
    "Return ONLY a single JSON value that satisfies this JSON Schema. No prose, no markdown fences, no commentary:",
    JSON.stringify(schema),
  ].join("\n");
}

// Extract the first balanced JSON object/array from raw model stdout. Models often wrap JSON in prose or
// ```json fences; this tolerates both. Returns the raw string unchanged when no JSON span is found.
export function extractJson(raw: string): unknown {
  const text = String(raw ?? "");
  // First try the whole trimmed output (the happy path: the model returned bare JSON).
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;
  // Otherwise scan for the first balanced {...} or [...] span.
  const span = firstBalancedSpan(text);
  if (span) {
    const parsed = tryParse(span);
    if (parsed.ok) return parsed.value;
  }
  // No JSON found: return the raw text so the runtime's schema validation reports a real mismatch + retries,
  // rather than this executor masking the failure.
  return trimmed;
}

function tryParse(value: string): { ok: true; value: unknown } | { ok: false } {
  if (!value) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function firstBalancedSpan(text: string): string | undefined {
  for (let start = 0; start < text.length; start += 1) {
    const open = text[start];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString: string | undefined;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === inString) inString = undefined;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

export function createCliAgentExecutor(options: CliAgentExecutorOptions = {}): AgentFunction {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandFor = options.commandFor ?? defaultCommandFor;
  const runCommand = options.runCommand ?? nodeRunCommand;
  const defaultAgentType = options.defaultAgentType ?? "claude";

  if (options.dryRun) return schemaDefaultAgent;

  return async (prompt: string, agentOptions?: AgentOptions): Promise<unknown> => {
    const schema = agentOptions?.schema;
    const agentType = agentOptions?.agentType ?? defaultAgentType;
    const command = commandFor(agentOptions?.model, agentType);
    const fullPrompt = schema ? withSchemaInstruction(prompt, schema) : prompt;

    const result = runCommand(command, fullPrompt, timeoutMs);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim().slice(0, 2000);
      throw new Error(`cli-agent-executor: ${command.cmd} exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
    }

    return schema ? extractJson(result.stdout) : result.stdout.trim();
  };
}
