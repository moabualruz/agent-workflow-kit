import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setUltracode, workflowDisableReason, type WorkflowDisableControls } from "./config";
import type { AgentFunction, WorkflowArgs, WorkflowLaunchInput, WorkflowLaunchOutput, WorkflowRun, WorkflowStore } from "./domain";
import { requireText } from "./errors";
import type { AgentExecutionLimits } from "./execution-limits";
import type { ModelPolicy } from "./model-policy";
import type { PermissionPolicy } from "./permissions";
import { projectWorkflowProgress } from "./progress";
import { createWorkflowRuntime } from "./runtime";
import { resolveWorkflow, resolveWorkflowInvocation } from "./saved-workflows";
import { schemaDefaultAgent } from "./schema-default-agent";
import { createFileStore } from "./store";
import { saveGeneratedWorkflow } from "./workflow-authoring";

export type WorkflowCommandServiceOptions = {
  projectRoot: string;
  homeRoot?: string | undefined;
  agent?: AgentFunction;
  modelPolicy?: ModelPolicy | undefined;
  permissionPolicy?: PermissionPolicy | undefined;
  managedDisableWorkflows?: boolean | undefined;
  sessionDisableWorkflows?: boolean | undefined;
  // Model used when an agent() call omits opts.model (inherited by the runtime).
  sessionModel?: string | undefined;
  // Informational output-token target readable via budget.* (not enforced).
  tokenBudget?: number | null | undefined;
  executionLimits?: AgentExecutionLimits | undefined;
};

export type WorkflowCommandService = ReturnType<typeof createWorkflowCommandService>;

export function createWorkflowCommandService(options: WorkflowCommandServiceOptions) {
  const store = createFileStore({ projectRoot: options.projectRoot });
  const runtime = createWorkflowRuntime({
    store,
    agent: options.agent ?? schemaDefaultAgent,
    modelPolicy: options.modelPolicy,
    permissionPolicy: workflowPermissionPolicy(options.projectRoot, disableControlsFor(options), options.permissionPolicy),
    sessionModel: options.sessionModel,
    tokenBudget: options.tokenBudget,
    executionLimits: options.executionLimits,
    resolveWorkflow: (request, args) => resolveWorkflowInvocation(options.projectRoot, request, args, {
      homeRoot: options.homeRoot,
    }),
  });

  // Record the launched script's content hash on the run, so a later resume can
  // detect that the workflow file changed since the journal was produced.
  const recordScriptHash = (run: WorkflowRun, path: string | undefined): WorkflowRun => {
    const hash = path ? hashFile(path) : undefined;
    if (hash) store.append({ runId: run.runId, type: "run:script", message: hash });
    return run;
  };

  const withProgress = (run: WorkflowRun): WorkflowRun => ({
    ...run,
    progress: projectWorkflowProgress(run, store.eventsFor(run.runId)),
  });

  const runWorkflow = async (input: WorkflowLaunchInput, runOpts: { detach?: boolean } = {}) => {
    const workflow = await resolveWorkflowInvocation(options.projectRoot, input, undefined, {
      homeRoot: options.homeRoot,
    });
    const request = {
      name: workflow.name,
      script: workflow.script,
      ...(workflow.args !== undefined ? { args: workflow.args } : {}),
      ...(workflow.phaseModels !== undefined ? { phaseModels: workflow.phaseModels } : {}),
      ...(workflow.runModel !== undefined ? { runModel: workflow.runModel } : {}),
      ...(workflow.path !== undefined ? { scriptPath: workflow.path } : {}),
      ...(workflow.origin !== undefined ? { origin: workflow.origin } : {}),
      ...(workflow.generated !== undefined ? { generated: workflow.generated } : {}),
      ...(workflow.agentCountEstimate !== undefined ? { agentCountEstimate: workflow.agentCountEstimate } : {}),
      ...(workflow.isolationHints !== undefined ? { isolationHints: workflow.isolationHints } : {}),
      ...(workflow.writeHints !== undefined ? { writeHints: workflow.writeHints } : {}),
    };
    const runtimeOptions = input.resumeFromRunId ? { resumeFromRunId: input.resumeFromRunId } : {};
    const run = runOpts.detach ? await runtime.runDetached(request, runtimeOptions) : await runtime.run(request, runtimeOptions);
    return recordScriptHash(run, workflow.path);
  };

  return {
    async runAdHocWorkflow(task: string) {
      const normalizedTask = requireText(task, "workflow requires task text");
      // Generate the workflow file, then run it — matching Claude's
      // generate-then-run: the saved script is what executes, not a stub.
      const generated = saveGeneratedWorkflow(options.projectRoot, normalizedTask);
      const workflow = await resolveWorkflow(options.projectRoot, generated.name, {
        homeRoot: options.homeRoot,
      });
      const run = await runtime.run({ ...workflow, name: generated.name, scriptPath: workflow.path, generated: true, args: { task: normalizedTask, workflow: generated } });
      return recordScriptHash(run, workflow.path);
    },

    async runWorkflow(input: WorkflowLaunchInput, runOpts: { detach?: boolean } = {}) {
      return runWorkflow(input, runOpts);
    },

    async runSavedWorkflow(name: string, args: WorkflowArgs = {}, runOpts: { detach?: boolean; resumeFromRunId?: string | undefined } = {}) {
      const workflowName = requireText(name, "workflow-run requires workflow name");
      // Detached: returns the "running" handle immediately; poll with
      // workflow-status / workflow-events for completion.
      return runWorkflow(
        { name: workflowName, args, ...(runOpts.resumeFromRunId ? { resumeFromRunId: runOpts.resumeFromRunId } : {}) },
        runOpts.detach ? { detach: true } : {},
      );
    },

    async launchSavedWorkflow(name: string, args: WorkflowArgs = {}): Promise<WorkflowLaunchOutput> {
      const workflowName = requireText(name, "workflow launch requires workflow name");
      return launchOutputFor(await runWorkflow({ name: workflowName, args }, { detach: true }));
    },

    async launchWorkflow(input: WorkflowLaunchInput): Promise<WorkflowLaunchOutput> {
      return launchOutputFor(await runWorkflow(input, { detach: true }));
    },

    getRun(runId: string) {
      return withProgress(store.getRun(requireText(runId, "workflow-status requires run id")));
    },

    listRuns() {
      return store.listRuns().map(withProgress);
    },

    eventsFor(runId: string) {
      return store.eventsFor(requireText(runId, "workflow-events requires run id"));
    },

    async resumeRun(runId: string) {
      const id = requireText(runId, "workflow-resume requires run id");
      const prior = store.getRun(id);
      // Real resume: re-run the prior run's workflow with its original args,
      // replaying the unchanged agent() prefix from the prior journal. Prefer the
      // recorded scriptPath (round-trips for path-launched runs) and fall back to
      // the stored name; only when neither resolves do we degrade to a marker.
      const ref = prior.scriptPath ?? prior.name;
      try {
        const workflow = await resolveWorkflow(options.projectRoot, ref, {
          homeRoot: options.homeRoot,
        });

        // Surface a script-identity drift: if the workflow file changed since the
        // prior run, the old journal replays against a different body, which can
        // serve stale results for any call whose prompt/model still matches.
        // We warn rather than refuse — the prefix model still re-runs changed
        // calls — but the operator should know the script is not what produced
        // the journal.
        const currentHash = workflow.path ? hashFile(workflow.path) : undefined;
        const priorHash = recordedScriptHash(store, id);
        if (currentHash && priorHash && currentHash !== priorHash) {
          store.append({ runId: id, type: "run:script-changed", message: `workflow source changed since the original run (${priorHash} → ${currentHash}); replay may serve stale results for unchanged prompts` });
        }
        // An empty journal means nothing replays — the whole workflow re-runs
        // live. Make that observable instead of silent.
        if ((store.agentJournal?.(id)?.length ?? 0) === 0) {
          store.append({ runId: id, type: "run:resume-empty-journal", message: "no replayable agent results in the prior run; resuming as a full live re-run" });
        }

        store.resume(id);
        const run = await runtime.run(
          { ...workflow, args: prior.args === undefined ? {} : prior.args, scriptPath: workflow.path },
          { resumeFromRunId: id },
        );
        return recordScriptHash(run, workflow.path);
      } catch {
        store.append({ runId: id, type: "run:resume-skipped", message: `could not resolve workflow for resume: ${ref}` });
        return store.resume(id);
      }
    },

    stopRun(runId: string) {
      return store.stop(requireText(runId, "workflow-stop requires run id"));
    },

    async runDeepResearch(question: string) {
      const normalizedQuestion = requireText(question, "deep-research requires question text");
      const generated = saveGeneratedWorkflow(options.projectRoot, normalizedQuestion, "deep-research");
      const workflow = await resolveWorkflow(options.projectRoot, generated.name, {
        homeRoot: options.homeRoot,
      });
      const run = await runtime.run({ ...workflow, name: generated.name, scriptPath: workflow.path, generated: true, args: { question: normalizedQuestion, workflow: generated } });
      return recordScriptHash(run, workflow.path);
    },

    // Explicit ultracode enablement — ultracode is never ambient; it is turned on
    // or off by a deliberate command and persisted to project config.
    ultracode(action: string) {
      const normalized = (action || "status").trim().toLowerCase();
      if (normalized !== "on" && normalized !== "off" && normalized !== "status") {
        throw new Error("ultracode requires one of: on, off, status");
      }
      return setUltracode(options.projectRoot, normalized, disableControlsFor(options));
    },
  };
}

