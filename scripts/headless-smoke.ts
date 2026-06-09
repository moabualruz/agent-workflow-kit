import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export type HeadlessSmokeHarness =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "grok"
  | "pi"
  | "antigravity";

export type HeadlessSmokeTarget = {
  harness: HeadlessSmokeHarness;
  command: string;
  args: string[];
  prompt: string;
  model?: string;
  modelEnv?: string;
  env?: Record<string, string>;
};

export type HeadlessSmokeResult = {
  harness: HeadlessSmokeHarness;
  status: "passed" | "failed" | "skipped" | "dry-run";
  command: string[];
  workflow?: ValidatedHeadlessWorkflow;
  error?: string;
};

type RunOptions = {
  run?: boolean;
  requireTools?: boolean;
  harnesses?: HeadlessSmokeHarness[];
  timeoutMs?: number;
};

type SmokeContext = {
  repoRoot: string;
  tempRoot: string;
  tempProject: string;
};

export type ValidatedHeadlessWorkflow = {
  runId: string;
  name: "no-write-probe";
  status: "completed";
  artifacts: {
    root: string;
    runJson: string;
    eventsJsonl: string;
  };
};

// Refreshed against the live OpenCode Zen catalog (https://opencode.ai/zen/v1/models) on
// 2026-06-09: deepseek-v4-pro was removed from Zen, and the logical tier vocabulary gained
// `fable` (the frontier tier above `opus`). Zen-only, subscription-allowed, and free models.
export const approvedModelAliasMaps = {
  opencode: {
    fable: "opencode-go/kimi-k2.6",
    opus: "opencode-go/glm-5.1",
    sonnet: "opencode-go/qwen3.6-plus",
    haiku: "opencode/deepseek-v4-flash-free",
  },
  pi: {
    fable: "opencode-go/kimi-k2.6",
    opus: "opencode-go/glm-5.1",
    sonnet: "opencode-go/qwen3.6-plus",
    haiku: "opencode/deepseek-v4-flash-free",
  },
} as const;

export const approvedPiFallbackModels = [
  "opencode-go/kimi-k2.6",
  "opencode-go/glm-5.1",
  "opencode-go/qwen3.6-plus",
  "opencode-go/deepseek-v4-flash",
  "opencode/grok-build-0.1",
  "xai-auth/grok-4.3",
  "xai-auth/grok-4.20-0309-reasoning",
  "xai-auth/grok-4.20-0309-non-reasoning",
] as const;

const prompt = [
  "Run this exact no-write workflow command in the requested project directory.",
  "Return the exact stdout JSON object from the command, unchanged.",
  "Do not summarize, rewrite, omit, or wrap fields.",
  'cd "{tempProject}" && agent-workflow-kit workflow-run no-write-probe --json',
].join("\n");

export const headlessSmokeTargets: HeadlessSmokeTarget[] = [
  {
    harness: "claude",
    command: "claude",
    args: ["-p", "{prompt}"],
    prompt,
  },
  {
    harness: "codex",
    command: "codex",
    args: ["exec", "--skip-git-repo-check", "{prompt}"],
    prompt,
  },
  {
    harness: "gemini",
    command: "gemini",
    args: ["--prompt", "{prompt}", "--skip-trust", "--yolo"],
    prompt,
  },
  {
    harness: "opencode",
    command: "opencode",
    args: ["run", "--dir", "{tempProject}", "--dangerously-skip-permissions", "--model", "{model}", "{prompt}"],
    prompt,
    model: approvedModelAliasMaps.opencode.sonnet,
    modelEnv: "AGENT_WORKFLOW_KIT_OPENCODE_SMOKE_MODEL",
    env: {
      AGENT_WORKFLOW_KIT_MODEL_ALIASES: modelAliasEnv(approvedModelAliasMaps.opencode),
    },
  },
  {
    harness: "grok",
    command: "grok",
    args: ["--model", "grok-build", "--cwd", "{tempProject}", "--always-approve", "-p", "{prompt}"],
    prompt,
    model: "grok-build",
  },
  {
    harness: "pi",
    command: "pi",
    args: [
      "--print",
      "--mode",
      "json",
      "--model",
      "{model}",
      "--no-context-files",
      "--no-builtin-tools",
      "--tools",
      "bash",
      "{prompt}",
    ],
    prompt,
    model: approvedModelAliasMaps.pi.sonnet,
    modelEnv: "AGENT_WORKFLOW_KIT_PI_SMOKE_MODEL",
    env: {
      AGENT_WORKFLOW_KIT_MODEL_ALIASES: modelAliasEnv(approvedModelAliasMaps.pi),
    },
  },
  {
    harness: "antigravity",
    command: "agy",
    args: ["--print", "{prompt}", "--print-timeout", "5m"],
    prompt,
  },
];

