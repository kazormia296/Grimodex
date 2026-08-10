import {
  verifyExtractionCalendarSnapshot,
  type ExtractionCalendarSnapshot,
} from "@/features/chronicle/calendar/extractionCalendarSnapshot";
import { digestStableJson, hasLoneSurrogate } from "../source/digest";
import { freezeDeep } from "../source/immutability";
import type { Sha256Digest } from "../source/types";
import {
  validateTemporalConstraint,
  type AbsoluteTemporalLiteral,
  type TemporalConstraint,
} from "./constraints";
import {
  isSemanticFingerprint,
  isTemporalNodeId,
  temporalSubjectKey,
  type DocumentRef,
  type TemporalNode,
} from "./nodes";
import {
  isTemporalTimelineRef,
  temporalTimelineKey,
  type TemporalTimelineRef,
} from "./timeline";

export interface TemporalDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ExtractionCoverageManifest {
  readonly status: "complete" | "partial";
  readonly documentRefs: readonly DocumentRef[];
  readonly omittedDocumentRefs: readonly DocumentRef[];
}

export interface TemporalConstraintGraph {
  readonly schemaVersion: 1;
  readonly graphVersion: "gdx-temporal-graph/1";
  readonly timeline: TemporalTimelineRef;
  readonly nodes: readonly TemporalNode[];
  readonly constraints: readonly TemporalConstraint[];
  readonly calendar: ExtractionCalendarSnapshot | null;
  readonly coverage: ExtractionCoverageManifest;
  readonly diagnostics: readonly TemporalDiagnostic[];
  readonly digest: Sha256Digest;
}

export interface TemporalConstraintGraphBuildInput {
  readonly timeline: TemporalTimelineRef;
  readonly nodes: readonly TemporalNode[];
  readonly constraints: readonly TemporalConstraint[];
  readonly calendar: ExtractionCalendarSnapshot | null;
  readonly coverage: ExtractionCoverageManifest;
  readonly diagnostics: readonly TemporalDiagnostic[];
}

export type TemporalConstraintGraphBuildResult =
  | { readonly ok: true; readonly graph: TemporalConstraintGraph }
  | { readonly ok: false; readonly diagnostics: readonly TemporalDiagnostic[] };

function diagnostic(
  code: string,
  message: string,
  path?: string,
): TemporalDiagnostic {
  return { code, message, ...(path ? { path } : {}) };
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasLoneSurrogate(value) &&
    !/\p{Cc}/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSuppliedDiagnostics(
  value: unknown,
): value is TemporalDiagnostic[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        validIdentity(item.code) &&
        validIdentity(item.message) &&
        (item.path === undefined || validIdentity(item.path)),
    )
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function cloneBeforeAwait(
  input: TemporalConstraintGraphBuildInput,
): TemporalConstraintGraphBuildInput {
  const copied = structuredClone(input) as unknown;
  if (!isRecord(copied)) {
    throw new TypeError("Temporal graph input must be an object");
  }
  return copied as unknown as TemporalConstraintGraphBuildInput;
}

function validateSubject(
  node: TemporalNode,
  path: string,
): TemporalDiagnostic[] {
  const subject = node.subject;
  switch (subject?.kind) {
    case "scene":
      if (
        !validIdentity(subject.documentRef) ||
        (subject.segmentRef !== undefined && !validIdentity(subject.segmentRef))
      ) {
        return [
          diagnostic(
            "TEMPORAL_GRAPH_INVALID_SUBJECT",
            "Temporal Scene subject is invalid",
            path,
          ),
        ];
      }
      return [];
    case "event":
      return validIdentity(subject.eventId)
        ? []
        : [
            diagnostic(
              "TEMPORAL_GRAPH_INVALID_SUBJECT",
              "Temporal Event subject is invalid",
              path,
            ),
          ];
    case "state-boundary":
    case "phase-boundary":
      return validIdentity(subject.inferenceId)
        ? []
        : [
            diagnostic(
              "TEMPORAL_GRAPH_INVALID_SUBJECT",
              "Temporal boundary subject is invalid",
              path,
            ),
          ];
    case "named-period":
      return validIdentity(subject.label)
        ? []
        : [
            diagnostic(
              "TEMPORAL_GRAPH_INVALID_SUBJECT",
              "Temporal named period is invalid",
              path,
            ),
          ];
    default:
      return [
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_SUBJECT",
          "Temporal node subject kind is invalid",
          path,
        ),
      ];
  }
}

