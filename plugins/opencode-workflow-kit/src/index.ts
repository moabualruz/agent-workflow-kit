import { tool, type Plugin } from "@opencode-ai/plugin";
import { createWorkflowCommandService } from "../../../packages/core/src/index";

export const server: Plugin = async (input) => {
  const projectRoot = input.directory || process.cwd();

  return {
    tool: {
      workflow: tool({
        description: "Run an ad hoc no-write workflow for a task.",
        args: {
          task: tool.schema.string(),
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(await service(args.projectRoot, context.directory ?? projectRoot).runAdHocWorkflow(args.task));
        },
      }),
      workflow_run: tool({
        description: "Run a saved Agent Workflow Kit workflow.",
        args: {
          workflow: tool.schema.string(),
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(await service(args.projectRoot, context.directory ?? projectRoot).runSavedWorkflow(args.workflow));
        },
      }),
      workflow_status: tool({
        description: "Read workflow run status from persisted state.",
        args: {
          runId: tool.schema.string(),
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(service(args.projectRoot, context.directory ?? projectRoot).getRun(args.runId));
        },
      }),
      workflow_events: tool({
        description: "Read workflow progress events from persisted state.",
        args: {
          runId: tool.schema.string(),
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(service(args.projectRoot, context.directory ?? projectRoot).eventsFor(args.runId));
        },
      }),
      workflow_resume: tool({
        description: "Resume a stopped workflow record without deleting artifacts.",
        args: {
          runId: tool.schema.string(),
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(service(args.projectRoot, context.directory ?? projectRoot).resumeRun(args.runId));
        },
      }),
      workflow_stop: tool({
        description: "Stop a workflow record while keeping it resumable.",
        args: {
          runId: tool.schema.string(),
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(service(args.projectRoot, context.directory ?? projectRoot).stopRun(args.runId));
        },
      }),
      workflows: tool({
        description: "List persisted workflow runs without transcript spam.",
        args: {
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(service(args.projectRoot, context.directory ?? projectRoot).listRuns());
        },
      }),
      deep_research: tool({
        description: "Run the bundled deep-research workflow.",
        args: {
          question: tool.schema.string(),
          projectRoot: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(await service(args.projectRoot, context.directory ?? projectRoot).runDeepResearch(args.question));
        },
      }),
    },
  };
};

export const workflowKitPlugin = {
  name: "opencode-workflow-kit",
  server,
};

export default workflowKitPlugin;

function service(projectRoot: string | undefined, fallbackRoot: string) {
  return createWorkflowCommandService({
    projectRoot: projectRoot?.trim() || fallbackRoot,
  });
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}
