import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  result?: unknown;
  error?: string;
  message?: string;
};

export type AgentFunction = (prompt: string, options?: AgentOptions) => Promise<unknown>;

export type AgentOptions = {
  model?: string;
  schema?: unknown;
};

export type WorkflowScript = (context: WorkflowContext) => unknown | Promise<unknown>;

export type WorkflowContext = {
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
};

export type PermissionPolicy = {
  authorizeDynamicWorkflow: (request: { name: string }) => Promise<PermissionDecision> | PermissionDecision;
};

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type WorkflowRuntimeOptions = {
  store: WorkflowStore;
  agent: AgentFunction;
  permissionPolicy?: PermissionPolicy | undefined;
};

export type RunRequest = {
  name: string;
  script: WorkflowScript;
};

export type WorkflowCommandServiceOptions = {
  projectRoot: string;
  agent?: AgentFunction;
  permissionPolicy?: PermissionPolicy | undefined;
};

export type WorkflowCommandService = ReturnType<typeof createWorkflowCommandService>;
export type MemoryStore = ReturnType<typeof createMemoryStore>;
export type FileStore = ReturnType<typeof createFileStore>;

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

export function createMemoryStore() {
  const runs = new Map<string, WorkflowRun>();
  const events = new Map<string, WorkflowEvent[]>();

  return {
    createRun(name: string): WorkflowRun {
      const run: WorkflowRun = {
        runId: `wf_${randomUUID().slice(0, 12)}`,
        name,
        status: "running",
      };
      runs.set(run.runId, run);
      events.set(run.runId, [{ runId: run.runId, type: "run:started" }]);
      return run;
    },

    append(event: WorkflowEvent): void {
      events.get(event.runId)?.push(event);
    },

    complete(runId: string, result: unknown): WorkflowRun {
      const run = getRun(runs, runId);
      run.status = "completed";
      run.result = result;
      events.get(runId)?.push({ runId, type: "run:completed", result });
      return { ...run };
    },

    fail(runId: string, error: unknown): WorkflowRun {
      const run = getRun(runs, runId);
      run.status = "failed";
      run.error = stringifyError(error);
      events.get(runId)?.push({ runId, type: "run:failed", error: run.error });
      return { ...run };
    },

    eventsFor(runId: string): WorkflowEvent[] {
      return [...(events.get(runId) ?? [])];
    },
  };
}

export function createFileStore(options: { projectRoot: string }) {
  const runsRoot = join(options.projectRoot, ".agent-workflow-kit", "runs");
  mkdirSync(runsRoot, { recursive: true });

  return {
    createRun(name: string): WorkflowRun {
      const runId = `wf_${randomUUID().slice(0, 12)}`;
      const run: WorkflowRun = {
        runId,
        name,
        status: "running",
        artifacts: artifactPaths(runsRoot, runId),
      };
      mkdirSync(runDir(runsRoot, run.runId), { recursive: true });
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId: run.runId, type: "run:started" });
      return run;
    },

    append(event: WorkflowEvent): void {
      appendEvent(runsRoot, event);
    },

    complete(runId: string, result: unknown): WorkflowRun {
      const run = readRun(runsRoot, runId);
      run.status = "completed";
      run.result = result;
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId, type: "run:completed", result });
      return { ...run };
    },

    fail(runId: string, error: unknown): WorkflowRun {
      const run = readRun(runsRoot, runId);
      run.status = "failed";
      run.error = stringifyError(error);
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId, type: "run:failed", error: run.error });
      return { ...run };
    },

    eventsFor(runId: string): WorkflowEvent[] {
      const eventPath = join(runDir(runsRoot, runId), "events.jsonl");
      if (!existsSync(eventPath)) return [];
      return readFileSync(eventPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WorkflowEvent);
    },

    getRun(runId: string): WorkflowRun {
      return readRun(runsRoot, runId);
    },

    listRuns(): WorkflowRun[] {
      if (!existsSync(runsRoot)) return [];
      return readdirSync(runsRoot)
        .filter((entry) => existsSync(join(runsRoot, entry, "run.json")))
        .map((entry) => readRun(runsRoot, entry))
        .sort((a, b) => a.runId.localeCompare(b.runId));
    },

    stop(runId: string): WorkflowRun {
      const run = readRun(runsRoot, runId);
      run.status = "stopped";
      writeRun(runsRoot, run);
      appendEvent(runsRoot, { runId, type: "run:stopped" });
      return { ...run };
    },

    resume(runId: string): WorkflowRun {
      const run = readRun(runsRoot, runId);
      appendEvent(runsRoot, { runId, type: "run:resumed" });
      return { ...run };
    },
  };
}

export function createWorkflowRuntime(options: WorkflowRuntimeOptions) {
  return {
    async run(request: RunRequest): Promise<WorkflowRun> {
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
      const context = createContext(run.runId, options, counters);

      try {
        const result = await request.script(context);
        return options.store.complete(run.runId, result);
      } catch (error) {
        return options.store.fail(run.runId, error);
      }
    },
  };
}

