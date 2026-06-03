import type {
  RunStatus,
  WorkflowEvent,
  WorkflowPhaseProgress,
  WorkflowProgress,
  WorkflowRun,
  WorkflowRunningAgentProgress,
} from "./domain";

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
