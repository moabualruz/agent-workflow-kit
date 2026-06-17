import type { AgentJournalEntry, AgentOptions, AgentTranscript, RunRequest, WorkflowArgs, WorkflowContext, WorkflowEvent, WorkflowInvocation, WorkflowRun, WorkflowScript, WorkflowStore } from "./domain";
import { stringifyError } from "./errors";
import { AgentExecutionLimitError, createAgentExecutionGate, type AgentExecutionLimits } from "./execution-limits";
import type { ModelPolicy, ModelResolution } from "./model-policy";
import type { PermissionPolicy } from "./permissions";
import { validateAgainstSchema } from "./schema-validation";

export class SchemaValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Agent result failed schema validation after retries: ${errors.join("; ")}`);
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

// Bounded retries when a schema-constrained agent returns a non-conforming
// result, mirroring Claude's "model retries on mismatch at the tool-call layer".
const MAX_SCHEMA_RETRIES = 2;
const DEFAULT_AGENT_HEARTBEAT_MS = 60_000;

export type RunOptions = {
  // Resume from a prior run: the longest unchanged prefix of agent() calls
  // returns cached results from that run's journal; the first changed/new call
  // and everything after it runs live. Same script + same args => 100% cache hit.
  resumeFromRunId?: string | undefined;
  // Informational output-token target for this run, readable via budget.* for
  // self-pacing. Not enforced — the host harness owns real limits. null = none.
  tokenBudget?: number | null | undefined;
};

class WorkflowAbortError extends Error {
  constructor() {
    super("Workflow run stopped");
    this.name = "WorkflowAbortError";
  }
}

// An error is an abort if it's the abort sentinel or the run's signal already
// tripped — used by the barriers to re-raise rather than swallow it.
function isAbort(error: unknown, state: { signal?: AbortSignal | undefined }): boolean {
  return error instanceof WorkflowAbortError || Boolean(state.signal?.aborted);
}

type RunState = {
  signal?: AbortSignal | undefined;
  replay: ReplayCache;
  // Title of the most recent phase(), used as the default progress group for
  // agent() calls that don't pass opts.phase.
  activePhase?: string | undefined;
  // Per-phase-title and run-level model overrides parsed from meta. Model
  // precedence for a call: opts.model > phase model > run model > session model.
  phaseModels?: Record<string, string> | undefined;
  runModel?: string | undefined;
  // Global execution-order counter, SHARED across the root and every child
  // workflow scope (one object per run, threaded through createContext). Assigned
  // synchronously at each agent()/workflow() call site so resume invalidation is
  // a single cross-scope prefix, matching Claude's "longest unchanged prefix".
  sequence: { value: number };
};

// Claude allows one level of nesting only: workflow() inside a child throws.
const MAX_WORKFLOW_DEPTH = 1;

// Per-scope synchronous call counter. The agent index is assigned at the
// synchronous call site (before the concurrency gate awaits) so that two agent()
// calls issued in source order get stable indices across runs — otherwise
// concurrent parallel()/pipeline() calls would be numbered in resolution order,
// which differs run to run and breaks prefix-replay resume. Each workflow scope
// (root or a child) keeps its own ordinal namespace, prefixed by a scope path,
// so a child's calls never collide with the parent's.
type ScopeCounter = { next: () => string; path: string };

function createScopeCounter(scopePath: string): ScopeCounter {
  let ordinal = 0;
  return {
    path: scopePath,
    next: () => `${scopePath}#${++ordinal}`,
  };
}

// Shared output-token accounting for a run, OBSERVABILITY ONLY. The pool is
// shared across the root and every child workflow (one tracker per run()) so a
// workflow can read budget.spent()/remaining() and pace itself. Agent Workflow
// Kit never enforces a ceiling — the host harness owns real token limits — so
// `total` is informational (a self-pacing target the script may set) and an
// agent() call is never blocked or thrown for exceeding it.
type BudgetTracker = {
  total: number | null;
  spent: () => number;
  remaining: () => number;
  add: (tokens: number) => void;
};

function createBudgetTracker(total: number | null): BudgetTracker {
  let spent = 0;
  const remaining = () => (total === null ? Number.POSITIVE_INFINITY : Math.max(0, total - spent));
  return {
    total,
    spent: () => spent,
    remaining,
    add: (tokens) => {
      spent += Math.max(0, tokens);
    },
  };
}