export function createWorkflowCommandService(options: WorkflowCommandServiceOptions) {
  const store = createFileStore({ projectRoot: options.projectRoot });
  const runtime = createWorkflowRuntime({
    store,
    agent: options.agent ?? (async () => ({ ok: true })),
    permissionPolicy: options.permissionPolicy,
  });

  return {
    runAdHocWorkflow(task: string): Promise<WorkflowRun> {
      const normalizedTask = requireText(task, "workflow requires task text");
      return runtime.run({
        name: "workflow",
        script: async ({ phase, log }) => {
          phase("Workflow");
          log(`task: ${normalizedTask}`);
          return { ok: true, task: normalizedTask };
        },
      });
    },

    async runSavedWorkflow(name: string): Promise<WorkflowRun> {
      const workflowName = requireText(name, "workflow-run requires workflow name");
      const script = await resolveWorkflowScript(options.projectRoot, workflowName);
      return runtime.run({ name: workflowName, script });
    },

    getRun(runId: string): WorkflowRun {
      return store.getRun(requireText(runId, "workflow-status requires run id"));
    },

    listRuns(): WorkflowRun[] {
      return store.listRuns();
    },

    eventsFor(runId: string): WorkflowEvent[] {
      return store.eventsFor(requireText(runId, "workflow-events requires run id"));
    },

    resumeRun(runId: string): WorkflowRun {
      return store.resume(requireText(runId, "workflow-resume requires run id"));
    },

    stopRun(runId: string): WorkflowRun {
      return store.stop(requireText(runId, "workflow-stop requires run id"));
    },

    runDeepResearch(question: string): Promise<WorkflowRun> {
      const normalizedQuestion = requireText(question, "deep-research requires question text");
      return runtime.run({
        name: "deep-research",
        script: async ({ phase, log }) => {
          phase("Research");
          log(`question: ${normalizedQuestion}`);
          return { ok: true, question: normalizedQuestion };
        },
      });
    },
  };
}

export const denyDynamicWorkflowPolicy: PermissionPolicy = {
  authorizeDynamicWorkflow: () => ({
    allowed: false,
    reason: "Dynamic workflow execution denied by permission policy",
  }),
};

export type WorkflowScope = "project" | "personal";

export type SavedWorkflow = {
  scope?: WorkflowScope;
  name: string;
  script: WorkflowScript;
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

async function resolveWorkflowScript(projectRoot: string, workflowName: string): Promise<WorkflowScript> {
  assertWorkflowName(workflowName);
  const workflowPath = findWorkflowFile(projectRoot, workflowName);
  if (workflowPath) return loadWorkflowScript(workflowPath);

  const builtIn = builtInWorkflows.get(workflowName);
  if (builtIn) return builtIn;

  throw new Error(`Unknown workflow: ${workflowName}`);
}

function findWorkflowFile(projectRoot: string, workflowName: string): string | undefined {
  const candidates = [
    join(projectRoot, ".agent-workflow-kit", "workflows", `${workflowName}.js`),
    join(projectRoot, ".claude", "workflows", `${workflowName}.js`),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function loadWorkflowScript(workflowPath: string): Promise<WorkflowScript> {
  const module = await import(pathToFileURL(workflowPath).href);
  const script = module.default ?? module.workflow;
  if (typeof script !== "function") throw new Error(`Saved workflow must export a function: ${workflowPath}`);
  return script as WorkflowScript;
}

function assertWorkflowName(workflowName: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(workflowName)) throw new Error(`Invalid workflow name: ${workflowName}`);
}

function createContext(
  runId: string,
  options: WorkflowRuntimeOptions,
  counters: { phase: number; agent: number },
): WorkflowContext {
  const runAgent = async (prompt: string, agentOptions?: AgentOptions) => {
    const index = ++counters.agent;
    const model = agentOptions?.model;
    options.store.append(withModel({ runId, type: "agent:start", index, prompt }, model));

    try {
      const result = await options.agent(prompt, agentOptions);
      options.store.append(withModel({ runId, type: "agent:done", index, prompt, result }, model));
      return result;
    } catch (error) {
      options.store.append(withModel({ runId, type: "agent:done", index, prompt, error: stringifyError(error) }, model));
      throw error;
    }
  };

  return {
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

    async workflow(request) {
      options.store.append({
        runId,
        type: "phase",
        index: ++counters.phase,
        title: request.name,
        kind: "child",
      });

      return request.script(createContext(runId, options, counters));
    },

    log(message: string): void {
      options.store.append({ runId, type: "log", message });
    },
  };
}

function getRun(runs: Map<string, WorkflowRun>, runId: string): WorkflowRun {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown run id: ${runId}`);
  return run;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runDir(runsRoot: string, runId: string): string {
  return join(runsRoot, runId);
}

function writeRun(runsRoot: string, run: WorkflowRun): void {
  mkdirSync(runDir(runsRoot, run.runId), { recursive: true });
  writeFileSync(join(runDir(runsRoot, run.runId), "run.json"), `${JSON.stringify(run, null, 2)}\n`);
}

function readRun(runsRoot: string, runId: string): WorkflowRun {
  const run = JSON.parse(readFileSync(join(runDir(runsRoot, runId), "run.json"), "utf8")) as WorkflowRun;
  return { ...run, artifacts: run.artifacts ?? artifactPaths(runsRoot, runId) };
}

function appendEvent(runsRoot: string, event: WorkflowEvent): void {
  mkdirSync(runDir(runsRoot, event.runId), { recursive: true });
  appendFileSync(join(runDir(runsRoot, event.runId), "events.jsonl"), `${JSON.stringify(event)}\n`);
}

function requireText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function artifactPaths(runsRoot: string, runId: string): WorkflowArtifacts {
  const root = runDir(runsRoot, runId);
  return {
    root,
    runJson: join(root, "run.json"),
    eventsJsonl: join(root, "events.jsonl"),
  };
}

function withModel(event: WorkflowEvent, model: string | undefined): WorkflowEvent {
  return model ? { ...event, model } : event;
}
