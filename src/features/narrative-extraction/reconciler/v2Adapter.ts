import type {
  ContextSetEntry,
  DependencySetEntry,
  HumanDerivedRevisionBasisV2,
  InterpretationRevisionBasisV2,
  NarrativeAssertionDigests,
  NarrativeAssertionProducer,
  NarrativeProjectionBindingV2,
  NarrativeRevisionEnvelopeV2,
  NarrativeScopeV2,
  ProposalChangeKind,
  ReconciliationEnvelopeV1,
} from "./types";

const PRODUCER_KINDS = new Set([
  "ai-inference",
  "reconciler-proposal",
  "author-declaration",
  "import-metadata",
  "legacy-migration",
]);

const ASSERTION_MODALITIES = new Set([
  "modality-explicit-text",
  "modality-narrator-claim",
  "modality-hearsay",
  "modality-character-belief",
  "modality-inference",
  "modality-hypothesis",
  "modality-author-declaration",
  "modality-imported-assertion",
]);

const ASSERTION_POLARITIES = new Set(["affirmative", "negative", "uncertain"]);

const SUPPORT_CLASSES = new Set([
  "author-declared",
  "direct-source",
  "reported-source",
  "single-source-inference",
  "multi-source-inference",
  "imported-assertion",
  "unresolved",
]);

const CHANGE_KINDS = new Set<ProposalChangeKind>([
  "add",
  "revise",
  "retract",
  "merge",
  "split",
]);

const ASSERTION_KINDS = new Set(["scene-event@1"]);

type V2AssertionWithoutProducer<TPayload> = Omit<
  NarrativeRevisionEnvelopeV2<TPayload>["assertion"],
  "producer"
>;

type RevisionBasisInput =
  | {
      readonly kind: "interpretation";
      readonly runId: string;
      readonly taskId: string;
      readonly producer: NarrativeAssertionProducer;
      readonly contextSet: readonly ContextSetEntry[];
      readonly contextSetDigest: string;
      readonly componentContractDigest: string;
      readonly finalRequestDigest: string;
    }
  | {
      readonly kind: "human-derived";
      readonly parentRevisionId: string;
      readonly expectedParentEnvelopeDigest: string;
      readonly parentAssertionDigest: string;
      readonly rootInterpretationRevisionId: string;
      readonly derivation: {
        readonly adapterId: string;
        readonly adapterVersion: string;
        readonly kind: "projection-only" | "scope-override";
        readonly proposalPayloadChangedPaths: readonly string[];
      };
      readonly revisionActor: {
        readonly kind: "human";
        readonly surfaceId: string;
      };
      readonly derivationContextSet: readonly ContextSetEntry[];
      readonly derivationContextSetDigest: string;
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
    input.revisionBasis.kind === "interpretation" &&
    input.revisionBasis.contextSetDigest !== input.contextSetDigest
  ) {
    throw new Error(
      "Narrative Revision Envelope V1 adapter contextSetDigest does not match interpretation basis",
    );
  }

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
    revisionBasis: input.revisionBasis as
      | InterpretationRevisionBasisV2
      | HumanDerivedRevisionBasisV2,
    projectionBinding: input.projectionBinding as NarrativeProjectionBindingV2,
  };
  assertNarrativeRevisionEnvelopeV2(result);
  return result;
}

/** Short alias for callers that already know the source contract version. */
export const adaptV1ToV2 = adaptReconciliationEnvelopeV1ToV2;
export const toNarrativeRevisionEnvelopeV2 = adaptReconciliationEnvelopeV1ToV2;

function validateScope(scope: NarrativeScopeV2, errors: string[]): void {
  if (scope === null || typeof scope !== "object") {
    errors.push("assertion.scope must be an object");
    return;
  }
  if (scope.schemaVersion !== 2) {
    errors.push("assertion.scope schemaVersion must be 2");
  }
  if (typeof scope.registryVersion !== "string" || !scope.registryVersion) {
    errors.push("assertion.scope registryVersion must be non-empty");
  }
}

