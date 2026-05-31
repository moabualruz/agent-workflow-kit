import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export type InstallSmokeTarget = {
  harness: "codex" | "gemini" | "opencode" | "grok" | "pi" | "antigravity";
  pluginName: string;
  env: Record<string, string>;
  commands: InstallSmokeCommand[];
  expectedOutput: string;
  preseedTrustedPluginPath?: string;
};

export type InstallSmokeCommand = {
  command: string;
  args: string[];
  cwd: "repo" | "tempProject";
};

export type InstallSmokeResult = {
  harness: InstallSmokeTarget["harness"];
  status: "passed" | "failed" | "skipped";
  output?: string;
  error?: string;
};

type RunOptions = {
  requireTools?: boolean;
  timeoutMs?: number;
};

type SmokeContext = {
  repoRoot: string;
  tempRoot: string;
  tempProject: string;
};

export const installSmokeTargets: InstallSmokeTarget[] = [
  {
    harness: "codex",
    pluginName: "codex-workflow-kit",
    env: { CODEX_HOME: "{tempRoot}/codex", HOME: "{tempRoot}/home" },
    commands: [
      { command: "codex", args: ["plugin", "marketplace", "add", "."], cwd: "repo" },
      { command: "codex", args: ["plugin", "add", "codex-workflow-kit@agent-workflow-kit"], cwd: "repo" },
      { command: "codex", args: ["plugin", "list"], cwd: "repo" },
    ],
    expectedOutput: "codex-workflow-kit@agent-workflow-kit",
  },
  {
    harness: "gemini",
    pluginName: "gemini-workflow-kit",
    env: { GEMINI_CLI_HOME: "{tempRoot}/gemini", HOME: "{tempRoot}/home" },
    preseedTrustedPluginPath: "plugins/gemini-workflow-kit",
    commands: [
      { command: "gemini", args: ["extensions", "install", "plugins/gemini-workflow-kit", "--consent", "--skip-settings"], cwd: "repo" },
      { command: "gemini", args: ["extensions", "list"], cwd: "repo" },
    ],
    expectedOutput: "gemini-workflow-kit",
  },
  {
    harness: "opencode",
    pluginName: "opencode-workflow-kit",
    env: { HOME: "{tempRoot}/home", XDG_CONFIG_HOME: "{tempRoot}/xdg" },
    commands: [
      { command: "opencode", args: ["plugin", "./plugins/opencode-workflow-kit", "--global", "--force"], cwd: "repo" },
    ],
    expectedOutput: "opencode-workflow-kit",
  },
  {
    harness: "grok",
    pluginName: "grok-workflow-kit",
    env: { HOME: "{tempRoot}/home", XDG_CONFIG_HOME: "{tempRoot}/xdg" },
    commands: [
      { command: "grok", args: ["plugin", "install", "{repoRoot}/plugins/grok-workflow-kit", "--trust"], cwd: "repo" },
      { command: "grok", args: ["plugin", "details", "grok-workflow-kit"], cwd: "repo" },
    ],
    expectedOutput: "grok-workflow-kit",
  },
  {
    harness: "pi",
    pluginName: "pi-workflow-kit",
    env: { HOME: "{tempRoot}/home", XDG_CONFIG_HOME: "{tempRoot}/xdg" },
    commands: [
      { command: "pi", args: ["install", "{repoRoot}/plugins/pi-workflow-kit", "--local"], cwd: "tempProject" },
    ],
    expectedOutput: "pi-workflow-kit",
  },
  {
    harness: "antigravity",
    pluginName: "antigravity-workflow-kit",
    env: { HOME: "{tempRoot}/home", XDG_CONFIG_HOME: "{tempRoot}/xdg" },
    commands: [
      { command: "agy", args: ["plugin", "install", "plugins/antigravity-workflow-kit"], cwd: "repo" },
      { command: "agy", args: ["plugin", "list"], cwd: "repo" },
    ],
    expectedOutput: "antigravity-workflow-kit",
  },
];

export async function runInstallSmoke(options: RunOptions = {}): Promise<InstallSmokeResult[]> {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const tempRoot = mkdtempSync(join(tmpdir(), "awk-install-smoke-"));
  const context = { repoRoot, tempRoot, tempProject: join(tempRoot, "project") };
  mkdirSync(context.tempProject, { recursive: true });

  try {
    const results: InstallSmokeResult[] = [];

    for (const target of installSmokeTargets) {
      results.push(await runTarget(target, context, options));
    }

    return results;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function runTarget(
  target: InstallSmokeTarget,
  context: SmokeContext,
  options: RunOptions,
): Promise<InstallSmokeResult> {
  if (!(await executableExists(target.commands[0]?.command))) {
    const message = `${target.commands[0]?.command} not found on PATH`;
    if (options.requireTools) return { harness: target.harness, status: "failed", error: message };
    return { harness: target.harness, status: "skipped", error: message };
  }

  const env = materializeEnv(target.env, context);
  for (const value of Object.values(env)) mkdirSync(value, { recursive: true });
  if (target.preseedTrustedPluginPath) preseedGeminiTrust(target.preseedTrustedPluginPath, env, context);

  let output = "";

  try {
    for (const command of target.commands) {
      const result = await runCommand(command, env, context, options.timeoutMs ?? 30_000);
      output += result;
    }

    if (!output.includes(target.expectedOutput)) {
      return {
        harness: target.harness,
        status: "failed",
        output,
        error: `expected output to contain ${target.expectedOutput}`,
      };
    }

    return { harness: target.harness, status: "passed", output };
  } catch (error) {
    return {
      harness: target.harness,
      status: "failed",
      output,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runCommand(
  command: InstallSmokeCommand,
  env: Record<string, string>,
  context: SmokeContext,
  timeoutMs: number,
): Promise<string> {
  const proc = Bun.spawn([command.command, ...command.args.map((arg) => materialize(arg, context))], {
    cwd: command.cwd === "repo" ? context.repoRoot : context.tempProject,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = `${stdout}${stderr}`;
    if (exitCode !== 0) throw new Error(`${command.command} exited ${exitCode}\n${output}`);
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

async function executableExists(command: string | undefined): Promise<boolean> {
  if (!command) return false;
  const proc = Bun.spawn(["/bin/sh", "-c", `command -v ${command}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

function materializeEnv(env: Record<string, string>, context: SmokeContext): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, materialize(value, context)]));
}

function materialize(value: string, context: SmokeContext): string {
  return value
    .replaceAll("{repoRoot}", context.repoRoot)
    .replaceAll("{tempRoot}", context.tempRoot);
}

function preseedGeminiTrust(pluginPath: string, env: Record<string, string>, context: SmokeContext): void {
  const geminiHome = env.GEMINI_CLI_HOME;
  if (!geminiHome) throw new Error("GEMINI_CLI_HOME is required to preseed Gemini trust");
  const sourcePath = realpathSync(join(context.repoRoot, pluginPath));
  const trustPath = join(geminiHome, ".gemini", "trustedFolders.json");
  mkdirSync(dirname(trustPath), { recursive: true });
  writeFileSync(trustPath, JSON.stringify({ [sourcePath]: "TRUST_FOLDER" }, null, 2));
}

if (import.meta.main) {
  const requireTools = process.argv.includes("--require-tools");
  const results = await runInstallSmoke({ requireTools });
  console.log(JSON.stringify(results.map(({ harness, status, error }) => ({ harness, status, error })), null, 2));
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}
