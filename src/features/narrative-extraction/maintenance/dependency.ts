import type { Sha256Digest } from "./changeEvent";
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

export type NarrativeDependencyConsumer =
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
    }
  | {
      readonly kind: "narrative-node";
      readonly artifactId: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: "proposal-revision";
      readonly proposalId: string;
      readonly revisionId: string | null;
    }
  | {
      readonly kind: "application-contribution";
      readonly contributionId: string;
    }
  | {
      readonly kind: "derived-projection";
      readonly projectionId: string;
    };

export type NarrativeDependencySource =
  | {
      readonly kind: "domain-object";
      readonly objectKey: string;
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
  | {
      readonly kind: "calendar";
      readonly calendarRef: string;
    }
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
  readonly createdByArtifactId: string | null;
  readonly digest: Sha256Digest;
}

export function dependencyConsumerId(
  consumer: NarrativeDependencyConsumer,
): string {
  switch (consumer.kind) {
    case "artifact":
      return `artifact:${consumer.artifactId}`;
    case "narrative-node":
      return `node:${consumer.artifactId}:${consumer.nodeId}`;
    case "proposal-revision":
      return `proposal:${consumer.proposalId}:${consumer.revisionId ?? ""}`;
    case "application-contribution":
      return `contribution:${consumer.contributionId}`;
    case "derived-projection":
      return `projection:${consumer.projectionId}`;
  }
}

export function dependencySourceKey(
  source: NarrativeDependencySource,
): string {
  switch (source.kind) {
    case "domain-object":
      return `domain:${source.objectKey}`;
    case "document-range":
      return `doc:${source.documentSourceKey}:${source.range.from}-${source.range.to}`;
    case "coverage":
      return `coverage:${source.coverageKey}`;
    case "calendar":
      return `calendar:${source.calendarRef}`;
    case "component":
      return `component:${source.componentId}@${source.version}`;
    case "source-package":
      return `source:${source.sourceSetId}:${source.objectKey ?? ""}`;
  }
}