export async function runHeadlessSmoke(options: RunOptions = {}): Promise<HeadlessSmokeResult[]> {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const tempRoot = mkdtempSync(join(tmpdir(), "awk-headless-smoke-"));
  const tempProject = join(tempRoot, "project");
  const binRoot = join(tempRoot, "bin");
  mkdirSync(tempProject, { recursive: true });
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(
    join(binRoot, "agent-workflow-kit"),
    `#!/usr/bin/env sh\nexec bun "${join(repoRoot, "packages/cli/src/cli.ts")}" "$@"\n`,
    { mode: 0o755 },
  );
  const context = { repoRoot, tempRoot, tempProject };

  try {
    const results: HeadlessSmokeResult[] = [];
    for (const target of selectedTargets(options.harnesses)) {
      results.push(await runTarget(target, context, options, binRoot));
    }
    return results;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function selectedTargets(harnesses: HeadlessSmokeHarness[] | undefined): HeadlessSmokeTarget[] {
  if (!harnesses?.length) return headlessSmokeTargets;
  const requested = new Set(harnesses);
  return headlessSmokeTargets.filter((target) => requested.has(target.harness));
}

function modelAliasEnv(aliases: Record<string, string>): string {
  return Object.entries(aliases).map(([alias, model]) => `${alias}=${model}`).join(",");
}

async function runTarget(
  target: HeadlessSmokeTarget,
  context: SmokeContext,
  options: RunOptions,
  binRoot: string,
): Promise<HeadlessSmokeResult> {
  const command = materializedCommand(target, context);
  if (!(await executableExists(target.command))) {
    const error = `${target.command} not found on PATH`;
    if (options.requireTools) return { harness: target.harness, status: "failed", command, error };
    return { harness: target.harness, status: "skipped", command, error };
  }
  if (!options.run) return { harness: target.harness, status: "dry-run", command };

  const proc = Bun.spawn(command, {
    cwd: context.tempProject,
    env: {
      ...process.env,
      PATH: `${binRoot}:${process.env.PATH ?? ""}`,
      ...materializedEnv(target.env ?? {}, context),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), options.timeoutMs ?? 300_000);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = `${stdout}${stderr}`;
    if (exitCode !== 0) {
      return { harness: target.harness, status: "failed", command, error: `${target.command} exited ${exitCode}\n${output}` };
    }
    try {
      const workflow = validateHeadlessSmokeOutput(output);
      assertHeadlessWorkflowArtifactsExist(workflow);
      return { harness: target.harness, status: "passed", command, workflow };
    } catch (error) {
      return {
        harness: target.harness,
        status: "failed",
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function validateHeadlessSmokeOutput(output: string): ValidatedHeadlessWorkflow {
  for (const value of extractJsonValues(output)) {
    const workflow = findWorkflowPayload(value);
    if (workflow) return workflow;
  }

  throw new Error(
    `expected completed no-write-probe workflow JSON with artifact paths\nOutput excerpt:\n${outputExcerpt(output)}`,
  );
}

export function assertHeadlessWorkflowArtifactsExist(workflow: ValidatedHeadlessWorkflow): void {
  for (const path of [workflow.artifacts.root, workflow.artifacts.runJson, workflow.artifacts.eventsJsonl]) {
    if (!existsSync(path)) throw new Error(`missing workflow artifact: ${path}`);
  }
}

function outputExcerpt(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "<empty>";
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 2_000)}...<truncated>` : trimmed;
}

function findWorkflowPayload(value: unknown): ValidatedHeadlessWorkflow | undefined {
  if (isValidatedHeadlessWorkflow(value)) return value;

  if (typeof value === "string") {
    for (const nestedValue of extractJsonValues(value)) {
      const workflow = findWorkflowPayload(nestedValue);
      if (workflow) return workflow;
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const workflow = findWorkflowPayload(entry);
      if (workflow) return workflow;
    }
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const workflow = findWorkflowPayload(entry);
      if (workflow) return workflow;
    }
  }

  return undefined;
}

function isValidatedHeadlessWorkflow(value: unknown): value is ValidatedHeadlessWorkflow {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const artifacts = record.artifacts as Record<string, unknown> | undefined;

  return (
    typeof record.runId === "string" &&
    record.name === "no-write-probe" &&
    record.status === "completed" &&
    !!artifacts &&
    typeof artifacts.root === "string" &&
    typeof artifacts.runJson === "string" &&
    typeof artifacts.eventsJsonl === "string"
  );
}

function extractJsonValues(output: string): unknown[] {
  const values: unknown[] = [];
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (char !== "{" && char !== "[") continue;

    const end = findJsonEnd(output, index);
    if (end === -1) continue;

    try {
      values.push(JSON.parse(output.slice(index, end + 1)));
      index = end;
    } catch {
      continue;
    }
  }
  return values;
}

function findJsonEnd(output: string, start: number): number {
  const open = output[start];
  const close = open === "{" ? "}" : "]";
  const stack = [close];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < output.length; index += 1) {
    const char = output[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = inString;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      if (char !== stack.pop()) return -1;
      if (stack.length === 0) return index;
    }
  }

  return -1;
}

function materializedEnv(env: Record<string, string>, context: SmokeContext): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, materialize(value, context)]));
}

function materializedCommand(target: HeadlessSmokeTarget, context: SmokeContext): string[] {
  const model = target.modelEnv ? (process.env[target.modelEnv] ?? target.model) : target.model;
  const prompt = materialize(target.prompt, context);
  return [
    target.command,
    ...target.args.map((arg) => materialize(arg, context)
      .replaceAll("{prompt}", prompt)
      .replaceAll("{model}", model ?? "")),
  ];
}

function materialize(value: string, context: SmokeContext): string {
  return value
    .replaceAll("{repoRoot}", context.repoRoot)
    .replaceAll("{tempRoot}", context.tempRoot)
    .replaceAll("{tempProject}", context.tempProject);
}

async function executableExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["/bin/sh", "-c", `command -v ${command}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

if (import.meta.main) {
  const run = process.argv.includes("--run");
  const requireTools = process.argv.includes("--require-tools");
  const harnesses = parseHarnesses(process.argv.slice(2));
  const options: RunOptions = { run, requireTools };
  if (harnesses) options.harnesses = harnesses;
  const results = await runHeadlessSmoke(options);
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

function parseHarnesses(argv: string[]): HeadlessSmokeHarness[] | undefined {
  const harnesses: HeadlessSmokeHarness[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--harness") continue;
    const value = argv[index + 1];
    if (!value) throw new Error("--harness requires a value");
    harnesses.push(...value.split(",").map(parseHarness));
    index += 1;
  }
  return harnesses.length ? harnesses : undefined;
}

function parseHarness(value: string): HeadlessSmokeHarness {
  const harness = value.trim();
  if (headlessSmokeTargets.some((target) => target.harness === harness)) {
    return harness as HeadlessSmokeHarness;
  }
  throw new Error(`Unsupported harness: ${value}`);
}
