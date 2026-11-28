import type { AnalysisReadBasisEntryV1 } from "../shared/agentRunTypes.js";

/** Main-owned list; renderer tool classifications never authorize this set. */
export const AGENT_APPROVAL_PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  "create_codex_entry",
  "update_codex_entry",
  "create_foreshadow",
  "update_foreshadow",
  "create_snippet",
  "create_event",
  "update_event",
  "delete_event",
  "stamp_scene_event",
  "unstamp_scene_event",
  "set_event_participants",
  "add_event_relation",
  "remove_event_relation",
  "apply_ai_tree_plan",
]);

export const AGENT_APPROVAL_VERSIONED_TOOLS: ReadonlySet<string> = new Set([
  "update_codex_entry",
  "update_foreshadow",
  "update_event",
  "delete_event",
  "set_event_participants",
  "apply_ai_tree_plan",
]);

export type AgentApprovalExpected =
  | {
      readonly kind: "scene_event_link";
      readonly linkIncarnation: string | null;
      readonly eventVersion: number;
    }
  | {
      readonly kind: "event_relation";
      readonly related: boolean;
      readonly causeVersion: number;
      readonly effectVersion: number;
    };

export interface AgentApprovalObservation {
  readonly basis: readonly AnalysisReadBasisEntryV1[] | null;
  readonly baseVersions:
    | readonly { readonly id: string; readonly version: number }[]
    | null;
  readonly expected: AgentApprovalExpected | null;
}

/** Version state frozen into an approval-exchange capability for Native. */
export interface AgentApprovalApprovedTarget {
  readonly baseVersions:
    | readonly { readonly id: string; readonly version: number }[]
    | null;
  readonly expected: AgentApprovalExpected | null;
}

/** apply_ai_tree_plan の版の要否。作成だけなら不要、形の分からない plan は null（拒む）。 */
export function agentTreePlanRequiresVersion(ops: unknown): boolean | null {
  if (!Array.isArray(ops) || ops.length === 0) return null;
  for (const op of ops) {
    if (
      op === null ||
      typeof op !== "object" ||
      Array.isArray(op) ||
      !("op" in op) ||
      (op.op !== "create" && op.op !== "move" && op.op !== "rename") ||
      ((op.op === "move" || op.op === "rename") &&
        (!("nodeId" in op) ||
          typeof op.nodeId !== "string" ||
          op.nodeId.length === 0))
    ) {
      return null;
    }
  }
  return ops.some((op) => op.op !== "create");
}
