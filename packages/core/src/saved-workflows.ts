import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import type { WorkflowArgs, WorkflowInvocation, WorkflowScript } from "./domain";
import type { ResolvedWorkflowInvocation } from "./runtime";
import { parseWorkflowMeta, phaseModelMap } from "./workflow-meta";

export type WorkflowScope = "project" | "personal";

export type SavedWorkflow = {
  scope?: WorkflowScope;
  name: string;
  script: WorkflowScript;
};

export type ResolvedWorkflowScript = {
  name: string;
  script: WorkflowScript;
  phaseModels?: Record<string, string>;
  runModel?: string;
  // Absolute path the script was loaded from (absent for built-ins). Recorded on
  // the run so resume can re-resolve by path, not just by name.
  path?: string;
};

export type WorkflowLookupOptions = {
  homeRoot?: string | undefined;
};

export function createMemoryWorkflowRegistry() {
  const entries = new Map<string, Required<SavedWorkflow>>();

  return {
    save(workflow: SavedWorkflow): void {
      const scope = workflow.scope ?? "project";
      entries.set(`${scope}:${workflow.name}`, { ...workflow, scope });
    },

    resolve(request: { name: string }): Required<SavedWorkflow> {
      const project = entries.get(`project:${request.name}`);
      if (project) return project;

      const personal = entries.get(`personal:${request.name}`);
      if (personal) return personal;

      throw new Error(`Saved workflow not found: ${request.name}`);
    },
  };
}

export async function resolveWorkflowScript(
  projectRoot: string,
  workflowName: string,
  options: WorkflowLookupOptions = {},
): Promise<WorkflowScript> {
  return (await resolveWorkflow(projectRoot, workflowName, options)).script;
}

export async function resolveWorkflow(
  projectRoot: string,
  workflowRef: string,
  options: WorkflowLookupOptions = {},
): Promise<ResolvedWorkflowScript> {
  const directPath = directWorkflowPath(projectRoot, workflowRef);
  if (directPath) {
    return {
      name: workflowNameFromPath(directPath),
      ...(await loadWorkflowScript(directPath)),
      path: directPath,
    };
  }

  assertWorkflowName(workflowRef);
  const workflowPath = findWorkflowFile(projectRoot, workflowRef, options);
  if (workflowPath) {
    return {
      name: workflowRef,
      ...(await loadWorkflowScript(workflowPath)),
      path: workflowPath,
    };
  }

  const builtIn = builtInWorkflows.get(workflowRef);
  if (builtIn) return { name: workflowRef, script: builtIn };

  throw new Error(`Unknown workflow: ${workflowRef}`);
}

export async function resolveWorkflowInvocation(
  projectRoot: string,
  request: WorkflowInvocation,
  args?: WorkflowArgs,
  options: WorkflowLookupOptions = {},
): Promise<ResolvedWorkflowInvocation> {
  if (request.script) {
    return {
      name: request.name ?? "workflow",
      script: request.script,
      args: args ?? request.args,
    };
  }

  if (request.scriptPath) {
    const directPath = directWorkflowPath(projectRoot, request.scriptPath);
    if (!directPath) throw new Error(`Unknown workflow scriptPath: ${request.scriptPath}`);
    return {
      name: workflowNameFromPath(directPath),
      ...(await loadWorkflowScript(directPath)),
      args: args ?? request.args,
    };
  }

  if (request.name) {
    const workflow = await resolveWorkflow(projectRoot, request.name, options);
    return {
      ...workflow,
      args: args ?? request.args,
    };
  }

  throw new Error("Child workflow invocation requires name, script, or scriptPath");
}

const builtInWorkflows = new Map<string, WorkflowScript>([
  [
    "no-write-probe",
    async ({ phase, agent, log }) => {
      phase("Probe");
      log("no-write probe entered");
      return agent("Return exact JSON {\"ok\":true}");
    },
  ],
]);

