import type {
  RunStatus,
  UltracodeDisplay,
  WorkflowAgentDisplay,
  WorkflowDisplayAction,
  WorkflowEvent,
  WorkflowPhaseProgress,
  WorkflowProgress,
  WorkflowRunDisplay,
  WorkflowRun,
  WorkflowRunningAgentProgress,
} from "./domain";
import type { UltracodeResult } from "./config";

type AgentProgressState = {
  key: string;
  index?: number | undefined;
  phase?: string | undefined;
  label?: string | undefined;
  agentType?: string | undefined;
  prompt?: string | undefined;
  status: "running" | "done" | "failed" | "cached";
  tokens: number;
  startedAt?: number | undefined;
};

type PhaseState = WorkflowPhaseProgress;

const UNGROUPED_PHASE = "Ungrouped";
const WARNING_EVENT_TYPES = new Set([
  "permission:denied",
  "run:script-changed",
  "run:resume-empty-journal",
  "run:resume-skipped",
]);

export function projectWorkflowProgress(
  run: WorkflowRun,
  events: WorkflowEvent[],
  options: { now?: number } = {},
): WorkflowProgress {
  const phases = new Map<string, PhaseState>();
  const agents = new Map<string, AgentProgressState>();
  const warnings: string[] = [];
  const now = options.now ?? Date.now();

  for (const event of events) {
    if (event.type === "phase" && event.title) {
      ensurePhase(phases, event.title, event.kind);
    }

    if (WARNING_EVENT_TYPES.has(event.type)) {
      const detail = event.message ?? event.error ?? event.type;
      warnings.push(detail);
    }

    if (event.type === "agent:start") {
      const phase = event.group ?? UNGROUPED_PHASE;
      ensurePhase(phases, phase);
      const key = agentKey(event);
      agents.set(key, {
        key,
        index: event.index,
        phase,
        label: event.label,
        agentType: event.agentType,
        prompt: event.prompt,
        status: "running",
        tokens: 0,
        startedAt: timestampMs(event.timestamp),
      });
    }

    if (event.type === "agent:done" || event.type === "agent:cached") {
      const phase = event.group ?? agents.get(agentKey(event))?.phase ?? UNGROUPED_PHASE;
      ensurePhase(phases, phase);
      const key = agentKey(event);
      const existing = agents.get(key);
      agents.set(key, {
        key,
        index: event.index ?? existing?.index,
        phase,
        label: event.label ?? existing?.label,
        agentType: event.agentType ?? existing?.agentType,
        prompt: event.prompt ?? existing?.prompt,
        status: event.type === "agent:cached" ? "cached" : event.error ? "failed" : "done",
        tokens: Math.max(0, event.tokens ?? existing?.tokens ?? 0),
        startedAt: existing?.startedAt ?? timestampMs(event.timestamp),
      });
    }
  }

  for (const agent of agents.values()) {
    const phase = ensurePhase(phases, agent.phase ?? UNGROUPED_PHASE);
    phase.agentTotal += 1;
    phase.tokenTotal += agent.tokens;
    if (agent.status === "running") phase.agentRunning += 1;
    else phase.agentDone += 1;
    if (agent.status === "failed") phase.agentFailed += 1;
    if (agent.status === "cached") phase.agentCached += 1;
  }

  const agentStates = [...agents.values()];
  const tokenTotal = agentStates.reduce((sum, agent) => sum + agent.tokens, 0);

  return {
    runId: run.runId,
    name: run.name,
    status: run.status,
    elapsedMs: elapsedMs(events, run.status, now),
    agentTotal: agentStates.length,
    agentDone: agentStates.filter((agent) => agent.status !== "running").length,
    agentRunning: agentStates.filter((agent) => agent.status === "running").length,
    agentFailed: agentStates.filter((agent) => agent.status === "failed").length,
    agentCached: agentStates.filter((agent) => agent.status === "cached").length,
    tokenTotal,
    phases: [...phases.values()],
    warnings,
    recentEvents: events.slice(-5),
    longestRunningAgent: longestRunningAgent(agentStates, now),
  };
}

export function projectWorkflowDisplay(
  run: WorkflowRun,
  events: WorkflowEvent[],
  options: { now?: number } = {},
): WorkflowRunDisplay {
  const progress = run.progress ?? projectWorkflowProgress(run, events, options);
  const agents = agentDisplays(events);
  const agentsByPhase = groupAgentsByPhase(agents);
  const phases = progress.phases.map((phase) => ({
    id: `phase:${phase.title}`,
    title: phase.title,
    ...(phase.kind ? { kind: phase.kind } : {}),
    summary: progressSummary(phase),
    agentTotal: phase.agentTotal,
    agentDone: phase.agentDone,
    agentRunning: phase.agentRunning,
    agentFailed: phase.agentFailed,
    agentCached: phase.agentCached,
    tokenTotal: phase.tokenTotal,
    agents: agentsByPhase.get(phase.title) ?? [],
  }));

  return {
    runId: run.runId,
    title: run.name,
    status: run.status,
    summary: progressSummary(progress),
    elapsedMs: progress.elapsedMs,
    tokenTotal: progress.tokenTotal,
    warnings: progress.warnings,
    actions: actionsForRun(run.status),
    phases,
    recentEvents: progress.recentEvents,
    ...(run.artifacts ? { artifacts: run.artifacts } : {}),
  };
}

