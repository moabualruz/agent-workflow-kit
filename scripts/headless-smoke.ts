import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  error?: string;
};

type RunOptions = {
  run?: boolean;
  requireTools?: boolean;
  timeoutMs?: number;
};

type SmokeContext = {
  repoRoot: string;
  tempRoot: string;
  tempProject: string;
};

export const approvedModelAliasMaps = {
  opencode: {
    opus: "opencode-go/deepseek-v4-pro",
    sonnet: "opencode-go/qwen3.6-plus",
    haiku: "opencode/deepseek-v4-flash-free",
  },
  pi: {
    opus: "openai-codex/gpt-5.5",
    sonnet: "openai-codex/gpt-5.3-codex",
    haiku: "opencode/deepseek-v4-flash-free",
  },
} as const;

export const approvedPiFallbackModels = [
  "opencode-go/deepseek-v4-pro",
  "opencode-go/qwen3.6-plus",
  "opencode-go/deepseek-v4-flash",
  "opencode/grok-build-0.1",
] as const;

const prompt = [
  "Run this exact no-write workflow command in the current project and return only the JSON status summary:",
  "agent-workflow-kit workflow-run no-write-probe --json",
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
    args: ["--prompt", "{prompt}", "--skip-trust"],
    prompt,
  },
  {
    harness: "opencode",
    command: "opencode",
    args: ["run", "--model", "{model}", "{prompt}"],
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
    args: ["--model", "grok-build-0.1", "--prompt", "{prompt}"],
    prompt,
    model: "grok-build-0.1",
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
    for (const target of headlessSmokeTargets) {
      results.push(await runTarget(target, context, options, binRoot));
    }
    return results;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
      ...(target.env ?? {}),
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
    if (!output.includes("no-write-probe")) {
      return { harness: target.harness, status: "failed", command, error: "output did not mention no-write-probe" };
    }
    return { harness: target.harness, status: "passed", command };
  } finally {
    clearTimeout(timeout);
  }
}

function materializedCommand(target: HeadlessSmokeTarget, context: SmokeContext): string[] {
  const model = target.modelEnv ? (process.env[target.modelEnv] ?? target.model) : target.model;
  return [
    target.command,
    ...target.args.map((arg) => arg
      .replaceAll("{prompt}", target.prompt)
      .replaceAll("{model}", model ?? "")
      .replaceAll("{repoRoot}", context.repoRoot)
      .replaceAll("{tempRoot}", context.tempRoot)),
  ];
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
  const results = await runHeadlessSmoke({ run, requireTools });
  console.log(JSON.stringify(results, null, 2));
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}
