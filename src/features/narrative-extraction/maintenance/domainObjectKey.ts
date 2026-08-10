/**
 * Identifies one persisted domain object that participates in the Narrative
 * Maintenance change feed (change events, dependency edges, and proposals
 * all reference objects through this key rather than ad-hoc id fields).
 */
export type DomainObjectKey =
  | { readonly kind: "scene"; readonly sceneId: string }
  | { readonly kind: "chronicle-event"; readonly eventId: string }
  | { readonly kind: "codex-entry"; readonly entryId: string }
  | { readonly kind: "codex-relation"; readonly relationId: string }
  | { readonly kind: "codex-phase"; readonly phaseId: string }
  | { readonly kind: "plot-thread"; readonly threadId: string }
  | { readonly kind: "foreshadow"; readonly foreshadowId: string }
  | { readonly kind: "calendar"; readonly calendarRef: string }
  | {
      readonly kind: "import-source";
      readonly sourceSetId: string;
      readonly objectKey?: string;
    }
  | { readonly kind: "component"; readonly componentId: string };

export type DomainObjectKeyKind = DomainObjectKey["kind"];

/**
 * Stable string form of a `DomainObjectKey`, safe to use as a Map/Set key or
 * as a coalescing key when folding change events for the same object.
 */
export function domainObjectKeyToString(key: DomainObjectKey): string {
  switch (key.kind) {
    case "scene":
      return `scene:${key.sceneId}`;
    case "chronicle-event":
      return `chronicle-event:${key.eventId}`;
    case "codex-entry":
      return `codex-entry:${key.entryId}`;
    case "codex-relation":
      return `codex-relation:${key.relationId}`;
    case "codex-phase":
      return `codex-phase:${key.phaseId}`;
    case "plot-thread":
      return `plot-thread:${key.threadId}`;
    case "foreshadow":
      return `foreshadow:${key.foreshadowId}`;
    case "calendar":
      return `calendar:${key.calendarRef}`;
    case "import-source":
      return `import-source:${key.sourceSetId}${
        key.objectKey ? `:${key.objectKey}` : ""
      }`;
    case "component":
      return `component:${key.componentId}`;
  }
}

export function domainObjectKeysEqual(
  a: DomainObjectKey,
  b: DomainObjectKey,
): boolean {
  return domainObjectKeyToString(a) === domainObjectKeyToString(b);
}
