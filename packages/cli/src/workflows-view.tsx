import {
  projectUltracodeDisplay,
  projectWorkflowDisplay,
  type UltracodeResult,
  type WorkflowEvent,
  type WorkflowRun,
} from "@agent-workflow-kit/core";

export function formatHuman(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.every(isRunRecord)) return formatRunTable(value as WorkflowRun[]);
    return value.map((entry) => formatHuman(entry)).join("\n");
  }

  if (isRecord(value) && "runId" in value && "status" in value) {
    return formatRun(value as Record<string, unknown>);
  }

  if (isRecord(value) && "type" in value && "runId" in value) {
    return formatEventLine(value as Record<string, unknown>);
  }

  if (isUltracodeResult(value)) {
    return formatUltracode(value);
  }

  return JSON.stringify(value);
}

export function formatRunTree(run: WorkflowRun, events: WorkflowEvent[]): string {
  const display = projectWorkflowDisplay(run, events);
  const lines = [
    [display.runId, display.title, display.status].join(" "),
    `  summary: ${display.summary}`,
    `  actions: ${enabledActionIds(display.actions).join(", ") || "none"}`,
  ];
  if (display.warnings.length > 0) lines.push(`  warnings: ${display.warnings.join("; ")}`);
  if (display.artifacts?.runJson) lines.push(`  run.json: ${display.artifacts.runJson}`);
  if (display.artifacts?.transcriptDir) lines.push(`  transcripts: ${display.artifacts.transcriptDir}`);
  lines.push("  phases:");
  for (const phase of display.phases) {
    lines.push(`    - ${phase.title} ${phase.summary}`);
    for (const agent of phase.agents) {
      const label = agent.label ? `${agent.label}: ` : "";
      const index = agent.index === undefined ? agent.key : `#${agent.index}`;
      const prompt = agent.prompt ? ` ${label}${agent.prompt}` : "";
      const tokens = agent.tokens > 0 ? ` (${agent.tokens} tokens)` : "";
      const result = agent.resultPreview ? ` -> ${agent.resultPreview}` : "";
      lines.push(`      - ${index} ${agent.status}${prompt}${tokens}${result}`);
    }
  }
  return lines.join("\n");
}

function formatRun(run: Record<string, unknown>): string {
  const lines = [[run.runId, run.name, run.status].filter(Boolean).join(" ")];
  if (typeof run.error === "string" && run.error) lines.push(`  error: ${run.error}`);
  if (run.result !== undefined) lines.push(`  result: ${summarize(run.result)}`);
  const progress = formatProgress(run.progress);
  if (progress) lines.push(`  progress: ${progress}`);
  const artifacts = run.artifacts as { runJson?: string; transcriptDir?: string } | undefined;
  if (artifacts?.runJson) lines.push(`  run.json: ${artifacts.runJson}`);
  if (artifacts?.transcriptDir) lines.push(`  transcripts: ${artifacts.transcriptDir}`);
  return lines.join("\n");
}

function formatRunTable(runs: WorkflowRun[]): string {
  const rows = runs.map((run) => {
    const display = projectWorkflowDisplay(run, []);
    return {
      runId: display.runId,
      status: display.status,
      name: display.title,
      progress: display.summary,
      actions: enabledActionIds(display.actions).join(", ") || "none",
    };
  });
  const widths = {
    runId: Math.max("RUN ID".length, ...rows.map((row) => row.runId.length)),
    status: Math.max("STATUS".length, ...rows.map((row) => row.status.length)),
    name: Math.max("NAME".length, ...rows.map((row) => row.name.length)),
    progress: Math.max("PROGRESS".length, ...rows.map((row) => row.progress.length)),
  };
  const header = [
    "RUN ID".padEnd(widths.runId),
    "STATUS".padEnd(widths.status),
    "NAME".padEnd(widths.name),
    "PROGRESS".padEnd(widths.progress),
    "ACTIONS",
  ].join("  ");
  const body = rows.map((row) => [
    row.runId.padEnd(widths.runId),
    row.status.padEnd(widths.status),
    row.name.padEnd(widths.name),
    row.progress.padEnd(widths.progress),
    row.actions,
  ].join("  "));
  return [header, ...body].join("\n");
}

