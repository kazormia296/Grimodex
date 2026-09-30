/**
 * Identifies one persisted domain object that participates in the Narrative
 * Maintenance change feed (change events, dependency edges, and proposals
 * all reference objects through this key rather than ad-hoc id fields).
 */
export type DomainObjectKey =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "scene"; readonly sceneId: string }
  | { readonly kind: "chronicle-event"; readonly eventId: string }
  | { readonly kind: "codex-entry"; readonly entryId: string }
  | { readonly kind: "codex-relation"; readonly relationId: string }
  | { readonly kind: "codex-phase"; readonly phaseId: string }
  | {
      readonly kind: "codex-detail-definition";
      readonly definitionId: string;
    }
  | { readonly kind: "codex-detail-value"; readonly valueId: string }
  | { readonly kind: "plot-thread"; readonly threadId: string }
  | { readonly kind: "plot-marker"; readonly markerId: string }
  | { readonly kind: "plot-branch"; readonly branchId: string }
  | { readonly kind: "foreshadow"; readonly foreshadowId: string }
  | { readonly kind: "foreshadow-setup"; readonly setupId: string }
  | { readonly kind: "foreshadow-payoff"; readonly payoffId: string }
  | { readonly kind: "temporal-node"; readonly nodeId: string }
  | { readonly kind: "temporal-constraint"; readonly constraintId: string }
  | { readonly kind: "temporal-projection"; readonly projectionId: string }
  | { readonly kind: "calendar"; readonly calendarRef: string }
  | {
      readonly kind: "import-source";
      readonly sourceSetId: string;
      readonly objectKey?: string;
    }
  | { readonly kind: "component"; readonly componentId: string };

export type DomainObjectKeyKind = DomainObjectKey["kind"];

function requireIdentity(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
}

export function assertValidDomainObjectKey(key: DomainObjectKey): void {
  switch (key.kind) {
    case "project":
      return requireIdentity(key.projectId, "projectId");
    case "scene":
      return requireIdentity(key.sceneId, "sceneId");
    case "chronicle-event":
      return requireIdentity(key.eventId, "eventId");
    case "codex-entry":
      return requireIdentity(key.entryId, "entryId");
    case "codex-relation":
      return requireIdentity(key.relationId, "relationId");
    case "codex-phase":
      return requireIdentity(key.phaseId, "phaseId");
    case "codex-detail-definition":
      return requireIdentity(key.definitionId, "definitionId");
    case "codex-detail-value":
      return requireIdentity(key.valueId, "valueId");
    case "plot-thread":
      return requireIdentity(key.threadId, "threadId");
    case "plot-marker":
      return requireIdentity(key.markerId, "markerId");
    case "plot-branch":
      return requireIdentity(key.branchId, "branchId");
    case "foreshadow":
      return requireIdentity(key.foreshadowId, "foreshadowId");
    case "foreshadow-setup":
      return requireIdentity(key.setupId, "setupId");
    case "foreshadow-payoff":
      return requireIdentity(key.payoffId, "payoffId");
    case "temporal-node":
      return requireIdentity(key.nodeId, "nodeId");
    case "temporal-constraint":
      return requireIdentity(key.constraintId, "constraintId");
    case "temporal-projection":
      return requireIdentity(key.projectionId, "projectionId");
    case "calendar":
      return requireIdentity(key.calendarRef, "calendarRef");
    case "import-source":
      requireIdentity(key.sourceSetId, "sourceSetId");
      if (key.objectKey !== undefined) {
        requireIdentity(key.objectKey, "objectKey");
      }
      return;
    case "component":
      return requireIdentity(key.componentId, "componentId");
    default:
      throw new TypeError("unsupported DomainObjectKey kind");
  }
}

/**
 * Stable, collision-safe string form of a `DomainObjectKey`.
 *
 * A tagged JSON tuple is deliberate here. Delimiter concatenation makes
 * values such as `["a:b", null]` and `["a", "b"]` indistinguishable and can
 * incorrectly coalesce changes for different objects.
 */
export function domainObjectKeyToString(key: DomainObjectKey): string {
  assertValidDomainObjectKey(key);
  switch (key.kind) {
    case "project":
      return JSON.stringify([key.kind, key.projectId]);
    case "scene":
      return JSON.stringify([key.kind, key.sceneId]);
    case "chronicle-event":
      return JSON.stringify([key.kind, key.eventId]);
    case "codex-entry":
      return JSON.stringify([key.kind, key.entryId]);
    case "codex-relation":
      return JSON.stringify([key.kind, key.relationId]);
    case "codex-phase":
      return JSON.stringify([key.kind, key.phaseId]);
    case "codex-detail-definition":
      return JSON.stringify([key.kind, key.definitionId]);
    case "codex-detail-value":
      return JSON.stringify([key.kind, key.valueId]);
    case "plot-thread":
      return JSON.stringify([key.kind, key.threadId]);
    case "plot-marker":
      return JSON.stringify([key.kind, key.markerId]);
    case "plot-branch":
      return JSON.stringify([key.kind, key.branchId]);
    case "foreshadow":
      return JSON.stringify([key.kind, key.foreshadowId]);
    case "foreshadow-setup":
      return JSON.stringify([key.kind, key.setupId]);
    case "foreshadow-payoff":
      return JSON.stringify([key.kind, key.payoffId]);
    case "temporal-node":
      return JSON.stringify([key.kind, key.nodeId]);
    case "temporal-constraint":
      return JSON.stringify([key.kind, key.constraintId]);
    case "temporal-projection":
      return JSON.stringify([key.kind, key.projectionId]);
    case "calendar":
      return JSON.stringify([key.kind, key.calendarRef]);
    case "import-source":
      return JSON.stringify([key.kind, key.sourceSetId, key.objectKey ?? null]);
    case "component":
      return JSON.stringify([key.kind, key.componentId]);
  }
}

export function domainObjectKeysEqual(
  a: DomainObjectKey,
  b: DomainObjectKey,
): boolean {
  return domainObjectKeyToString(a) === domainObjectKeyToString(b);
}
