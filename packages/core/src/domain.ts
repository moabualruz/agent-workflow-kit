export type RunStatus = "running" | "completed" | "failed" | "stopped";

export type WorkflowRun = {
  runId: string;
  name: string;
  status: RunStatus;
  artifacts?: WorkflowArtifacts;
  args?: WorkflowArgs;
  // Absolute path the workflow was loaded from, when known. Lets resume
  // re-resolve by path instead of re-deriving from the name.
  scriptPath?: string;
  result?: unknown;
  error?: string;
};

export type WorkflowArtifacts = {
  root: string;
  runJson: string;
  eventsJsonl: string;
};

export type WorkflowEvent = {
  runId: string;
  type: string;
  index?: number;
  // Stable replay key: "<scopePath>#<ordinal>", assigned at the synchronous
  // agent() call site so it is identical across runs regardless of completion
  // order. Resume matches journal entries on this key, not on array position.
  key?: string;
  // Global execution-order sequence across all scopes, assigned synchronously at
  // the call site. Drives cross-scope prefix invalidation on resume.
  seq?: number;
  title?: string;
  kind?: string;
  group?: string;
  label?: string;
  agentType?: string;
  prompt?: string;
  model?: string;
  requestedModel?: string;
  result?: unknown;
  // Output-token estimate this agent() call cost (summed across schema retries).
  // Journaled so a resume cache hit can re-apply the same budget spend.
  tokens?: number;
  error?: string;
  message?: string;
};

export type AgentFunction = (prompt: string, options?: AgentOptions) => Promise<unknown>;

export type AgentOptions = {
  model?: string;
  // When set, the result is validated against this JSON Schema and the call is
  // retried on mismatch (StructuredOutput contract).
  schema?: unknown;
  // Custom subagent type from the host's Agent registry (e.g. "Explore",
  // "code-reviewer"). Forwarded to the adapter; composes with schema.
  agentType?: string;
  // "worktree" runs the agent in a fresh git worktree (for file-mutating agents
  // that would otherwise conflict). Forwarded to the adapter.
  isolation?: "worktree";
  // Display label override for progress surfaces.
  label?: string;
  // Explicit progress-group assignment; defaults to the active phase title.
  phase?: string;
};

export type WorkflowArgs = Record<string, unknown>;

export type WorkflowScript = (context: WorkflowContext) => unknown | Promise<unknown>;

export type WorkflowBudget = {
  total: number | null;
  spent: () => number;
  remaining: () => number;
};

export type WorkflowContext = {
  args: WorkflowArgs;
  agent: (prompt: string, options?: AgentOptions) => Promise<unknown>;
  budget: WorkflowBudget;
  phase: (title: string) => void;
  parallel: <T>(tasks: Array<() => Promise<T> | T>) => Promise<Array<T | null>>;
  pipeline: <TInput>(
    items: TInput[],
    ...stages: Array<(value: any, item: TInput, index: number) => Promise<any> | any>
  ) => Promise<any[]>;
  workflow: (request: WorkflowInvocation, args?: WorkflowArgs) => Promise<unknown>;
  log: (message: string) => void;
};

export type WorkflowInvocation = {
  name?: string;
  script?: WorkflowScript;
  scriptPath?: string;
  args?: WorkflowArgs | undefined;
};

export type RunRequest = {
  name: string;
  script: WorkflowScript;
  args?: WorkflowArgs;
  // Per-phase / run-level model overrides parsed from a Claude-style meta block.
  phaseModels?: Record<string, string>;
  runModel?: string;
  // Absolute path the workflow was loaded from, recorded on the run for resume.
  scriptPath?: string | undefined;
};

export type AgentJournalEntry = {
  key: string;
  // Global execution-order sequence the call was issued at. Used for cross-scope
  // prefix invalidation on resume.
  seq: number;
  prompt: string;
  model?: string | undefined;
  result: unknown;
  // Output-token estimate the original generation cost, re-applied to budget on
  // a resume cache hit so spent()/remaining() stay replay-stable.
  tokens?: number | undefined;
};

export type WorkflowStore = {
  createRun: (name: string, args?: WorkflowArgs, scriptPath?: string) => WorkflowRun;
  append: (event: WorkflowEvent) => void;
  complete: (runId: string, result: unknown) => WorkflowRun;
  fail: (runId: string, error: unknown) => WorkflowRun;
  eventsFor: (runId: string) => WorkflowEvent[];
  getRun?: (runId: string) => WorkflowRun;
  listRuns?: () => WorkflowRun[];
  stop?: (runId: string) => WorkflowRun;
  resume?: (runId: string) => WorkflowRun;
  registerAbort?: (runId: string) => AbortSignal;
  clearAbort?: (runId: string) => void;
  agentJournal?: (runId: string) => AgentJournalEntry[];
};
