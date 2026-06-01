// Agent execution gate — observability only. Agent Workflow Kit does NOT impose
// concurrency, lifetime-count, or any other cap: the host harness applies its
// own limits, and duplicating them here would fight the harness. The gate runs
// each operation immediately (no throttle, no ceiling) and only counts calls so
// workflows and events can observe how many agents ran.
export type AgentExecutionGate = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  count(): number;
};

export function createAgentExecutionGate(): AgentExecutionGate {
  let agentCalls = 0;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      agentCalls += 1;
      return operation();
    },
    count: () => agentCalls,
  };
}
