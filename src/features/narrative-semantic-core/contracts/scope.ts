export const NARRATIVE_SCOPE_STATUSES = ["explicit", "unresolved"] as const;
export type NarrativeScopeStatus = (typeof NARRATIVE_SCOPE_STATUSES)[number];

export interface NarrativeScope {
  readonly scopeStatus: NarrativeScopeStatus;
  readonly timelineRef?: string;
  readonly worldlineRef?: string;
  readonly sceneRef?: string;
  readonly validFromRef?: string;
  readonly validUntilRef?: string;
  readonly viewpointRef?: string;
  readonly knowledgeHolderRef?: string;
  readonly audienceRef?: "reader" | string;
  readonly narrativeLayer?: string;
}

export type NarrativeScopeFailureReason =
  | "invalid-scope-status"
  | "explicit-scope-axis-required"
  | "scope-axis-must-be-non-empty";

export type NarrativeScopeValidationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: NarrativeScopeFailureReason };

const SCOPE_AXES: readonly (keyof NarrativeScope)[] = [
  "timelineRef",
  "worldlineRef",
  "sceneRef",
  "validFromRef",
  "validUntilRef",
  "viewpointRef",
  "knowledgeHolderRef",
  "audienceRef",
  "narrativeLayer",
];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateNarrativeScope(
  scope: Partial<NarrativeScope> | null | undefined,
): NarrativeScopeValidationResult {
  if (
    !scope ||
    !NARRATIVE_SCOPE_STATUSES.includes(
      scope.scopeStatus as NarrativeScopeStatus,
    )
  ) {
    return { valid: false, reason: "invalid-scope-status" };
  }
  for (const axis of SCOPE_AXES) {
    const value = scope[axis];
    if (value !== undefined && !isNonEmptyString(value)) {
      return { valid: false, reason: "scope-axis-must-be-non-empty" };
    }
  }
  if (
    scope.scopeStatus === "explicit" &&
    !SCOPE_AXES.some((axis) => isNonEmptyString(scope[axis]))
  ) {
    return { valid: false, reason: "explicit-scope-axis-required" };
  }
  return { valid: true };
}

export function assertNarrativeScope(scope: NarrativeScope): void {
  const result = validateNarrativeScope(scope);
  if (!result.valid) {
    throw new Error(`Invalid narrative scope: ${result.reason}`);
  }
}

export function canAutoExpandNarrativeScope(
  scope: Pick<NarrativeScope, "scopeStatus">,
): boolean {
  return scope.scopeStatus === "explicit";
}