function validateNodes(
  timeline: TemporalTimelineRef,
  nodes: readonly TemporalNode[],
): TemporalDiagnostic[] {
  const diagnostics: TemporalDiagnostic[] = [];
  const ids = new Set<string>();
  const subjects = new Set<string>();
  const expectedTimelineKey = temporalTimelineKey(timeline);
  for (const [index, node] of nodes.entries()) {
    const path = `nodes[${index}]`;
    if (!isRecord(node)) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_NODE",
          "Temporal graph node must be an object",
          path,
        ),
      );
      continue;
    }
    if (!isTemporalNodeId(node?.id)) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_NODE_ID",
          "Temporal node id is invalid",
          `${path}.id`,
        ),
      );
    } else if (ids.has(node.id)) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_DUPLICATE_NODE_ID",
          `Duplicate temporal node id: ${node.id}`,
          `${path}.id`,
        ),
      );
    } else {
      ids.add(node.id);
    }
    if (
      !isTemporalTimelineRef(node?.timeline) ||
      temporalTimelineKey(node.timeline) !== expectedTimelineKey
    ) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_TIMELINE_MISMATCH",
          "Temporal node is on another timeline",
          `${path}.timeline`,
        ),
      );
    }
    diagnostics.push(...validateSubject(node, `${path}.subject`));
    if (node?.subject) {
      const subjectKey = temporalSubjectKey(node.subject);
      if (subjects.has(subjectKey)) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_GRAPH_DUPLICATE_SUBJECT",
            "Temporal node subject is duplicated",
            `${path}.subject`,
          ),
        );
      }
      subjects.add(subjectKey);
    }
    if (
      node?.shape !== "point" &&
      node?.shape !== "interval" &&
      node?.shape !== "unknown"
    ) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_SHAPE",
          "Temporal node shape is invalid",
          `${path}.shape`,
        ),
      );
    }
    if (!isSemanticFingerprint(node?.fingerprint)) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_FINGERPRINT",
          "Temporal node fingerprint is not a SHA-256 digest",
          `${path}.fingerprint`,
        ),
      );
    }
    if (!Array.isArray(node?.discoursePositions)) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_DISCOURSE_POSITION",
          "Temporal node discourse positions must be an array",
          `${path}.discoursePositions`,
        ),
      );
      continue;
    }
    for (const [positionIndex, position] of node.discoursePositions.entries()) {
      if (
        !validIdentity(position?.documentRef) ||
        !Number.isSafeInteger(position?.documentOrderIndex) ||
        position.documentOrderIndex < 0 ||
        !Number.isSafeInteger(position?.canonicalOffset) ||
        position.canonicalOffset < 0
      ) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_GRAPH_INVALID_DISCOURSE_POSITION",
            "Temporal discourse position is invalid",
            `${path}.discoursePositions[${positionIndex}]`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

function validateCoverage(
  coverage: ExtractionCoverageManifest,
  nodes: readonly TemporalNode[],
): TemporalDiagnostic[] {
  if (
    (coverage?.status !== "complete" && coverage?.status !== "partial") ||
    !Array.isArray(coverage?.documentRefs) ||
    coverage.documentRefs.some((ref) => !validIdentity(ref)) ||
    !Array.isArray(coverage?.omittedDocumentRefs) ||
    coverage.omittedDocumentRefs.some((ref) => !validIdentity(ref))
  ) {
    return [
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_COVERAGE",
        "Temporal graph coverage manifest is invalid",
        "coverage",
      ),
    ];
  }
  const documentRefs = new Set(coverage.documentRefs);
  const omittedDocumentRefs = new Set(coverage.omittedDocumentRefs);
  if (
    documentRefs.size !== coverage.documentRefs.length ||
    omittedDocumentRefs.size !== coverage.omittedDocumentRefs.length
  ) {
    return [
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_COVERAGE",
        "Temporal graph coverage cannot contain duplicate document refs",
        "coverage",
      ),
    ];
  }
  if (
    coverage.documentRefs.some((documentRef) =>
      omittedDocumentRefs.has(documentRef),
    )
  ) {
    return [
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_COVERAGE",
        "Included and omitted temporal coverage sets must be disjoint",
        "coverage",
      ),
    ];
  }
  if (
    coverage.status === "complete" &&
    coverage.omittedDocumentRefs.length > 0
  ) {
    return [
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_COVERAGE",
        "Complete temporal coverage cannot contain omissions",
        "coverage.omittedDocumentRefs",
      ),
    ];
  }
  if (
    coverage.status === "partial" &&
    coverage.omittedDocumentRefs.length === 0
  ) {
    return [
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_COVERAGE",
        "Partial temporal coverage must identify at least one omitted document",
        "coverage.omittedDocumentRefs",
      ),
    ];
  }
  const diagnostics: TemporalDiagnostic[] = [];
  const validateDocumentRef = (documentRef: unknown, path: string): void => {
    if (
      validIdentity(documentRef) &&
      (!documentRefs.has(documentRef) || omittedDocumentRefs.has(documentRef))
    ) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_COVERAGE_MISMATCH",
          `Temporal node document is not included in extraction coverage: ${documentRef}`,
          path,
        ),
      );
    }
  };
  for (const [nodeIndex, node] of nodes.entries()) {
    if (!isRecord(node)) continue;
    if (!Array.isArray(node.discoursePositions)) continue;
    for (const [positionIndex, position] of node.discoursePositions.entries()) {
      if (!isRecord(position)) continue;
      validateDocumentRef(
        position.documentRef,
        `nodes[${nodeIndex}].discoursePositions[${positionIndex}].documentRef`,
      );
    }
  }
  return diagnostics;
}