/** Return all pure structural V2 failures without mutating the candidate. */
export function validateNarrativeRevisionEnvelopeV2(
  envelope: unknown,
): readonly string[] {
  const errors: string[] = [];
  if (envelope === null || typeof envelope !== "object") {
    return ["Envelope V2 must be an object"];
  }
  const candidate = envelope as Partial<NarrativeRevisionEnvelopeV2<unknown>>;
  if (candidate.schemaVersion !== 2) {
    errors.push("Envelope V2 schemaVersion must be 2");
  }

  const assertion = candidate.assertion;
  if (assertion === null || typeof assertion !== "object") {
    errors.push("Envelope V2 assertion is required");
  } else {
    requireField(assertion.assertionKind, "assertion.assertionKind", errors);
    if (!ASSERTION_KINDS.has(assertion.assertionKind)) {
      errors.push(
        `unknown assertion kind '${String(assertion.assertionKind)}'`,
      );
    }
    validateScope(assertion.scope, errors);
    if (!ASSERTION_MODALITIES.has(assertion.modality)) {
      errors.push(`unknown assertion modality '${String(assertion.modality)}'`);
    }
    if (!ASSERTION_POLARITIES.has(assertion.polarity)) {
      errors.push(`unknown assertion polarity '${String(assertion.polarity)}'`);
    }
    if (!SUPPORT_CLASSES.has(assertion.supportClass)) {
      errors.push(`unknown support class '${String(assertion.supportClass)}'`);
    }
    const producer = assertion.producer;
    if (producer === null || typeof producer !== "object") {
      errors.push("assertion.producer is required");
    } else {
      if (!PRODUCER_KINDS.has(producer.kind)) {
        errors.push(`unknown producer kind '${String(producer.kind)}'`);
      }
      requireField(producer.id, "assertion.producer.id", errors);
      requireField(producer.version, "assertion.producer.version", errors);
    }
  }

  const digests = candidate.assertionDigests;
  if (digests === null || typeof digests !== "object") {
    errors.push("Envelope V2 assertionDigests is required");
  } else {
    requireField(
      digests.assertionCoreDigest,
      "assertionDigests.assertionCoreDigest",
      errors,
    );
    requireField(digests.scopeDigest, "assertionDigests.scopeDigest", errors);
    requireField(
      digests.assertionDigest,
      "assertionDigests.assertionDigest",
      errors,
    );
  }

  const changeIntent = candidate.changeIntent;
  if (changeIntent === null || typeof changeIntent !== "object") {
    errors.push("Envelope V2 changeIntent is required");
  } else {
    if (!CHANGE_KINDS.has(changeIntent.changeKind)) {
      errors.push(`unknown changeKind '${String(changeIntent.changeKind)}'`);
    } else if (
      changeIntent.changeKind === "add" &&
      changeIntent.targetProjectionRef !== undefined
    ) {
      errors.push("add change cannot set targetProjectionRef");
    } else if (
      changeIntent.changeKind === "retract" &&
      (typeof changeIntent.targetProjectionRef !== "string" ||
        changeIntent.targetProjectionRef.trim().length === 0)
    ) {
      errors.push("retract change requires targetProjectionRef");
    }
  }

  const basis = candidate.effectiveMaterialBasis;
  if (basis === null || typeof basis !== "object") {
    errors.push("Envelope V2 effectiveMaterialBasis is required");
  } else {
    if (!Array.isArray(basis.sourceBasis)) {
      errors.push("effectiveMaterialBasis.sourceBasis must be an array");
    }
    if (!Array.isArray(basis.evidenceSet)) {
      errors.push("effectiveMaterialBasis.evidenceSet must be an array");
    }
    if (!Array.isArray(basis.dependencySet)) {
      errors.push("effectiveMaterialBasis.dependencySet must be an array");
    }
    requireField(
      basis.dependencySetDigest,
      "effectiveMaterialBasis.dependencySetDigest",
      errors,
    );
    requireField(
      basis.materialBasisDigest,
      "effectiveMaterialBasis.materialBasisDigest",
      errors,
    );
  }

  const revisionBasis = candidate.revisionBasis;
  if (revisionBasis === null || typeof revisionBasis !== "object") {
    errors.push("Envelope V2 revisionBasis is required");
  } else {
    const revisionBasisRecord = revisionBasis as unknown as Record<
      string,
      unknown
    >;
    const revisionBasisKind = revisionBasisRecord.kind;
    if (
      revisionBasisKind !== "interpretation" &&
      revisionBasisKind !== "human-derived"
    ) {
      errors.push(`unknown revisionBasis kind '${String(revisionBasisKind)}'`);
    } else if (revisionBasisKind === "interpretation") {
      requireField(revisionBasisRecord.runId, "revisionBasis.runId", errors);
      requireField(revisionBasisRecord.taskId, "revisionBasis.taskId", errors);
    } else {
      requireField(
        revisionBasisRecord.parentRevisionId,
        "revisionBasis.parentRevisionId",
        errors,
      );
      requireField(
        revisionBasisRecord.expectedParentEnvelopeDigest,
        "revisionBasis.expectedParentEnvelopeDigest",
        errors,
      );
      const derivation = revisionBasisRecord.derivation;
      const derivationKind =
        derivation !== null && typeof derivation === "object"
          ? (derivation as { kind?: unknown }).kind
          : undefined;
      if (
        derivationKind !== "projection-only" &&
        derivationKind !== "scope-override"
      ) {
        errors.push(
          "human-derived revision basis has unsupported derivation kind",
        );
      }
      const derivationContextSet = revisionBasisRecord.derivationContextSet;
      if (
        Array.isArray(derivationContextSet) &&
        derivationContextSet.some(
          (entry: unknown) =>
            entry !== null &&
            typeof entry === "object" &&
            (entry as { exposure?: unknown }).exposure === "model-visible",
        )
      ) {
        errors.push(
          "human-derived derivationContextSet cannot expose model-visible context",
        );
      }
    }
  }

  const binding = candidate.projectionBinding;
  if (binding === null || typeof binding !== "object") {
    errors.push("Envelope V2 projectionBinding is required");
  } else {
    requireField(
      binding.proposalKind,
      "projectionBinding.proposalKind",
      errors,
    );
    requireField(
      binding.proposalSchemaRef?.id,
      "projectionBinding.proposalSchemaRef.id",
      errors,
    );
    requireField(
      binding.proposalSchemaRef?.version,
      "projectionBinding.proposalSchemaRef.version",
      errors,
    );
    requireField(
      binding.proposalPayloadDigest,
      "projectionBinding.proposalPayloadDigest",
      errors,
    );
    requireField(
      binding.adapterContractId,
      "projectionBinding.adapterContractId",
      errors,
    );
    requireField(
      binding.adapterContractVersion,
      "projectionBinding.adapterContractVersion",
      errors,
    );
  }
  return errors;
}

function requireField(value: unknown, field: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be non-empty`);
  }
}

/** Throw one deterministic structural error for an invalid V2 candidate. */
export function assertNarrativeRevisionEnvelopeV2(
  envelope: unknown,
): asserts envelope is NarrativeRevisionEnvelopeV2 {
  const errors = validateNarrativeRevisionEnvelopeV2(envelope);
  if (errors.length > 0) {
    throw new Error(
      `Invalid Narrative Revision Envelope V2: ${errors.join("; ")}`,
    );
  }
}

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
  assertNarrativeRevisionEnvelopeV2(next);
}
