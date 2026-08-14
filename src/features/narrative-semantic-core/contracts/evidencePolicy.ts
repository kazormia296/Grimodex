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

export function validateEvidencePolicy(
  input: EvidencePolicyInput,
): EvidencePolicyResult {
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