function findWorkflowFile(projectRoot: string, workflowName: string, options: WorkflowLookupOptions): string | undefined {
  const homeRoot = options.homeRoot ?? homedir();
  const candidates = [
    join(projectRoot, ".agent-workflow-kit", "workflows", `${workflowName}.js`),
    join(projectRoot, ".claude", "workflows", `${workflowName}.js`),
    join(projectRoot, "scripts", "workflows", `${workflowName}.workflow.js`),
    join(homeRoot, ".claude", "workflows", `${workflowName}.js`),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function directWorkflowPath(projectRoot: string, workflowRef: string): string | undefined {
  if (!looksLikeScriptPath(workflowRef)) return undefined;
  const candidate = isAbsolute(workflowRef) ? workflowRef : resolve(projectRoot, workflowRef);
  return existsSync(candidate) ? candidate : undefined;
}

function looksLikeScriptPath(workflowRef: string): boolean {
  return workflowRef.endsWith(".js") && (workflowRef.includes("/") || workflowRef.startsWith("."));
}

function workflowNameFromPath(workflowPath: string): string {
  return basename(workflowPath).replace(/\.js$/, "");
}

type LoadedWorkflow = {
  script: WorkflowScript;
  phaseModels?: Record<string, string>;
  runModel?: string;
};

async function loadWorkflowScript(workflowPath: string): Promise<LoadedWorkflow> {
  const source = readFileSync(workflowPath, "utf8");
  if (isClaudeStyleWorkflowSource(source)) {
    const parsed = parseWorkflowMeta(source);
    if (!parsed.ok) throw new Error(`Invalid workflow meta in ${workflowPath}: ${parsed.error}`);
    const models = phaseModelMap(parsed.meta);
    return {
      script: compileClaudeStyleWorkflowScript(source, workflowPath),
      ...(models.size ? { phaseModels: Object.fromEntries(models) } : {}),
      ...(parsed.meta.model ? { runModel: parsed.meta.model } : {}),
    };
  }

  const module = await import(pathToFileURL(workflowPath).href);
  const script = module.default ?? module.workflow;
  if (typeof script !== "function") throw new Error(`Saved workflow must export a function: ${workflowPath}`);
  return { script: script as WorkflowScript };
}

function isClaudeStyleWorkflowSource(source: string): boolean {
  return /\bexport\s+const\s+meta\s*=/.test(source) && !/\bexport\s+default\b/.test(source) && !/\bexport\s+(?:async\s+)?function\s+workflow\b/.test(source);
}

function compileClaudeStyleWorkflowScript(source: string, workflowPath: string): WorkflowScript {
  const body = addReturnForFinalExpression(source.replace(/\bexport\s+const\s+meta\s*=/, "const meta ="));
  const sourceUrl = workflowPath.replaceAll("\\", "/");
  // A vm Script runs as a program, not a function body, so top-level `return`
  // is illegal. Evaluate to an async IIFE whose resolved value is the run result;
  // runInContext returns that promise.
  const code = `"use strict";
(async (context) => {
const { args, agent, phase, parallel, pipeline, workflow, log, budget } = context;
${body}
})(__workflowContext);
//# sourceURL=${sourceUrl}`;

  // Run Claude-style bodies in a vm context whose default globals are the
  // injected set below. This is a DETERMINISM aid, NOT a security boundary:
  // resume replays calls keyed on exact prompt strings, so a prompt built from
  // Date.now()/Math.random()/new Date() would silently break replay, and those
  // naive spellings are shadowed to throw. `require`/`process`/`module`/
  // `globalThis` are not injected, so honest bodies cannot casually reach the
  // filesystem. node:vm is not a sandbox against hostile code (host-realm
  // intrinsics like Promise.constructor.constructor can reach back to the host),
  // and the determinism guards can be bypassed the same way — Claude-style
  // bodies are therefore trusted at the same level as the repo's plain `.js`
  // workflows, which run via unrestricted `import()`. Treat the source as
  // trusted; this layer only prevents accidental non-determinism.
  const sandbox = createWorkflowSandbox();
  const script = new Script(code, { filename: sourceUrl });

  return (context) => {
    const vmContext = createContext({ ...sandbox, __workflowContext: context });
    return script.runInContext(vmContext) as Promise<unknown>;
  };
}

const NONDETERMINISTIC_MESSAGE =
  "Non-deterministic API is not allowed in a workflow body (it would corrupt resume replay); pass timestamps via args and vary randomness by index.";

function createWorkflowSandbox(): Record<string, unknown> {
  // Preserve Date's static helpers that ARE deterministic (parse/UTC) but block
  // the wall-clock ones: `new Date()` (no args) and Date.now().
  const SafeDate = new Proxy(Date, {
    construct(target, argumentsList, newTarget) {
      if (argumentsList.length === 0) throw new Error(NONDETERMINISTIC_MESSAGE);
      return Reflect.construct(target, argumentsList, newTarget);
    },
    get(target, prop, receiver) {
      if (prop === "now") {
        return () => {
          throw new Error(NONDETERMINISTIC_MESSAGE);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const SafeMath = new Proxy(Math, {
    get(target, prop, receiver) {
      if (prop === "random") {
        return () => {
          throw new Error(NONDETERMINISTIC_MESSAGE);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return {
    Date: SafeDate,
    Math: SafeMath,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Map,
    Set,
    Symbol,
    RegExp,
    Error,
    TypeError,
    RangeError,
    console,
    structuredClone: globalThis.structuredClone,
  };
}

function addReturnForFinalExpression(source: string): string {
  const lines = source.split("\n");
  const finalExpressionIndex = findFinalExpressionLine(lines);
  if (finalExpressionIndex === undefined) return source;

  const line = lines[finalExpressionIndex];
  if (line === undefined) return source;
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const expression = line.trim().replace(/;$/, "");
  lines[finalExpressionIndex] = `${indent}return ${expression};`;
  return lines.join("\n");
}

function findFinalExpressionLine(lines: string[]): number | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (!isReturnableExpressionLine(trimmed)) return undefined;
    return index;
  }

  return undefined;
}

function isReturnableExpressionLine(trimmed: string): boolean {
  return !/^(?:return\b|const\b|let\b|var\b|function\b|class\b|if\b|for\b|while\b|switch\b|try\b|catch\b|finally\b|throw\b|import\b|export\b|await\s+using\b|using\b|[\]}])/.test(trimmed);
}

function assertWorkflowName(workflowName: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(workflowName)) throw new Error(`Invalid workflow name: ${workflowName}`);
}
