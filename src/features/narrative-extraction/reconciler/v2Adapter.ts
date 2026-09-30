import type {
  ContextSetEntry,
  DependencySetEntry,
  InterpretationRevisionBasisV2,
  NarrativeAssertionDigests,
  NarrativeAssertionProducer,
  NarrativeProjectionBindingV2,
  NarrativeRevisionEnvelopeV2,
  ProposalChangeKind,
  ReconciliationEnvelopeV1,
} from "./types";
import {
  NARRATIVE_IR_REGISTRY,
  assertNarrativeRevisionEnvelopeV2 as assertCanonicalNarrativeRevisionEnvelopeV2,
  validateNarrativeRevisionEnvelopeV2 as validateCanonicalNarrativeRevisionEnvelopeV2,
} from "@/features/narrative-semantic-core/contracts/narrativeIr";

/** Compatibility boundary: all semantics remain owned by the K1 validator. */
export function validateNarrativeRevisionEnvelopeV2(envelope: unknown) {
  return validateCanonicalNarrativeRevisionEnvelopeV2(envelope);
}

export function assertNarrativeRevisionEnvelopeV2(
  envelope: unknown,
): asserts envelope is NarrativeRevisionEnvelopeV2 {
  assertCanonicalNarrativeRevisionEnvelopeV2(
    envelope as NarrativeRevisionEnvelopeV2<unknown>,
  );
}

const CHANGE_KINDS = new Set<ProposalChangeKind>([
  "add",
  "revise",
  "retract",
  "merge",
  "split",
]);

type V2AssertionWithoutProducer<TPayload> = Omit<
  NarrativeRevisionEnvelopeV2<TPayload>["assertion"],
  "producer"
>;

type RevisionBasisInput = {
  readonly kind: "interpretation";
  readonly componentContractDigest: string;
  readonly finalRequestDigest: string;
};

type ProjectionBindingInput = Omit<
  NarrativeProjectionBindingV2,
  "proposalPayloadDigest"
> & {
  readonly proposalPayloadDigest: string;
};

export interface ReconciliationEnvelopeV1ToV2Input<TPayload> {
  readonly envelope: ReconciliationEnvelopeV1;
  readonly assertion: V2AssertionWithoutProducer<TPayload>;
  readonly assertionDigests: {
    readonly assertionCoreDigest: string;
    readonly scopeDigest: string;
    readonly assertionDigest: string;
  };
  readonly contextSet: readonly ContextSetEntry[];
  readonly contextSetDigest: string;
  readonly dependencySet: readonly DependencySetEntry[];
  readonly dependencySetDigest: string;
  readonly materialBasisDigest: string;
  readonly revisionBasis: RevisionBasisInput;
  readonly projectionBinding: ProjectionBindingInput;
}