function validateCalendarBindings(
  constraints: readonly TemporalConstraint[],
  calendar: ExtractionCalendarSnapshot | null,
): TemporalDiagnostic[] {
  const diagnostics: TemporalDiagnostic[] = [];
  for (const [index, constraint] of constraints.entries()) {
    if (constraint.kind !== "absolute-window") continue;
    const resolved = constraint.resolved;
    if (resolved !== null && isRecord(resolved)) {
      if (
        calendar === null ||
        resolved.calendarRef !== calendar.calendarRef ||
        resolved.calendarDigest !== calendar.digest
      ) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_GRAPH_CALENDAR_DIGEST_MISMATCH",
            "Canonical temporal window does not match the graph calendar",
            `constraints[${index}].resolved.calendarDigest`,
          ),
        );
      }
    }
    if (
      constraint.literal?.calendarRef !== undefined &&
      constraint.literal.calendarRef !== null &&
      (calendar === null ||
        constraint.literal.calendarRef !== calendar.calendarRef)
    ) {
      diagnostics.push(
        diagnostic(
          "TEMPORAL_GRAPH_CALENDAR_REF_MISMATCH",
          "Absolute literal does not match the graph calendar",
          `constraints[${index}].literal.calendarRef`,
        ),
      );
    }
    const literal = constraint.literal;
    if (!isRecord(literal)) continue;
    for (const [key, catalog] of [
      ["eraRef", calendar?.eras],
      ["monthRef", calendar?.months],
      ["seasonRef", calendar?.seasons],
    ] as const) {
      const ref = literal[key];
      if (
        typeof ref === "string" &&
        (!Array.isArray(catalog) || !catalog.some((item) => item.ref === ref))
      ) {
        diagnostics.push(
          diagnostic(
            "TEMPORAL_GRAPH_UNKNOWN_CALENDAR_CATALOG_REF",
            `Absolute literal references an unknown Calendar catalog entry: ${ref}`,
            `constraints[${index}].literal.${key}`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

function cloneLiteral(
  literal: AbsoluteTemporalLiteral | null,
): AbsoluteTemporalLiteral | null {
  if (literal === null) return null;
  return {
    kind: "absolute",
    calendarRef: literal.calendarRef,
    ...(literal.eraRef !== undefined ? { eraRef: literal.eraRef } : {}),
    ...(literal.year !== undefined ? { year: literal.year } : {}),
    ...(literal.seasonRef !== undefined
      ? { seasonRef: literal.seasonRef }
      : {}),
    ...(literal.monthRef !== undefined ? { monthRef: literal.monthRef } : {}),
    ...(literal.day !== undefined ? { day: literal.day } : {}),
    ...(literal.hour !== undefined ? { hour: literal.hour } : {}),
    ...(literal.minute !== undefined ? { minute: literal.minute } : {}),
    granularity: literal.granularity,
    precision: literal.precision,
  };
}

function canonicalConstraint(
  constraint: TemporalConstraint,
): TemporalConstraint {
  switch (constraint.kind) {
    case "absolute-window":
      return {
        id: constraint.id,
        kind: constraint.kind,
        nodeId: constraint.nodeId,
        endpoint: constraint.endpoint,
        sourceIds: uniqueSorted(constraint.sourceIds),
        literal: cloneLiteral(constraint.literal),
        resolved:
          constraint.resolved === null
            ? null
            : {
                calendarRef: constraint.resolved.calendarRef,
                calendarDigest: constraint.resolved.calendarDigest,
                startDay: constraint.resolved.startDay,
                endDay: constraint.resolved.endDay,
                startMinute: constraint.resolved.startMinute,
                endMinute: constraint.resolved.endMinute,
                granularity: constraint.resolved.granularity,
                precision: constraint.resolved.precision,
              },
        authority: constraint.authority,
        strictness: constraint.strictness,
        fingerprint: constraint.fingerprint,
      };
    case "relative-offset":
      return {
        id: constraint.id,
        kind: constraint.kind,
        sourceIds: uniqueSorted(constraint.sourceIds),
        left: {
          nodeId: constraint.left.nodeId,
          endpoint: constraint.left.endpoint,
        },
        right: {
          nodeId: constraint.right.nodeId,
          endpoint: constraint.right.endpoint,
        },
        offset: {
          min: constraint.offset.min,
          max: constraint.offset.max,
          unit: constraint.offset.unit,
          arithmetic: constraint.offset.arithmetic,
        },
        authority: constraint.authority,
        strictness: constraint.strictness,
        fingerprint: constraint.fingerprint,
      };
    case "interval-relation":
      return {
        id: constraint.id,
        kind: constraint.kind,
        leftNodeId: constraint.leftNodeId,
        relation: constraint.relation,
        rightNodeId: constraint.rightNodeId,
        sourceIds: uniqueSorted(constraint.sourceIds),
        authority: constraint.authority,
        strictness: constraint.strictness,
        fingerprint: constraint.fingerprint,
      };
    case "duration":
      return {
        id: constraint.id,
        kind: constraint.kind,
        nodeId: constraint.nodeId,
        sourceIds: uniqueSorted(constraint.sourceIds),
        duration: {
          min: constraint.duration.min,
          max: constraint.duration.max,
          unit: constraint.duration.unit,
        },
        authority: constraint.authority,
        strictness: constraint.strictness,
        fingerprint: constraint.fingerprint,
      };
    case "symbolic":
      return {
        id: constraint.id,
        kind: constraint.kind,
        nodeId: constraint.nodeId,
        relation: constraint.relation,
        anchorNodeId: constraint.anchorNodeId,
        label: constraint.label,
        sourceIds: uniqueSorted(constraint.sourceIds),
        authority: constraint.authority,
        strictness: constraint.strictness,
        fingerprint: constraint.fingerprint,
      };
  }
}

function canonicalSubject(node: TemporalNode): TemporalNode["subject"] {
  switch (node.subject.kind) {
    case "scene":
      return {
        kind: "scene",
        documentRef: node.subject.documentRef,
        ...(node.subject.segmentRef !== undefined
          ? { segmentRef: node.subject.segmentRef }
          : {}),
      };
    case "event":
      return { kind: "event", eventId: node.subject.eventId };
    case "state-boundary":
      return { kind: "state-boundary", inferenceId: node.subject.inferenceId };
    case "phase-boundary":
      return { kind: "phase-boundary", inferenceId: node.subject.inferenceId };
    case "named-period":
      return { kind: "named-period", label: node.subject.label };
  }
}

function canonicalNode(node: TemporalNode): TemporalNode {
  return {
    id: node.id,
    timeline: { ...node.timeline },
    subject: canonicalSubject(node),
    shape: node.shape,
    discoursePositions: [...node.discoursePositions]
      .map((position) => ({
        documentRef: position.documentRef,
        documentOrderIndex: position.documentOrderIndex,
        canonicalOffset: position.canonicalOffset,
      }))
      .sort(
        (left, right) =>
          left.documentOrderIndex - right.documentOrderIndex ||
          left.canonicalOffset - right.canonicalOffset ||
          compareStrings(left.documentRef, right.documentRef),
      ),
    fingerprint: node.fingerprint,
  };
}

function canonicalDiagnostics(
  diagnostics: readonly TemporalDiagnostic[],
): TemporalDiagnostic[] {
  return [...diagnostics]
    .map((item) => ({
      code: item.code,
      message: item.message,
      ...(item.path !== undefined ? { path: item.path } : {}),
    }))
    .sort(
      (left, right) =>
        compareStrings(left.code, right.code) ||
        compareStrings(left.path ?? "", right.path ?? "") ||
        compareStrings(left.message, right.message),
    );
}

export async function buildTemporalConstraintGraph(
  untrustedInput: TemporalConstraintGraphBuildInput,
): Promise<TemporalConstraintGraphBuildResult> {
  let input: TemporalConstraintGraphBuildInput;
  try {
    input = cloneBeforeAwait(untrustedInput);
  } catch {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_INPUT",
          "Temporal graph input cannot be copied",
        ),
      ],
    });
  }

  const validation: TemporalDiagnostic[] = [];
  let verifiedCalendar: ExtractionCalendarSnapshot | null = null;
  if (input.calendar !== null) {
    const calendarVerification = await verifyExtractionCalendarSnapshot(
      input.calendar,
    );
    if (!calendarVerification.ok) {
      validation.push(
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_CALENDAR",
          "Temporal graph Calendar Snapshot is invalid",
          "calendar",
        ),
      );
    } else {
      verifiedCalendar = calendarVerification.snapshot;
    }
  }
  const nodesAreValidArray = Array.isArray(input.nodes);
  const constraintsAreValidArray = Array.isArray(input.constraints);
  const nodeElementsAreValid =
    nodesAreValidArray && input.nodes.every((node) => isRecord(node));
  const constraintElementsAreValid =
    constraintsAreValidArray &&
    input.constraints.every((constraint) => isRecord(constraint));
  const diagnosticsAreValidArray = validSuppliedDiagnostics(input.diagnostics);
  if (!nodesAreValidArray) {
    validation.push(
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_NODES",
        "Temporal graph nodes must be an array",
        "nodes",
      ),
    );
  }
  if (!constraintsAreValidArray) {
    validation.push(
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_CONSTRAINTS",
        "Temporal graph constraints must be an array",
        "constraints",
      ),
    );
  }
  if (!diagnosticsAreValidArray) {
    validation.push(
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_DIAGNOSTICS",
        "Temporal graph diagnostics must be an array",
        "diagnostics",
      ),
    );
  }
  if (!isTemporalTimelineRef(input.timeline)) {
    validation.push(
      diagnostic(
        "TEMPORAL_GRAPH_INVALID_TIMELINE",
        "Temporal graph timeline is invalid",
        "timeline",
      ),
    );
  } else if (nodesAreValidArray) {
    validation.push(...validateNodes(input.timeline, input.nodes));
  }

  const constraintIds = new Set<string>();
  for (const [index, constraint] of (constraintsAreValidArray
    ? input.constraints
    : []
  ).entries()) {
    if (!isRecord(constraint)) {
      validation.push(
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_CONSTRAINT",
          "Temporal graph constraint must be an object",
          `constraints[${index}]`,
        ),
      );
      continue;
    }
    if (typeof constraint.id === "string" && constraintIds.has(constraint.id)) {
      validation.push(
        diagnostic(
          "TEMPORAL_GRAPH_DUPLICATE_CONSTRAINT_ID",
          `Duplicate temporal constraint id: ${constraint.id}`,
          `constraints[${index}].id`,
        ),
      );
    }
    if (typeof constraint.id === "string") constraintIds.add(constraint.id);
    if (nodeElementsAreValid) {
      validation.push(
        ...validateTemporalConstraint(constraint, input.nodes).map((item) => ({
          ...item,
          path: item.path
            ? `constraints[${index}].${item.path}`
            : `constraints[${index}]`,
        })),
      );
    }
  }
  validation.push(
    ...validateCoverage(
      input.coverage,
      nodeElementsAreValid ? input.nodes : [],
    ),
    ...validateCalendarBindings(
      constraintElementsAreValid ? input.constraints : [],
      verifiedCalendar,
    ),
  );
  if (validation.length > 0) {
    return freezeDeep({
      ok: false,
      diagnostics: canonicalDiagnostics(validation),
    });
  }

  const draft = {
    schemaVersion: 1 as const,
    graphVersion: "gdx-temporal-graph/1" as const,
    timeline: { ...input.timeline },
    nodes: input.nodes
      .map(canonicalNode)
      .sort((left, right) => compareStrings(left.id, right.id)),
    constraints: input.constraints
      .map(canonicalConstraint)
      .sort((left, right) => compareStrings(left.id, right.id)),
    calendar: verifiedCalendar,
    coverage: {
      status: input.coverage.status,
      documentRefs: uniqueSorted(input.coverage.documentRefs),
      omittedDocumentRefs: uniqueSorted(input.coverage.omittedDocumentRefs),
    },
    diagnostics: canonicalDiagnostics(input.diagnostics),
  };
  try {
    const digest = await digestStableJson(draft);
    return { ok: true, graph: freezeDeep({ ...draft, digest }) };
  } catch {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_INPUT",
          "Temporal graph input cannot be sealed",
        ),
      ],
    });
  }
}

