export type CodexContextInclusionReason =
  | "always"
  | "current-mention"
  | "explicit-pin"
  | "active-scope"
  | "active-tab"
  | "child"
  | "relation"
  | "detail-reference"
  | "map-reference";

export type CodexContextExposure = "excluded" | "identity-only" | "content";

const CONTEXT_MODE_TRIGGER_MATRIX = {
  hidden: [],
  suppress: ["explicit-pin", "active-scope"],
  mentioned: ["explicit-pin", "current-mention", "active-scope", "active-tab"],
  always: [
    "always",
    "current-mention",
    "explicit-pin",
    "active-scope",
    "active-tab",
    "child",
    "relation",
    "detail-reference",
    "map-reference",
  ],
} as const satisfies Record<string, readonly CodexContextInclusionReason[]>;

const MENTIONED_IDENTITY_ONLY_TRIGGERS = new Set<CodexContextInclusionReason>([
  "child",
  "relation",
  "detail-reference",
  "map-reference",
]);

export function resolveCodexContextExposure(
  contextMode: string,
  reason: CodexContextInclusionReason,
): CodexContextExposure {
  if (
    !Object.prototype.hasOwnProperty.call(
      CONTEXT_MODE_TRIGGER_MATRIX,
      contextMode,
    )
  ) {
    return "excluded";
  }
  const allowed = CONTEXT_MODE_TRIGGER_MATRIX[
    contextMode as keyof typeof CONTEXT_MODE_TRIGGER_MATRIX
  ] as readonly CodexContextInclusionReason[];
  if (allowed.includes(reason)) return "content";
  if (
    contextMode === "mentioned" &&
    MENTIONED_IDENTITY_ONLY_TRIGGERS.has(reason)
  ) {
    return "identity-only";
  }
  return "excluded";
}

/**
 * Shared fail-closed AI exposure policy for a Phase-resolved context mode.
 * Authority and selection trigger are deliberately separate. A `mentioned`
 * entry needs a direct current-turn trigger; merely being a child, relation, or
 * detail reference cannot disclose its body. `suppress` remains available for
 * an explicit pin or a user-selected Codex scope. Unknown persisted modes fail
 * closed, as does `hidden` for every trigger.
 */
export function canIncludeResolvedCodexContext(
  contextMode: string,
  reason: CodexContextInclusionReason,
): boolean {
  return resolveCodexContextExposure(contextMode, reason) === "content";
}

export function canExposeResolvedCodexIdentity(
  contextMode: string,
  reason: CodexContextInclusionReason,
): boolean {
  return resolveCodexContextExposure(contextMode, reason) !== "excluded";
}
