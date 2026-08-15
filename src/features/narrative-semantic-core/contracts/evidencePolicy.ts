export const ASSERTION_SUPPORT_CLASSES = [
  "author-declared",
  "direct-source",
  "reported-source",
  "single-source-inference",
  "multi-source-inference",
  "imported-assertion",
  "unresolved",
] as const;
export type AssertionSupportClass = (typeof ASSERTION_SUPPORT_CLASSES)[number];

export const EVIDENCE_ABSENCE_REASONS = [
  "author-declaration",
  "import-metadata",
  "legacy-unbound",
  "not-applicable",
] as const;
export type EvidenceAbsenceReason = (typeof EVIDENCE_ABSENCE_REASONS)[number];

export const NARRATIVE_PRODUCER_KINDS = [
  "ai-inference",
  "reconciler-proposal",
  "author-declaration",
  "import-metadata",
  "legacy-migration",
] as const;
export type NarrativeProducerKind = (typeof NARRATIVE_PRODUCER_KINDS)[number];

export interface EvidencePolicyInput {
  readonly producerKind: NarrativeProducerKind;
  readonly supportClass: AssertionSupportClass;
  readonly evidenceSet: readonly unknown[];
  readonly sourceBasis: readonly string[];
  readonly evidenceAbsenceReason?: EvidenceAbsenceReason;
}

export type EvidencePolicyFailureReason =
  | "unsupported-producer-kind"
  | "unsupported-support-class"
  | "source-basis-required"
  | "evidence-required"
  | "evidence-absence-reason-required"
  | "invalid-evidence-absence-reason";

export type EvidencePolicyResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: EvidencePolicyFailureReason };

const SUPPORT_CLASS_SET = new Set<string>(ASSERTION_SUPPORT_CLASSES);
const ABSENCE_REASON_SET = new Set<string>(EVIDENCE_ABSENCE_REASONS);
const PRODUCER_KIND_SET = new Set<string>(NARRATIVE_PRODUCER_KINDS);

export function validateEvidencePolicy(
  input: EvidencePolicyInput,
): EvidencePolicyResult {
  // JSON callers can still provide an explicit null or malformed array even
  // though the TypeScript type is non-nullable. Treat that boundary as an
  // invalid evidence claim rather than allowing a caller-side fallback to
  // turn it into an admission.
  if (input === null || typeof input !== "object") {
    return { valid: false, reason: "unsupported-producer-kind" };
  }
  if (!Array.isArray(input.sourceBasis)) {
    return { valid: false, reason: "source-basis-required" };
  }
  if (!Array.isArray(input.evidenceSet)) {
    return { valid: false, reason: "evidence-required" };
  }
  if (!PRODUCER_KIND_SET.has(input.producerKind)) {
    return { valid: false, reason: "unsupported-producer-kind" };
  }
  if (!SUPPORT_CLASS_SET.has(input.supportClass)) {
    return { valid: false, reason: "unsupported-support-class" };
  }
  if (input.sourceBasis.length === 0) {
    return { valid: false, reason: "source-basis-required" };
  }
  if (
    input.evidenceAbsenceReason !== undefined &&
    !ABSENCE_REASON_SET.has(input.evidenceAbsenceReason)
  ) {
    return { valid: false, reason: "invalid-evidence-absence-reason" };
  }

  if (
    input.producerKind === "ai-inference" ||
    input.producerKind === "reconciler-proposal"
  ) {
    return input.evidenceSet.length > 0
      ? { valid: true }
      : { valid: false, reason: "evidence-required" };
  }

  if (input.producerKind === "author-declaration") {
    if (input.evidenceSet.length > 0) return { valid: true };
    return input.evidenceAbsenceReason === "author-declaration"
      ? { valid: true }
      : { valid: false, reason: "evidence-absence-reason-required" };
  }

  if (input.producerKind === "import-metadata") {
    if (input.evidenceSet.length > 0) return { valid: true };
    return input.evidenceAbsenceReason === "import-metadata"
      ? { valid: true }
      : { valid: false, reason: "evidence-absence-reason-required" };
  }

  return input.evidenceSet.length > 0 ||
    input.evidenceAbsenceReason === "legacy-unbound"
    ? { valid: true }
    : { valid: false, reason: "evidence-absence-reason-required" };
}
