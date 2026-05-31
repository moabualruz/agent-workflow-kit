import type { AgentFunction } from "./domain";
import { requireText } from "./errors";
import type { PermissionPolicy } from "./permissions";
import { createWorkflowRuntime } from "./runtime";
import { resolveWorkflowScript } from "./saved-workflows";
import { createFileStore } from "./store";

export type WorkflowCommandServiceOptions = {
  projectRoot: string;
  agent?: AgentFunction;
  permissionPolicy?: PermissionPolicy | undefined;
};

export type WorkflowCommandService = ReturnType<typeof createWorkflowCommandService>;

export function createWorkflowCommandService(options: WorkflowCommandServiceOptions) {
  const store = createFileStore({ projectRoot: options.projectRoot });
  const runtime = createWorkflowRuntime({
    store,
    agent: options.agent ?? (async () => ({ ok: true })),
    permissionPolicy: options.permissionPolicy,
  });

  return {
    runAdHocWorkflow(task: string) {
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

    async runSavedWorkflow(name: string) {
      const workflowName = requireText(name, "workflow-run requires workflow name");
      const script = await resolveWorkflowScript(options.projectRoot, workflowName);
      return runtime.run({ name: workflowName, script });
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
