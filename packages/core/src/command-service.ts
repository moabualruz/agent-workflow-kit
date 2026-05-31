import type { AgentFunction, WorkflowArgs } from "./domain";
import { requireText } from "./errors";
import type { ModelPolicy } from "./model-policy";
import type { PermissionPolicy } from "./permissions";
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
};

export type WorkflowCommandService = ReturnType<typeof createWorkflowCommandService>;

export function createWorkflowCommandService(options: WorkflowCommandServiceOptions) {
  const store = createFileStore({ projectRoot: options.projectRoot });
  const runtime = createWorkflowRuntime({
    store,
    agent: options.agent ?? schemaDefaultAgent,
    modelPolicy: options.modelPolicy,
    permissionPolicy: options.permissionPolicy,
    resolveWorkflow: (request, args) => resolveWorkflowInvocation(options.projectRoot, request, args, {
      homeRoot: options.homeRoot,
    }),
  });

  return {
    runAdHocWorkflow(task: string) {
      const normalizedTask = requireText(task, "workflow requires task text");
      const workflow = saveGeneratedWorkflow(options.projectRoot, normalizedTask);
      return runtime.run({
        name: "workflow",
        script: async ({ phase, log }) => {
          phase("Workflow");
          log(`task: ${normalizedTask}`);
          return { ok: true, task: normalizedTask, workflow };
        },
      });
    },

    async runSavedWorkflow(name: string, args: WorkflowArgs = {}) {
      const workflowName = requireText(name, "workflow-run requires workflow name");
      const workflow = await resolveWorkflow(options.projectRoot, workflowName, {
        homeRoot: options.homeRoot,
      });
      return runtime.run({ ...workflow, args });
    },

    getRun(runId: string) {
      return store.getRun(requireText(runId, "workflow-status requires run id"));
    },

    listRuns() {
      return store.listRuns();
    },

    eventsFor(runId: string) {
      return store.eventsFor(requireText(runId, "workflow-events requires run id"));
    },

    resumeRun(runId: string) {
      return store.resume(requireText(runId, "workflow-resume requires run id"));
    },

    stopRun(runId: string) {
      return store.stop(requireText(runId, "workflow-stop requires run id"));
    },

    runDeepResearch(question: string) {
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
