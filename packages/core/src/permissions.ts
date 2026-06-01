export type PermissionPolicy = {
  authorizeDynamicWorkflow: (request: { name: string }) => Promise<PermissionDecision> | PermissionDecision;
};

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

// Claude's permission surface. `dontAsk` is a deny-dynamic alias kept for
// backwards compatibility.
export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

export const denyDynamicWorkflowPolicy: PermissionPolicy = {
  authorizeDynamicWorkflow: () => ({
    allowed: false,
    reason: "Dynamic workflow execution denied by permission policy",
  }),
};

export const allowDynamicWorkflowPolicy: PermissionPolicy = {
  authorizeDynamicWorkflow: () => ({ allowed: true }),
};

// Resolve a permission mode to a concrete policy. `bypassPermissions` and the
// permissive modes return undefined (no policy → allow); `plan`/`dontAsk` deny
// dynamic execution (fail closed).
export function permissionPolicyForMode(mode: PermissionMode): PermissionPolicy | undefined {
  switch (mode) {
    case "bypassPermissions":
    case "acceptEdits":
    case "default":
      return undefined;
    case "plan":
    case "dontAsk":
      return denyDynamicWorkflowPolicy;
  }
  return assertNeverPermissionMode(mode);
}

function assertNeverPermissionMode(mode: never): never {
  throw new Error(`Unhandled permission mode: ${String(mode)}`);
}
