# Workspace policy adapter checklist

Workspace policy owns the contract and decision. Adapters must not copy policy
state or reproduce denial logic.

For each affected server-side operation:

1. Resolve the authenticated dx `UserId` before the operation has side effects.
2. Call `WorkspacePolicyService.evaluateForUser(userId, action)` with one of the
   typed `WorkspacePolicyAction` variants from `@dx/domain`.
3. Preserve `WorkspacePolicyDenied` as a typed HTTP/protocol denial, including
   its reason. Fail closed for persistence or schema failures.
4. Evaluate on every admission or mutation. Do not cache the decision in an
   adapter or treat a resource snapshot as continuing authorization.
5. Add an adapter-level test proving both allowed and denied behavior.

Consumers that are not present on this downstream base should integrate these
actions when their sibling branches converge:

- External share create/use: `thread.share-externally` (#34).
- Personal provider resolution: `provider.use-personal-override` (#34).
- Personal MCP mutation, resolution, and tool admission:
  `mcp.use-personal-override` (#36).
- Execution remote-control admission: `execution.remote-control`.
- Future Thread visibility mutation: `thread.set-visibility`.

Current adapters already wired on this branch are Thread creation, native agent
admission, runner execution admission, project creation/default selection, and
personal/project secret mutation and execution resolution.