function estimateOutputTokens(result: unknown): number {
  // Rough fallback when the adapter does not report real usage: ~4 chars/token.
  const text = typeof result === "string" ? result : JSON.stringify(result ?? "");
  return Math.ceil(text.length / 4);
}

export type WorkflowRuntimeOptions = {
  store: WorkflowStore;
  agent: (prompt: string, options?: AgentOptions) => Promise<unknown>;
  modelPolicy?: ModelPolicy | undefined;
  permissionPolicy?: PermissionPolicy | undefined;
  // Model used when an agent() call omits opts.model (Claude inherits the
  // session model). Run through the alias policy like any other model.
  sessionModel?: string | undefined;
  // Default informational output-token target for runs; null = none. RunOptions
  // overrides per run.
  tokenBudget?: number | null | undefined;
  // Output-token estimate for a completed agent() call. Adapters that report
  // real usage should supply this; otherwise a length-based estimate is used.
  estimateTokens?: (prompt: string, result: unknown) => number;
  // Low-rate progress event while a live agent call is still running. null or 0 disables it.
  agentHeartbeatMs?: number | null | undefined;
  executionLimits?: AgentExecutionLimits | undefined;
  resolveWorkflow?: (request: WorkflowInvocation, args?: WorkflowArgs) => Promise<ResolvedWorkflowInvocation>;
};

export type ResolvedWorkflowInvocation = {
  name: string;
  script: WorkflowScript;
  args?: WorkflowArgs | undefined;
  phaseModels?: Record<string, string> | undefined;
  runModel?: string | undefined;
  path?: string | undefined;
  origin?: "saved" | "source" | "path" | "built-in" | undefined;
  generated?: boolean | undefined;
  agentCountEstimate?: number | undefined;
  isolationHints?: string[] | undefined;
  writeHints?: string[] | undefined;
};

export function createWorkflowRuntime(options: WorkflowRuntimeOptions) {
  // Allocate the run and run the permission gate. Returns either a denied
  // terminal run, or the execute() continuation that runs the script body.
  function begin(request: RunRequest, runOptions: RunOptions) {
    const run = options.store.createRun(request.name, request.args, request.scriptPath);
    const gate = options.permissionPolicy?.authorizeDynamicWorkflow(permissionRequestFor(request)) ?? { allowed: true };

    const execute = async (decision: PermissionDecisionLike): Promise<WorkflowRun> => {
      if (!decision.allowed) {
        options.store.append({ runId: run.runId, type: "permission:denied", message: decision.reason });
        return options.store.fail(run.runId, new Error(decision.reason));
      }

      const counters = { phase: 0 };
      const agentGate = createAgentExecutionGate(options.executionLimits);
      const budget = createBudgetTracker(runOptions.tokenBudget ?? options.tokenBudget ?? null);
      const state: RunState = {
        signal: options.store.registerAbort?.(run.runId),
        replay: createReplayCache(runOptions.resumeFromRunId ? options.store.agentJournal?.(runOptions.resumeFromRunId) : undefined),
        phaseModels: request.phaseModels,
        runModel: request.runModel,
        sequence: { value: 0 },
      };
      const context = createContext(run.runId, options, counters, agentGate, request.args ?? {}, state, createScopeCounter("root"), 0, budget);

      try {
        const result = await request.script(context);
        // A stop() fired mid-flight may have been swallowed by a parallel()/
        // pipeline() barrier (those resolve a failed task to null rather than
        // rejecting), so the script can resolve normally even though the run was
        // aborted. Recheck the signal before completing so an aborted run lands
        // on "stopped" instead of overwriting it with "completed".
        if (state.signal?.aborted) {
          return options.store.stop?.(run.runId) ?? options.store.fail(run.runId, new WorkflowAbortError());
        }
        return options.store.complete(run.runId, result);
      } catch (error) {
        if (state.signal?.aborted || error instanceof WorkflowAbortError) {
          return options.store.stop?.(run.runId) ?? options.store.fail(run.runId, error);
        }
        return options.store.fail(run.runId, error);
      } finally {
        options.store.clearAbort?.(run.runId);
      }
    };

    return { run, gate, execute };
  }

  return {
    // Blocking run: resolves with the terminal run record.
    async run(request: RunRequest, runOptions: RunOptions = {}) {
      const { gate, execute } = begin(request, runOptions);
      return execute(await gate);
    },

    // Detached run: returns the initial "running" handle immediately and executes
    // in the background, writing the terminal status (and a notify event) to the
    // store, where workflow-status / workflow-events can poll it. A run denied by
    // the permission gate still resolves synchronously to failed.
    async runDetached(request: RunRequest, runOptions: RunOptions = {}) {
      const { run, gate, execute } = begin(request, runOptions);
      const decision = await gate;
      if (!decision.allowed) return execute(decision);

      void execute(decision)
        .then((terminal) => {
          options.store.append({ runId: run.runId, type: "run:notify", message: terminal.status });
        })
        .catch((error) => {
          options.store.append({ runId: run.runId, type: "run:notify", error: stringifyError(error) });
        });

      return run;
    },
  };
}

