import { describe, expect, test } from "bun:test";
import { projectUltracodeDisplay, projectWorkflowDisplay, type WorkflowEvent, type WorkflowRun } from "../src/index";

describe("workflow progress display model", () => {
  test("projects phases, agents, summaries, and actions from run state", () => {
    const run: WorkflowRun = {
      runId: "wf_display",
      name: "inspect-repo",
      status: "completed",
      artifacts: {
        root: "/tmp/awk/wf_display",
        runJson: "/tmp/awk/wf_display/run.json",
        eventsJsonl: "/tmp/awk/wf_display/events.jsonl",
        transcriptDir: "/tmp/awk/wf_display/transcripts",
      },
    };
    const events: WorkflowEvent[] = [
      { runId: run.runId, type: "run:started", timestamp: "2026-06-03T00:00:00.000Z" },
      { runId: run.runId, type: "phase", title: "Inspect", kind: "research" },
      {
        runId: run.runId,
        type: "agent:start",
        timestamp: "2026-06-03T00:00:01.000Z",
        key: "root#1",
        index: 1,
        group: "Inspect",
        label: "scanner",
        prompt: "inspect source tree",
      },
      {
        runId: run.runId,
        type: "agent:done",
        timestamp: "2026-06-03T00:00:03.000Z",
        key: "root#1",
        index: 1,
        group: "Inspect",
        label: "scanner",
        prompt: "inspect source tree",
        model: "sonnet",
        tokens: 12,
        result: { ok: true },
        transcriptPath: "/tmp/awk/wf_display/transcripts/001-root-1.json",
      },
      { runId: run.runId, type: "run:completed", timestamp: "2026-06-03T00:00:04.000Z" },
    ];

    const display = projectWorkflowDisplay(run, events, { now: Date.parse("2026-06-03T00:00:05.000Z") });

    expect(display).toEqual(expect.objectContaining({
      runId: "wf_display",
      title: "inspect-repo",
      status: "completed",
      summary: "1/1 agents done, 12 tokens",
      elapsedMs: 4_000,
      actions: [
        { id: "save", label: "Save workflow command", enabled: true },
      ],
      artifacts: expect.objectContaining({ transcriptDir: "/tmp/awk/wf_display/transcripts" }),
    }));
    expect(display.phases).toEqual([
      expect.objectContaining({
        id: "phase:Inspect",
        title: "Inspect",
        kind: "research",
        summary: "1/1 agents done, 12 tokens",
        agents: [
          expect.objectContaining({
            id: "agent:root#1",
            key: "root#1",
            index: 1,
            label: "scanner",
            status: "completed",
            prompt: "inspect source tree",
            model: "sonnet",
            tokens: 12,
            transcriptPath: "/tmp/awk/wf_display/transcripts/001-root-1.json",
            resultPreview: "{\"ok\":true}",
          }),
        ],
      }),
    ]);
  });

  test("projects stop and resume actions from run lifecycle state", () => {
    const running = projectWorkflowDisplay(
      { runId: "wf_running", name: "running-work", status: "running" },
      [{ runId: "wf_running", type: "run:started" }],
    );
    const stopped = projectWorkflowDisplay(
      { runId: "wf_stopped", name: "stopped-work", status: "stopped" },
      [{ runId: "wf_stopped", type: "run:started" }],
    );

    expect(running.actions).toContainEqual({ id: "stop", label: "Stop workflow", enabled: true });
    expect(stopped.actions).toContainEqual({ id: "resume", label: "Resume workflow", enabled: true });
    expect(stopped.actions).toContainEqual({ id: "save", label: "Save workflow command", enabled: true });
  });

  test("projects ultracode status into summary and actions", () => {
    const display = projectUltracodeDisplay({
      ultracode: true,
      standingOptIn: true,
      keywordTriggerEnabled: false,
      disabledReason: "project config",
      effortMode: "orchestration-only",
      effort: {
        modelEffort: "unsupported",
        orchestration: "disabled",
      },
      action: "status",
      path: "/tmp/project/.agent-workflow-kit/config.json",
    });

    expect(display).toEqual({
      title: "Ultracode",
      status: "disabled",
      summary: "standing opt-in enabled; keyword trigger disabled; orchestration disabled; model effort unsupported",
      path: "/tmp/project/.agent-workflow-kit/config.json",
      warnings: ["disabled by project config"],
      actions: [
        { id: "disable", label: "Disable ultracode", enabled: true },
        { id: "inspect-config", label: "Inspect config", enabled: true },
      ],
    });
  });
});
