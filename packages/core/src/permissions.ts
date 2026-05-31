export type PermissionPolicy = {
  authorizeDynamicWorkflow: (request: { name: string }) => Promise<PermissionDecision> | PermissionDecision;
};

export type PermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export const denyDynamicWorkflowPolicy: PermissionPolicy = {
  authorizeDynamicWorkflow: () => ({
    allowed: false,
    reason: "Dynamic workflow execution denied by permission policy",
  }),
};
