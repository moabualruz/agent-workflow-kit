import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkflowArgs, WorkflowInvocation, WorkflowScript } from "./domain";
import type { ResolvedWorkflowInvocation } from "./runtime";

export type WorkflowScope = "project" | "personal";

export type SavedWorkflow = {
  scope?: WorkflowScope;
  name: string;
  script: WorkflowScript;
};

export type ResolvedWorkflowScript = {
  name: string;
  script: WorkflowScript;
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
      script: await loadWorkflowScript(directPath),
    };
  }

  assertWorkflowName(workflowRef);
  const workflowPath = findWorkflowFile(projectRoot, workflowRef, options);
  if (workflowPath) {
    return {
      name: workflowRef,
      script: await loadWorkflowScript(workflowPath),
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
      script: await loadWorkflowScript(directPath),
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

async function loadWorkflowScript(workflowPath: string): Promise<WorkflowScript> {
  const source = readFileSync(workflowPath, "utf8");
  if (isClaudeStyleWorkflowSource(source)) return compileClaudeStyleWorkflowScript(source, workflowPath);

  const module = await import(pathToFileURL(workflowPath).href);
  const script = module.default ?? module.workflow;
  if (typeof script !== "function") throw new Error(`Saved workflow must export a function: ${workflowPath}`);
  return script as WorkflowScript;
}

function isClaudeStyleWorkflowSource(source: string): boolean {
  return /\bexport\s+const\s+meta\s*=/.test(source) && !/\bexport\s+default\b/.test(source) && !/\bexport\s+(?:async\s+)?function\s+workflow\b/.test(source);
}

function compileClaudeStyleWorkflowScript(source: string, workflowPath: string): WorkflowScript {
  const body = addReturnForFinalExpression(source.replace(/\bexport\s+const\s+meta\s*=/, "const meta ="));
  const sourceUrl = workflowPath.replaceAll("\\", "/");
  // eslint-disable-next-line no-new-func
  const run = Function(
    "context",
    `"use strict";
const { args, agent, phase, parallel, pipeline, workflow, log } = context;
return (async () => {
${body}
})();
//# sourceURL=${sourceUrl}`,
  ) as (context: unknown) => Promise<unknown>;

  return (context) => run(context);
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