function disableControlsFor(options: WorkflowCommandServiceOptions): WorkflowDisableControls {
  return {
    ...(options.managedDisableWorkflows !== undefined ? { managedDisableWorkflows: options.managedDisableWorkflows } : {}),
    ...(options.homeRoot !== undefined ? { homeRoot: options.homeRoot } : {}),
    ...(options.sessionDisableWorkflows !== undefined ? { sessionDisableWorkflows: options.sessionDisableWorkflows } : {}),
  };
}

function workflowPermissionPolicy(
  projectRoot: string,
  controls: WorkflowDisableControls,
  policy: PermissionPolicy | undefined,
): PermissionPolicy {
  return {
    async authorizeDynamicWorkflow(request) {
      const disabledBy = workflowDisableReason(projectRoot, controls);
      if (disabledBy) {
        return {
          allowed: false,
          reason: `Dynamic workflow execution disabled by ${disabledBy}`,
        };
      }
      return policy?.authorizeDynamicWorkflow(request) ?? { allowed: true };
    },
  };
}

function launchOutputFor(run: WorkflowRun): WorkflowLaunchOutput {
  return {
    status: "async_launched",
    taskId: `task_${run.runId}`,
    runId: run.runId,
    summary: `Started workflow ${run.name}`,
    ...(run.artifacts?.transcriptDir ? { transcriptDir: run.artifacts.transcriptDir } : {}),
    ...(run.scriptPath ? { scriptPath: run.scriptPath } : {}),
  };
}

// SHA-256 of a workflow file's contents, or undefined if it cannot be read.
function hashFile(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex").slice(0, 16);
  } catch {
    return undefined;
  }
}

// The script hash recorded on a prior run (last `run:script` event), if any.
function recordedScriptHash(store: WorkflowStore, runId: string): string | undefined {
  const events = store.eventsFor(runId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "run:script" && typeof event.message === "string") return event.message;
  }
  return undefined;
}