export function projectUltracodeDisplay(result: UltracodeResult): UltracodeDisplay {
  const status = result.effort.orchestration;
  const summary = [
    `standing opt-in ${result.standingOptIn ? "enabled" : "disabled"}`,
    `keyword trigger ${result.keywordTriggerEnabled ? "enabled" : "disabled"}`,
    `orchestration ${result.effort.orchestration}`,
    `model effort ${result.effort.modelEffort}`,
  ].join("; ");
  return {
    title: "Ultracode",
    status,
    summary,
    path: result.path,
    warnings: result.disabledReason ? [`disabled by ${result.disabledReason}`] : [],
    actions: [
      result.ultracode
        ? { id: "disable", label: "Disable ultracode", enabled: true }
        : { id: "enable", label: "Enable ultracode", enabled: true },
      { id: "inspect-config", label: "Inspect config", enabled: true },
    ],
  };
}

function agentDisplays(events: WorkflowEvent[]): WorkflowAgentDisplay[] {
  const agents = new Map<string, WorkflowAgentDisplay>();

  for (const event of events) {
    if (event.type !== "agent:start" && event.type !== "agent:done" && event.type !== "agent:cached") continue;

    const key = agentKey(event);
    const existing = agents.get(key);
    const phase = event.group ?? existing?.phase ?? UNGROUPED_PHASE;
    const status = agentDisplayStatus(event);
    agents.set(key, {
      id: `agent:${key}`,
      key,
      index: event.index ?? existing?.index,
      phase,
      label: event.label ?? existing?.label,
      agentType: event.agentType ?? existing?.agentType,
      status,
      prompt: event.prompt ?? existing?.prompt,
      model: event.model ?? existing?.model,
      requestedModel: event.requestedModel ?? existing?.requestedModel,
      tokens: Math.max(0, event.tokens ?? existing?.tokens ?? 0),
      transcriptPath: event.transcriptPath ?? existing?.transcriptPath,
      resultPreview: event.result !== undefined ? preview(event.result) : existing?.resultPreview,
      error: event.error ?? existing?.error,
    });
  }

  return [...agents.values()].sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
}

function agentDisplayStatus(event: WorkflowEvent): WorkflowAgentDisplay["status"] {
  if (event.type === "agent:cached") return "cached";
  if (event.type === "agent:done") return event.error ? "failed" : "completed";
  return "running";
}

function groupAgentsByPhase(agents: WorkflowAgentDisplay[]): Map<string, WorkflowAgentDisplay[]> {
  const grouped = new Map<string, WorkflowAgentDisplay[]>();
  for (const agent of agents) {
    const list = grouped.get(agent.phase) ?? [];
    list.push(agent);
    grouped.set(agent.phase, list);
  }
  return grouped;
}

function actionsForRun(status: RunStatus): WorkflowDisplayAction[] {
  if (status === "running") return [
    { id: "stop", label: "Stop workflow", enabled: true },
  ];
  if (status === "stopped" || status === "failed") return [
    { id: "resume", label: "Resume workflow", enabled: true },
    { id: "save", label: "Save workflow command", enabled: true },
  ];
  return [
    { id: "save", label: "Save workflow command", enabled: true },
  ];
}

function progressSummary(value: Pick<WorkflowProgress | WorkflowPhaseProgress, "agentDone" | "agentTotal" | "agentRunning" | "agentFailed" | "tokenTotal">): string {
  const parts = [`${value.agentDone}/${value.agentTotal} agents done`];
  if (value.agentRunning > 0) parts.push(`${value.agentRunning} running`);
  if (value.agentFailed > 0) parts.push(`${value.agentFailed} failed`);
  if (value.tokenTotal > 0) parts.push(`${value.tokenTotal} tokens`);
  return parts.join(", ");
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function ensurePhase(phases: Map<string, PhaseState>, title: string, kind?: string): PhaseState {
  const existing = phases.get(title);
  if (existing) {
    if (kind && !existing.kind) existing.kind = kind;
    return existing;
  }
  const phase: PhaseState = {
    title,
    ...(kind ? { kind } : {}),
    agentTotal: 0,
    agentDone: 0,
    agentRunning: 0,
    agentFailed: 0,
    agentCached: 0,
    tokenTotal: 0,
  };
  phases.set(title, phase);
  return phase;
}

function agentKey(event: WorkflowEvent): string {
  return event.key ?? `index:${event.index ?? "unknown"}`;
}

function elapsedMs(events: WorkflowEvent[], status: RunStatus, now: number): number {
  const first = timestampMs(events[0]?.timestamp);
  if (first === undefined) return 0;
  const terminal = status === "running" ? undefined : lastTimestampMs(events);
  return Math.max(0, (terminal ?? now) - first);
}

function lastTimestampMs(events: WorkflowEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = timestampMs(events[index]?.timestamp);
    if (value !== undefined) return value;
  }
  return undefined;
}

function longestRunningAgent(agents: AgentProgressState[], now: number): WorkflowRunningAgentProgress | undefined {
  let longest: WorkflowRunningAgentProgress | undefined;
  for (const agent of agents) {
    if (agent.status !== "running" || agent.startedAt === undefined) continue;
    const candidate: WorkflowRunningAgentProgress = {
      key: agent.key,
      index: agent.index,
      phase: agent.phase,
      label: agent.label,
      agentType: agent.agentType,
      prompt: agent.prompt,
      elapsedMs: Math.max(0, now - agent.startedAt),
    };
    if (!longest || candidate.elapsedMs > longest.elapsedMs) longest = candidate;
  }
  return longest;
}

function timestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}
