export type WorkflowLimits = {
  maxConcurrentAgents?: number;
  maxAgentsPerRun?: number;
};

export type ResolvedWorkflowLimits = {
  maxConcurrentAgents: number;
  maxAgentsPerRun: number;
};

const DEFAULT_WORKFLOW_LIMITS: ResolvedWorkflowLimits = {
  maxConcurrentAgents: 16,
  maxAgentsPerRun: 1000,
};

export function resolveWorkflowLimits(limits: WorkflowLimits | undefined): ResolvedWorkflowLimits {
  return {
    maxConcurrentAgents: positiveInteger(limits?.maxConcurrentAgents, DEFAULT_WORKFLOW_LIMITS.maxConcurrentAgents),
    maxAgentsPerRun: positiveInteger(limits?.maxAgentsPerRun, DEFAULT_WORKFLOW_LIMITS.maxAgentsPerRun),
  };
}

export function createAgentExecutionGate(limits: WorkflowLimits | undefined) {
  const resolved = resolveWorkflowLimits(limits);
  const waiters: Array<() => void> = [];
  let activeAgents = 0;
  let agentCalls = 0;

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      agentCalls += 1;
      if (agentCalls > resolved.maxAgentsPerRun) {
        throw new Error(`Workflow agent limit exceeded: ${resolved.maxAgentsPerRun}`);
      }

      await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };

  function acquire(): Promise<void> {
    if (activeAgents < resolved.maxConcurrentAgents) {
      activeAgents += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      waiters.push(() => {
        activeAgents += 1;
        resolve();
      });
    });
  }

  function release(): void {
    activeAgents -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}