function formatUltracode(result: UltracodeResult): string {
  const display = projectUltracodeDisplay(result);
  const lines = [
    `${display.title} ${display.status}`,
    `  summary: ${display.summary}`,
    `  actions: ${display.actions.filter((action) => action.enabled).map((action) => action.id).join(", ") || "none"}`,
    `  config: ${display.path}`,
  ];
  if (display.warnings.length > 0) lines.push(`  warnings: ${display.warnings.join("; ")}`);
  return lines.join("\n");
}

function enabledActionIds(actions: Array<{ id: string; enabled: boolean }>): string[] {
  return actions.filter((action) => action.enabled).map((action) => action.id);
}

export function formatEventLine(event: Record<string, unknown>): string {
  const head = [event.index !== undefined ? `#${event.index}` : undefined, event.type]
    .filter(Boolean)
    .join(" ");
  const details = [
    typeof event.title === "string" ? event.title : undefined,
    typeof event.kind === "string" ? `kind=${event.kind}` : undefined,
    typeof event.group === "string" ? `phase=${event.group}` : undefined,
    typeof event.label === "string" ? `label=${event.label}` : undefined,
    typeof event.agentType === "string" ? `agent=${event.agentType}` : undefined,
    modelDetail(event),
    typeof event.message === "string" ? event.message : undefined,
    typeof event.error === "string" ? `error=${event.error}` : undefined,
    typeof event.prompt === "string" ? `prompt=${summarize(event.prompt)}` : undefined,
    event.result !== undefined ? `result=${summarize(event.result)}` : undefined,
    typeof event.tokens === "number" ? `tokens=${event.tokens}` : undefined,
    typeof event.transcriptPath === "string" ? `transcript=${event.transcriptPath}` : undefined,
  ].filter(Boolean);
  return details.length > 0 ? `${head} ${details.join(" | ")}` : head;
}

const LOGICAL_MODEL_TIERS = new Set(["fable", "opus", "sonnet", "haiku"]);

function modelDetail(event: Record<string, unknown>): string | undefined {
  if (typeof event.model !== "string" || !event.model) return undefined;
  const key = LOGICAL_MODEL_TIERS.has(event.model.toLowerCase()) ? "tier" : "model";
  if (typeof event.requestedModel === "string" && event.requestedModel && event.requestedModel !== event.model) {
    return `${key}=${event.model} requested=${event.requestedModel}`;
  }
  return `${key}=${event.model}`;
}

function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function formatProgress(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const done = value.agentDone;
  const total = value.agentTotal;
  if (typeof done !== "number" || typeof total !== "number") return undefined;
  const parts = [`${done}/${total} agents done`];
  if (typeof value.agentRunning === "number" && value.agentRunning > 0) parts.push(`${value.agentRunning} running`);
  if (typeof value.agentFailed === "number" && value.agentFailed > 0) parts.push(`${value.agentFailed} failed`);
  if (typeof value.tokenTotal === "number" && value.tokenTotal > 0) parts.push(`${value.tokenTotal} tokens`);
  return parts.join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRunRecord(value: unknown): value is WorkflowRun {
  return isRecord(value) && typeof value.runId === "string" && typeof value.name === "string" && typeof value.status === "string";
}

function isUltracodeResult(value: unknown): value is UltracodeResult {
  return isRecord(value) &&
    typeof value.ultracode === "boolean" &&
    typeof value.standingOptIn === "boolean" &&
    typeof value.keywordTriggerEnabled === "boolean" &&
    isRecord(value.effort) &&
    typeof value.path === "string";
}
