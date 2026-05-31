import type { RunRequest, WorkflowArgs, WorkflowContext, WorkflowEvent, WorkflowInvocation, WorkflowScript, WorkflowStore } from "./domain";
import { stringifyError } from "./errors";
import type { ModelPolicy, ModelResolution } from "./model-policy";
import type { PermissionPolicy } from "./permissions";

export type WorkflowRuntimeOptions = {
  store: WorkflowStore;
  agent: (prompt: string, options?: { model?: string; schema?: unknown }) => Promise<unknown>;
  modelPolicy?: ModelPolicy | undefined;
  permissionPolicy?: PermissionPolicy | undefined;
  resolveWorkflow?: (request: WorkflowInvocation, args?: WorkflowArgs) => Promise<ResolvedWorkflowInvocation>;
};

export type ResolvedWorkflowInvocation = {
  name: string;
  script: WorkflowScript;
  args?: WorkflowArgs | undefined;
};

export function createWorkflowRuntime(options: WorkflowRuntimeOptions) {
  return {
    async run(request: RunRequest) {
      const run = options.store.createRun(request.name);
      const decision = await (options.permissionPolicy?.authorizeDynamicWorkflow({ name: request.name }) ?? { allowed: true });

      if (!decision.allowed) {
        options.store.append({
          runId: run.runId,
          type: "permission:denied",
          message: decision.reason,
        });
        return options.store.fail(run.runId, new Error(decision.reason));
      }

      const counters = { phase: 0, agent: 0 };
      const context = createContext(run.runId, options, counters, request.args ?? {});

      try {
        const result = await request.script(context);
        return options.store.complete(run.runId, result);
      } catch (error) {
        return options.store.fail(run.runId, error);
      }
    },
  };
}

function createContext(
  runId: string,
  options: WorkflowRuntimeOptions,
  counters: { phase: number; agent: number },
  args: WorkflowArgs,
): WorkflowContext {
  const runAgent = async (prompt: string, agentOptions?: { model?: string; schema?: unknown }) => {
    const index = ++counters.agent;
    const model = resolveModel(options.modelPolicy, agentOptions?.model);
    options.store.append(withModel({ runId, type: "agent:start", index, prompt }, model));

    try {
      const result = await options.agent(prompt, withResolvedModel(agentOptions, model));
      options.store.append(withModel({ runId, type: "agent:done", index, prompt, result }, model));
      return result;
    } catch (error) {
      options.store.append(withModel({ runId, type: "agent:done", index, prompt, error: stringifyError(error) }, model));
      throw error;
    }
  };

  return {
    args,
    agent: runAgent,

    phase(title: string): void {
      options.store.append({ runId, type: "phase", index: ++counters.phase, title });
    },

    parallel(tasks) {
      return Promise.all(tasks.map((task) => task()));
    },

    async pipeline(items, ...stages) {
      const results = [];

      for (const [index, item] of items.entries()) {
        let value: any = item;

        for (const stage of stages) {
          value = await stage(value, item, index);
        }

        results.push(value);
      }

      return results;
    },

    async workflow(request, args) {
      const child = await resolveChildWorkflow(request, args, options.resolveWorkflow);
      options.store.append({
        runId,
        type: "phase",
        index: ++counters.phase,
        title: child.name,
        kind: "child",
      });

      return child.script(createContext(runId, options, counters, child.args ?? {}));
    },

    log(message: string): void {
      options.store.append({ runId, type: "log", message });
    },
  };
}

async function resolveChildWorkflow(
  request: WorkflowInvocation,
  args: WorkflowArgs | undefined,
  resolver: WorkflowRuntimeOptions["resolveWorkflow"],
): Promise<ResolvedWorkflowInvocation> {
  if (request.script) {
    return {
      name: request.name ?? "workflow",
      script: request.script,
      args: args ?? request.args,
    };
  }

  if (!resolver) throw new Error("Child workflow resolver is not configured");
  return resolver(request, args);
}

function resolveModel(modelPolicy: ModelPolicy | undefined, model: string | undefined): ModelResolution | undefined {
  if (!model) return undefined;
  return modelPolicy?.resolveModel(model) ?? { model };
}

function withResolvedModel(
  agentOptions: { model?: string; schema?: unknown } | undefined,
  resolution: ModelResolution | undefined,
): { model?: string; schema?: unknown } | undefined {
  if (!resolution) return agentOptions;
  return {
    ...agentOptions,
    model: resolution.model,
  };
}

function withModel(event: WorkflowEvent, resolution: ModelResolution | undefined): WorkflowEvent {
  if (!resolution) return event;
  return {
    ...event,
    model: resolution.model,
    ...(resolution.requestedModel ? { requestedModel: resolution.requestedModel } : {}),
  };
}