type PermissionDecisionLike = { allowed: true } | { allowed: false; reason: string };

function createContext(
  runId: string,
  options: WorkflowRuntimeOptions,
  counters: { phase: number },
  agentGate: ReturnType<typeof createAgentExecutionGate>,
  args: WorkflowArgs,
  state: RunState,
  scopeCounter: ScopeCounter,
  depth: number,
  budget: BudgetTracker,
): WorkflowContext {
  let displayIndex = 0;
  // Per-scope child-workflow counter, separate from the agent ordinal so a
  // workflow() call does not shift later parent agent() keys.
  let childIndex = 0;

  const runAgent = async (prompt: string, agentOptions?: AgentOptions) => {
    // Assign the stable replay key AND the global execution-order sequence
    // SYNCHRONOUSLY, before the concurrency gate awaits, so source-order calls
    // get stable identities regardless of which resolves first. `key` is the
    // identity (scope#ordinal); `seq` is the cross-scope execution order that
    // drives prefix invalidation. The numeric index is display-only.
    const key = scopeCounter.next();
    const seq = ++state.sequence.value;
    const index = ++displayIndex;
    const group = agentOptions?.phase ?? state.activePhase;
    // Model precedence: explicit opts.model > the active phase's meta model >
    // the run's meta model > the runtime session model.
    const phaseModel = group ? state.phaseModels?.[group] : undefined;
    const model = resolveModel(
      options.modelPolicy,
      agentOptions?.model ?? phaseModel ?? state.runModel ?? options.sessionModel,
    );
    const meta = {
      ...(agentOptions?.label ? { label: agentOptions.label } : {}),
      ...(agentOptions?.agentType ? { agentType: agentOptions.agentType } : {}),
      ...(group ? { group } : {}),
    };

    // Resume replay decided SYNCHRONOUSLY, in true call-site order: matching the
    // journal by key + prompt + model returns the cached result, but only while
    // this call's seq is still within the unchanged prefix. The first divergent
    // call (changed/new) records its seq globally, so it and EVERY later call
    // (any scope, including child workflows) run live — Claude's "longest
    // unchanged prefix" across the whole execution stream, not per-scope. Doing
    // this before the gate await means completion-order reordering cannot affect
    // which calls are treated as prefix.
    const cached = state.replay.take(key, prompt, model?.model, seq);

    try {
      return await agentGate.run(async () => {
        if (state.signal?.aborted) throw new WorkflowAbortError();

        // A replayed call re-applies the SAME token spend the original generation
        // cost (journaled as `tokens`), so budget.spent()/remaining() are stable
        // across a fresh run and its resume — a budget-sensitive branch takes the
        // same path either way. The adapter is still not re-invoked.
        if (cached.hit) {
          budget.add(cached.tokens ?? 0);
          const transcriptPath = writeAgentTranscript(options, {
            runId,
            key,
            seq,
            index,
            status: "cached",
            prompt,
            result: cached.result,
            ...(cached.tokens !== undefined ? { tokens: cached.tokens } : {}),
            ...meta,
            ...modelTranscriptFields(model),
          });
          options.store.append(withModel({ runId, type: "agent:cached", index, key, seq, prompt, result: cached.result, ...(cached.tokens !== undefined ? { tokens: cached.tokens } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...meta }, model));
          return cached.result;
        }

        const startEvent = withModel({ runId, type: "agent:start", index, key, seq, prompt, ...meta }, model);
        options.store.append(startEvent);

        // Accumulate this call's spend across all generations (incl. schema
        // retries) so the total can be journaled on agent:done and re-applied on a
        // future resume's cache hit.
        let callTokens = 0;
        const heartbeat = startAgentHeartbeat(options, startEvent, model);
        try {
          const result = await runAgentWithSchema(options, prompt, agentOptions, model, {
            onRetry: (errors, attempt) => {
              options.store.append(withModel({ runId, type: "agent:retry", index, key, seq, prompt, error: errors.join("; "), ...meta }, model));
              void attempt;
            },
            charge: (chargedPrompt, chargedResult) => {
              const tokens = options.estimateTokens ? options.estimateTokens(chargedPrompt, chargedResult) : estimateOutputTokens(chargedResult);
              callTokens += Math.max(0, tokens);
              budget.add(tokens);
              enforceEstimatedTokenLimit(options.executionLimits, budget.spent());
            },
          });
          const transcriptPath = writeAgentTranscript(options, {
            runId,
            key,
            seq,
            index,
            status: "completed",
            prompt,
            result,
            tokens: callTokens,
            ...meta,
            ...modelTranscriptFields(model),
          });
          options.store.append(withModel({ runId, type: "agent:done", index, key, seq, prompt, result, tokens: callTokens, ...(transcriptPath ? { transcriptPath } : {}), ...meta }, model));
          return result;
        } catch (error) {
          const message = stringifyError(error);
          const transcriptPath = writeAgentTranscript(options, {
            runId,
            key,
            seq,
            index,
            status: "failed",
            prompt,
            error: message,
            ...meta,
            ...modelTranscriptFields(model),
          });
          options.store.append(withModel({ runId, type: "agent:done", index, key, seq, prompt, error: message, ...(transcriptPath ? { transcriptPath } : {}), ...meta }, model));
          throw error;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      });
    } catch (error) {
      if (error instanceof AgentExecutionLimitError) {
        options.store.append(withModel({ runId, type: "agent:limit", index, key, seq, prompt, error: error.message, ...meta }, model));
      }
        throw error;
    }
  };

  return {
    args,
    agent: runAgent,
    budget: {
      total: budget.total,
      spent: () => budget.spent(),
      remaining: () => budget.remaining(),
    },

    phase(title: string): void {
      state.activePhase = title;
      options.store.append({ runId, type: "phase", index: ++counters.phase, title });
    },

    parallel(tasks) {
      // Barrier that never rejects: a thunk that throws resolves to null in the
      // result array, so callers can `.filter(Boolean)` instead of try/catch.
      // A stop()-driven abort is NOT a thunk failure — re-raise it so the run
      // unwinds to "stopped" instead of being swallowed into a null result.
      return Promise.all(tasks.map(async (task) => {
        try {
          return await task();
        } catch (error) {
          if (isAbort(error, state) || error instanceof AgentExecutionLimitError) throw error;
          return null;
        }
      }));
    },

    pipeline(items, ...stages) {
      // No barrier between stages: each item flows through all stages
      // independently, so item A can be in stage 3 while item B is still in
      // stage 1. A stage that throws drops that item to null and skips its
      // remaining stages. An abort re-raises so stop() halts the run.
      return Promise.all(
        items.map(async (item, index) => {
          let value: any = item;
          for (const stage of stages) {
            try {
              value = await stage(value, item, index);
            } catch (error) {
              if (isAbort(error, state) || error instanceof AgentExecutionLimitError) throw error;
              return null;
            }
          }
          return value;
        }),
      );
    },

    async workflow(request, args) {
      // One level of nesting only: a workflow() call inside a child throws,
      // matching Claude. The depth guard is checked synchronously.
      if (depth >= MAX_WORKFLOW_DEPTH) {
        throw new Error("Nested workflow() is not allowed: workflows may nest one level only");
      }
      const configuredDepth = options.executionLimits?.maxChildWorkflowDepth;
      if (configuredDepth !== undefined && depth >= configuredDepth) {
        const title = request.name ?? request.scriptPath ?? "workflow";
        const error = new AgentExecutionLimitError(`Child workflow depth limit exceeded: maxChildWorkflowDepth=${configuredDepth}`);
        options.store.append({ runId, type: "workflow:limit", title, error: error.message });
        throw error;
      }

      // The child scope prefix comes from a SEPARATE per-parent child counter, so
      // spawning a child no longer perturbs the parent's agent() ordinal
      // namespace — adding/removing a workflow() call leaves later parent agent
      // keys stable. The global sequence still advances (the workflow() call is
      // an execution-order point) so the child's agent() calls sort AFTER parent
      // calls issued before it and BEFORE parent calls issued after it.
      const childOrdinal = `${scopeCounter.path}@child${++childIndex}`;
      state.sequence.value += 1;
      const child = await resolveChildWorkflow(request, args, options.resolveWorkflow);
      options.store.append({
        runId,
        type: "phase",
        index: ++counters.phase,
        title: child.name,
        kind: "child",
      });

      // The child gets its own scope namespace so its agent keys never collide
      // with the parent's, keeping replay sound across nesting. It shares the
      // signal, replay journal, budget, AND the global sequence, but uses its OWN
      // meta models and a fresh active-phase tracker.
      const childScope = createScopeCounter(`${childOrdinal}:${child.name}`);
      const childState: RunState = {
        signal: state.signal,
        replay: state.replay,
        phaseModels: child.phaseModels,
        runModel: child.runModel,
        sequence: state.sequence,
      };
      return child.script(
        // Same budget tracker → the token pool is shared across parent and child.
        createContext(runId, options, counters, agentGate, child.args ?? {}, childState, childScope, depth + 1, budget),
      );
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
  if (typeof request.script === "function") {
    return {
      name: request.name ?? "workflow",
      script: request.script,
      args: args ?? request.args,
    };
  }

  if (!resolver) throw new Error("Child workflow resolver is not configured");
  return resolver(request, args);
}

type ReplayCache = {
  take: (key: string, prompt: string, model: string | undefined, seq: number) =>
    | { hit: true; result: unknown; tokens: number | undefined }
    | { hit: false };
};

function createReplayCache(journal: AgentJournalEntry[] | undefined): ReplayCache {
  // Global execution-order prefix invalidation: a call whose stable key maps to
  // the same (prompt, model) in the prior journal returns its cached result, but
  // only while no EARLIER call (lower seq, in ANY scope including child
  // workflows) has diverged. The first divergent call records its seq, and every
  // call at or after that seq runs live — Claude's "longest unchanged prefix"
  // over the whole cross-scope execution stream. take() is invoked synchronously
  // at the call site in seq order, so completion-order reordering cannot change
  // which calls fall inside the prefix.
  if (!journal?.length) return { take: () => ({ hit: false }) };
  const byKey = new Map<string, AgentJournalEntry>();
  for (const entry of journal) byKey.set(entry.key, entry);
  const consumed = new Set<string>();
  let firstMissedSeq = Number.POSITIVE_INFINITY;

  return {
    take(key, prompt, model, seq) {
      // Past the first divergence point — live.
      if (seq >= firstMissedSeq) return { hit: false };
      if (consumed.has(key)) return { hit: false };
      const entry = byKey.get(key);
      if (!entry || entry.prompt !== prompt || (entry.model ?? undefined) !== (model ?? undefined)) {
        firstMissedSeq = Math.min(firstMissedSeq, seq);
        return { hit: false };
      }
      consumed.add(key);
      return { hit: true, result: entry.result, tokens: entry.tokens };
    },
  };
}

function resolveModel(modelPolicy: ModelPolicy | undefined, model: string | undefined): ModelResolution | undefined {
  if (!model) return undefined;
  return modelPolicy?.resolveModel(model) ?? { model };
}

function withResolvedModel(
  agentOptions: AgentOptions | undefined,
  resolution: ModelResolution | undefined,
): AgentOptions | undefined {
  if (!resolution) return agentOptions;
  return {
    ...agentOptions,
    model: resolution.model,
  };
}

type SchemaRunHooks = {
  onRetry: (errors: string[], attempt: number) => void;
  // Record token spend for one model generation — so EVERY generation (including
  // schema retries) is observable via budget.spent(), not just the final result.
  // This is accounting only; it never blocks or throws.
  charge: (prompt: string, result: unknown) => void;
};

// Invoke the adapter and, when a schema is present, validate the result and
// retry with the validation errors appended to the prompt, up to a bounded
// number of attempts. Without a schema, the adapter result is returned as-is.
// Budget is charged per generation via hooks.
async function runAgentWithSchema(
  options: WorkflowRuntimeOptions,
  prompt: string,
  agentOptions: AgentOptions | undefined,
  model: ModelResolution | undefined,
  hooks: SchemaRunHooks,
): Promise<unknown> {
  const resolved = withResolvedModel(agentOptions, model);
  const schema = agentOptions?.schema;
  if (!schema) {
    const result = await options.agent(prompt, resolved);
    hooks.charge(prompt, result);
    return result;
  }

  let lastErrors: string[] = [];
  for (let attempt = 0; attempt <= MAX_SCHEMA_RETRIES; attempt += 1) {
    const attemptPrompt = attempt === 0
      ? prompt
      : `${prompt}\n\nThe previous response did not satisfy the required schema. Fix these problems and return only a valid result:\n- ${lastErrors.join("\n- ")}`;
    const result = await options.agent(attemptPrompt, resolved);
    // Charge every generation, valid or not — a retried response still cost
    // real model output.
    hooks.charge(attemptPrompt, result);
    const validation = validateAgainstSchema(result, schema);
    if (validation.valid) return result;
    lastErrors = validation.errors;
    if (attempt < MAX_SCHEMA_RETRIES) hooks.onRetry(lastErrors, attempt + 1);
  }
  throw new SchemaValidationError(lastErrors);
}

function withModel(event: WorkflowEvent, resolution: ModelResolution | undefined): WorkflowEvent {
  if (!resolution) return event;
  return {
    ...event,
    model: resolution.model,
    ...(resolution.requestedModel ? { requestedModel: resolution.requestedModel } : {}),
  };
}

function startAgentHeartbeat(
  options: WorkflowRuntimeOptions,
  startEvent: WorkflowEvent,
  resolution: ModelResolution | undefined,
): ReturnType<typeof setInterval> | undefined {
  const intervalMs = options.agentHeartbeatMs === undefined ? DEFAULT_AGENT_HEARTBEAT_MS : options.agentHeartbeatMs;
  if (intervalMs === null || intervalMs <= 0) return undefined;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    options.store.append(withModel({
      runId: startEvent.runId,
      type: "agent:heartbeat",
      ...(startEvent.index !== undefined ? { index: startEvent.index } : {}),
      ...(startEvent.key !== undefined ? { key: startEvent.key } : {}),
      ...(startEvent.seq !== undefined ? { seq: startEvent.seq } : {}),
      ...(startEvent.prompt !== undefined ? { prompt: startEvent.prompt } : {}),
      ...(startEvent.group !== undefined ? { group: startEvent.group } : {}),
      ...(startEvent.label !== undefined ? { label: startEvent.label } : {}),
      ...(startEvent.agentType !== undefined ? { agentType: startEvent.agentType } : {}),
      message: `still running after ${elapsedSeconds}s`,
    }, resolution));
  }, intervalMs);
  const maybeUnref = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeUnref.unref?.();
  return timer;
}

function permissionRequestFor(request: RunRequest) {
  return {
    name: request.name,
    ...(request.scriptPath ? { scriptPath: request.scriptPath } : {}),
    ...(request.args !== undefined ? { args: request.args } : {}),
    argsPreview: previewArgs(request.args),
    ...(request.origin !== undefined ? { origin: request.origin } : {}),
    generated: request.generated === true,
    ...(request.agentCountEstimate !== undefined ? { agentCountEstimate: request.agentCountEstimate } : {}),
    isolationHints: request.isolationHints ?? [],
    writeHints: request.writeHints ?? [],
  };
}

function previewArgs(args: WorkflowArgs | undefined): string {
  try {
    return JSON.stringify(args ?? {}) ?? "{}";
  } catch {
    return "[unserializable args]";
  }
}

function modelTranscriptFields(resolution: ModelResolution | undefined): Pick<AgentTranscript, "model" | "requestedModel"> {
  if (!resolution) return {};
  return {
    model: resolution.model,
    ...(resolution.requestedModel ? { requestedModel: resolution.requestedModel } : {}),
  };
}

function writeAgentTranscript(options: WorkflowRuntimeOptions, entry: AgentTranscript): string | undefined {
  return options.store.writeAgentTranscript?.(entry);
}

function enforceEstimatedTokenLimit(limits: AgentExecutionLimits | undefined, spent: number): void {
  if (!limits?.stopOnEstimatedTokenLimit) return;
  if (limits.maxEstimatedTokens === undefined) return;
  if (spent <= limits.maxEstimatedTokens) return;
  throw new AgentExecutionLimitError(`Estimated token limit exceeded: maxEstimatedTokens=${limits.maxEstimatedTokens}`);
}