/** Rebuild and compare a graph seal before a persisted artifact is trusted. */
export async function verifyTemporalConstraintGraph(
  value: unknown,
): Promise<TemporalConstraintGraphBuildResult> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.graphVersion !== "gdx-temporal-graph/1" ||
    typeof value.digest !== "string" ||
    !isSemanticFingerprint(value.digest)
  ) {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "TEMPORAL_GRAPH_INVALID_ARTIFACT",
          "Temporal graph artifact envelope is invalid",
        ),
      ],
    });
  }
  const claimedDigest = value.digest;
  const rebuilt = await buildTemporalConstraintGraph({
    timeline: value.timeline as TemporalTimelineRef,
    nodes: value.nodes as readonly TemporalNode[],
    constraints: value.constraints as readonly TemporalConstraint[],
    calendar: value.calendar as ExtractionCalendarSnapshot | null,
    coverage: value.coverage as ExtractionCoverageManifest,
    diagnostics: value.diagnostics as readonly TemporalDiagnostic[],
  });
  if (!rebuilt.ok) return rebuilt;
  if (rebuilt.graph.digest !== claimedDigest) {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "TEMPORAL_GRAPH_DIGEST_MISMATCH",
          "Temporal graph content does not match its digest",
        ),
      ],
    });
  }
  return rebuilt;
}
