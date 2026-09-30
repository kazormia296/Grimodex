import type { Sha256Digest } from "./changeEvent";
import {
  domainObjectKeyToString,
  type DomainObjectKey,
} from "./domainObjectKey";
import type { NarrativeInvalidationPolicy } from "./invalidationPolicy";
import type { Utf16Range } from "./rangeImpact";

export type NarrativeDependencyKind =
  | "evidence-exact"
  | "evidence-context"
  | "source-window"
  | "document-title"
  | "document-reading-order"
  | "document-story-order"
  | "entity-resolution"
  | "type-resolution"
  | "detail-definition"
  | "calendar-resolution"
  | "temporal-graph"
  | "coverage-root"
  | "target-version"
  | "application-output"
  | "normalizer-version"
  | "extractor-version"
  | "prompt-version"
  | "parser-version"
  | "compiler-version"
  | "domain-capability";

/**
 * C0 planning read model. Persistent Application/Proposal authority remains
 * in the existing Gate B tables; this type does not introduce a second
 * application or proposal model.
 */
export type NarrativeDependencyConsumer =
  | { readonly kind: "application"; readonly applicationId: string }
  | { readonly kind: "artifact"; readonly artifactId: string }
  | {
      readonly kind: "artifact-node";
      readonly artifactId: string;
      readonly nodeId: string;
    }
  | { readonly kind: "derived-projection"; readonly projectionId: string };

export type NarrativeDependencySource =
  | {
      readonly kind: "domain-object";
      readonly objectKey: DomainObjectKey;
      readonly fieldPaths: readonly string[];
    }
  | {
      readonly kind: "document-range";
      readonly documentSourceKey: string;
      readonly range: Utf16Range;
    }
  | {
      readonly kind: "coverage";
      readonly coverageKey: string;
      readonly coverageDigest: Sha256Digest;
    }
  | { readonly kind: "calendar"; readonly calendarRef: string }
  | {
      readonly kind: "component";
      readonly componentId: string;
      readonly version: string;
    }
  | {
      readonly kind: "source-package";
      readonly sourceSetId: string;
      readonly objectKey?: string;
    };

export interface NarrativeDependencyExpectedState {
  readonly version?: number;
  readonly digest?: Sha256Digest;
  readonly quoteDigest?: Sha256Digest;
  readonly contextDigest?: Sha256Digest;
  readonly range?: Utf16Range;
}

export interface NarrativeDependencyEdge {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly consumer: NarrativeDependencyConsumer;
  readonly source: NarrativeDependencySource;
  readonly kind: NarrativeDependencyKind;
  readonly expected: NarrativeDependencyExpectedState;
  readonly invalidationPolicy: NarrativeInvalidationPolicy;
  readonly digest: Sha256Digest;
}

export function dependencyConsumerId(
  consumer: NarrativeDependencyConsumer,
): string {
  switch (consumer.kind) {
    case "application":
      return JSON.stringify([consumer.kind, consumer.applicationId]);
    case "artifact":
      return JSON.stringify([consumer.kind, consumer.artifactId]);
    case "artifact-node":
      return JSON.stringify([
        consumer.kind,
        consumer.artifactId,
        consumer.nodeId,
      ]);
    case "derived-projection":
      return JSON.stringify([consumer.kind, consumer.projectionId]);
  }
}

export function dependencySourceKey(source: NarrativeDependencySource): string {
  switch (source.kind) {
    case "domain-object":
      return JSON.stringify([
        source.kind,
        domainObjectKeyToString(source.objectKey),
      ]);
    case "document-range":
      return JSON.stringify([
        source.kind,
        source.documentSourceKey,
        source.range.from,
        source.range.to,
      ]);
    case "coverage":
      return JSON.stringify([source.kind, source.coverageKey]);
    case "calendar":
      return JSON.stringify([source.kind, source.calendarRef]);
    case "component":
      return JSON.stringify([source.kind, source.componentId, source.version]);
    case "source-package":
      return JSON.stringify([
        source.kind,
        source.sourceSetId,
        source.objectKey ?? null,
      ]);
  }
}
