// Agent execution gate. By default it is observability only: no concurrency,
// lifetime-count, or other cap is imposed because the host harness owns its own
// real limits. Callers may opt into local limits for harnesses that do not expose
// native enforcement.
export type AgentExecutionLimits = {
  maxAgentCalls?: number | undefined;
  maxConcurrentAgents?: number | undefined;
  maxChildWorkflowDepth?: number | undefined;
  maxEstimatedTokens?: number | undefined;
  stopOnEstimatedTokenLimit?: boolean | undefined;
};

export type AgentExecutionGate = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  count(): number;
};

export class AgentExecutionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutionLimitError";
  }
}

export function createAgentExecutionGate(limits: AgentExecutionLimits = {}): AgentExecutionGate {
  let agentCalls = 0;
  let activeAgents = 0;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const nextCount = agentCalls + 1;
      if (limits.maxAgentCalls !== undefined && nextCount > limits.maxAgentCalls) {
        throw new AgentExecutionLimitError(`Agent call limit exceeded: maxAgentCalls=${limits.maxAgentCalls}`);
      }
      if (limits.maxConcurrentAgents !== undefined && activeAgents >= limits.maxConcurrentAgents) {
        throw new AgentExecutionLimitError(`Agent concurrency limit exceeded: maxConcurrentAgents=${limits.maxConcurrentAgents}`);
      }

      agentCalls = nextCount;
      activeAgents += 1;
      try {
        return await operation();
      } finally {
        activeAgents -= 1;
      }
    },
    count: () => agentCalls,
  };
}
