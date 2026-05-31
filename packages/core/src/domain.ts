export type RunStatus = "running" | "completed" | "failed" | "stopped";

export type WorkflowRun = {
  runId: string;
  name: string;
  status: RunStatus;
  artifacts?: WorkflowArtifacts;
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
  title?: string;
  kind?: string;
  prompt?: string;
  model?: string;
  requestedModel?: string;
  result?: unknown;
  error?: string;
  message?: string;
};

export type AgentFunction = (prompt: string, options?: AgentOptions) => Promise<unknown>;

export type AgentOptions = {
  model?: string;
  schema?: unknown;
};

export type WorkflowArgs = Record<string, unknown>;

export type WorkflowScript = (context: WorkflowContext) => unknown | Promise<unknown>;

export type WorkflowContext = {
  args: WorkflowArgs;
  agent: (prompt: string, options?: AgentOptions) => Promise<unknown>;
  phase: (title: string) => void;
  parallel: <T>(tasks: Array<() => Promise<T> | T>) => Promise<T[]>;
  pipeline: <TInput>(
    items: TInput[],
    ...stages: Array<(value: any, item: TInput, index: number) => Promise<any> | any>
  ) => Promise<any[]>;
  workflow: (request: WorkflowInvocation) => Promise<unknown>;
  log: (message: string) => void;
};

export type WorkflowInvocation = {
  name: string;
  script: WorkflowScript;
  args?: WorkflowArgs;
};

export type RunRequest = {
  name: string;
  script: WorkflowScript;
  args?: WorkflowArgs;
};

export type WorkflowStore = {
  createRun: (name: string) => WorkflowRun;
  append: (event: WorkflowEvent) => void;
  complete: (runId: string, result: unknown) => WorkflowRun;
  fail: (runId: string, error: unknown) => WorkflowRun;
  eventsFor: (runId: string) => WorkflowEvent[];
  getRun?: (runId: string) => WorkflowRun;
  listRuns?: () => WorkflowRun[];
  stop?: (runId: string) => WorkflowRun;
  resume?: (runId: string) => WorkflowRun;
};