function requireNonEmpty(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Narrative Revision Envelope V2 ${name} must be non-empty`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertMinimalInterpretationRevisionBasis(
  value: unknown,
): asserts value is RevisionBasisInput {
  if (!isRecord(value)) {
    throw new Error(
      "Narrative Revision Envelope V1 adapter revisionBasis must be an interpretation input",
    );
  }
  if (value.kind !== "interpretation") {
    throw new Error(
      "Narrative Revision Envelope V1 adapter only accepts interpretation revisionBasis input",
    );
  }

  const allowedFields = new Set([
    "kind",
    "componentContractDigest",
    "finalRequestDigest",
  ]);
  const unknownField = [
    ...Object.getOwnPropertyNames(value),
    ...Object.getOwnPropertySymbols(value).map(String),
  ].find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    throw new Error(
      `Narrative Revision Envelope V1 adapter rejects caller-owned revisionBasis field '${unknownField}'`,
    );
  }

  requireNonEmpty(
    value.componentContractDigest,
    "revisionBasis.componentContractDigest",
  );
  requireNonEmpty(value.finalRequestDigest, "revisionBasis.finalRequestDigest");
}

function buildProducer(
  envelope: ReconciliationEnvelopeV1,
): NarrativeAssertionProducer {
  // This is the frozen ADR 011 V1 compatibility mapping. In particular, the
  // old proposal kind must not be mistaken for an assertion Producer Kind.
  return {
    kind: "reconciler-proposal",
    id: envelope.reconcilerId,
    version: envelope.reconcilerVersion,
  };
}

function validateChangeIntent(
  changeKind: ProposalChangeKind,
  targetProjectionRef: string | undefined,
): void {
  if (!CHANGE_KINDS.has(changeKind)) {
    throw new Error(
      `Narrative Revision Envelope V2 unknown changeKind '${changeKind}'`,
    );
  }
  if (changeKind === "add" && targetProjectionRef !== undefined) {
    throw new Error(
      "Narrative Revision Envelope V2 targetProjectionRef cannot be set for add change",
    );
  }
  if (changeKind === "retract") {
    requireNonEmpty(targetProjectionRef, "retract targetProjectionRef");
  }
}

/**
 * Adapt the existing V1 envelope into the pure V2 shape.
 *
 * V1 has no Scope, Context Set, typed payload, or digest domains. Those values
 * therefore arrive as explicit pure inputs; the adapter only performs the
 * fixed V1 field mapping and invariant checks. It never writes persistence or
 * treats a client-provided V1 digest as a Native recomputation authority.
 */
export function adaptReconciliationEnvelopeV1ToV2<TPayload>(
  input: ReconciliationEnvelopeV1ToV2Input<TPayload>,
): NarrativeRevisionEnvelopeV2<TPayload> {
  const { envelope } = input;
  if (envelope.schemaVersion !== 1) {
    throw new Error(
      "Narrative Revision Envelope V1 adapter requires schemaVersion 1",
    );
  }
  requireNonEmpty(envelope.runId, "runId");
  requireNonEmpty(envelope.taskId, "taskId");
  requireNonEmpty(envelope.reconcilerId, "reconcilerId");
  requireNonEmpty(envelope.reconcilerVersion, "reconcilerVersion");
  validateChangeIntent(envelope.changeKind, envelope.targetProjectionRef);
  if (
    input.projectionBinding.proposalSchemaRef.id !==
      envelope.proposalSchemaId ||
    input.projectionBinding.proposalSchemaRef.version !==
      envelope.proposalSchemaVersion
  ) {
    throw new Error(
      "Narrative Revision Envelope V1 adapter must preserve proposal schema binding",
    );
  }
  if (
    input.projectionBinding.adapterContractId !==
      NARRATIVE_IR_REGISTRY.adapter.id ||
    input.projectionBinding.adapterContractVersion !==
      NARRATIVE_IR_REGISTRY.adapter.version
  ) {
    throw new Error(
      "Narrative Revision Envelope V1 adapter requires the registered canonical adapter",
    );
  }
  assertMinimalInterpretationRevisionBasis(input.revisionBasis);

  const producer = buildProducer(envelope);
  const result: NarrativeRevisionEnvelopeV2<TPayload> = {
    schemaVersion: 2,
    assertion: {
      ...input.assertion,
      producer,
    },
    assertionDigests: input.assertionDigests as NarrativeAssertionDigests,
    changeIntent: {
      changeKind: envelope.changeKind,
      ...(envelope.targetProjectionRef !== undefined
        ? { targetProjectionRef: envelope.targetProjectionRef }
        : {}),
    },
    effectiveMaterialBasis: {
      sourceBasis: envelope.sourceBasis,
      evidenceSet: envelope.evidenceSet,
      dependencySet: input.dependencySet,
      dependencySetDigest:
        input.dependencySetDigest as NarrativeAssertionDigests["assertionCoreDigest"],
      materialBasisDigest:
        input.materialBasisDigest as NarrativeAssertionDigests["assertionCoreDigest"],
    },
    revisionBasis: {
      kind: "interpretation",
      runId: envelope.runId,
      taskId: envelope.taskId,
      producer,
      contextSet: input.contextSet,
      contextSetDigest:
        input.contextSetDigest as InterpretationRevisionBasisV2["contextSetDigest"],
      componentContractDigest: input.revisionBasis
        .componentContractDigest as InterpretationRevisionBasisV2["componentContractDigest"],
      finalRequestDigest: input.revisionBasis
        .finalRequestDigest as InterpretationRevisionBasisV2["finalRequestDigest"],
    },
    projectionBinding: input.projectionBinding as NarrativeProjectionBindingV2,
  };
  assertNarrativeRevisionEnvelopeV2(result);
  return result;
}

/** Short alias for callers that already know the source contract version. */
export const adaptV1ToV2 = adaptReconciliationEnvelopeV1ToV2;
export const toNarrativeRevisionEnvelopeV2 = adaptReconciliationEnvelopeV1ToV2;

/** Enforce the once-V2-always-V2 lineage rule without touching persistence. */
export function assertV2LineageMonotonicity(
  current: NarrativeRevisionEnvelopeV2,
  next: unknown,
): asserts next is NarrativeRevisionEnvelopeV2 {
  assertNarrativeRevisionEnvelopeV2(current);
  if (
    next === null ||
    typeof next !== "object" ||
    (next as { schemaVersion?: unknown }).schemaVersion !== 2
  ) {
    throw new Error(
      "Narrative Revision Envelope V2 downgrade is forbidden once the current revision is V2",
    );
  }
  assertNarrativeRevisionEnvelopeV2(
    next as NarrativeRevisionEnvelopeV2<unknown>,
  );
}
