import { invoke } from "@/lib/tauri";
import { createDeterministicEvidenceResolver } from "@/features/narrative-extraction/evidence/resolveEvidence";
import type {
  EvidenceResolutionResult,
  ResolvedEvidenceAnchor,
} from "@/features/narrative-extraction/evidence/types";
import { hasLoneSurrogate } from "@/features/narrative-extraction/source/digest";
import { freezeDeep } from "@/features/narrative-extraction/source/immutability";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import {
  CANONICAL_TEXT_NORMALIZER_VERSION,
  type CanonicalRange,
  type NarrativeCorpusSnapshot,
  type NarrativeSourceView,
} from "@/features/narrative-extraction/source/types";
import {
  ENTITY_SEED_CONTEXT_RADIUS,
  ENTITY_SEED_MAX_REFERENCE_BYTES,
  ENTITY_SEED_MAX_REQUEST_BYTES,
  ENTITY_SEED_MAX_SOURCES,
  ENTITY_SEED_SCHEMA_VERSION,
  parseEntitySeedNativeResponse,
  type ExtractCodexEntitySeedsRequestV1,
  type NativeEntitySeedOccurrenceV1,
} from "./schemas";

export interface EntityCandidateOccurrence {
  readonly sourceRef: string;
  readonly documentRef: string;
  readonly quote: string;
  readonly canonicalRange: CanonicalRange;
  readonly context: {
    readonly prefix: string;
    readonly suffix: string;
  };
  readonly evidence: ResolvedEvidenceAnchor;
}

export interface EntityCandidateSeed {
  readonly seedId: string;
  readonly surface: string;
  readonly normalizedSurface: string;
  readonly occurrences: readonly EntityCandidateOccurrence[];
  readonly features: {
    readonly occurrenceCount: number;
    readonly appearsAsProperName: boolean;
    readonly appearsInDialogue: boolean;
    readonly appearsInNarration: boolean;
  };
}

export interface EntityCandidateRejection {
  readonly seedId: string;
  readonly sourceRef: string;
  readonly quote: string;
  readonly canonicalRange: CanonicalRange;
  readonly reason: string;
}

export type EntityCandidatePrepassResult =
  | {
      readonly status: "complete";
      readonly seeds: readonly EntityCandidateSeed[];
      readonly rejections: readonly EntityCandidateRejection[];
    }
  | {
      readonly status: "unsupported-language";
      readonly language: string;
      readonly seeds: readonly [];
      readonly rejections: readonly [];
    };

export interface EntityCandidatePrepassInput {
  readonly snapshot: NarrativeCorpusSnapshot;
  readonly sourceViews: readonly NarrativeSourceView[];
  readonly minimumOccurrenceCount: number;
  readonly createEvidenceAnchorId: () => string;
}

interface MutableSeed {
  seedId: string;
  surface: string;
  normalizedSurface: string;
  occurrences: EntityCandidateOccurrence[];
  physicalOccurrences: Set<string>;
  appearsAsProperName: boolean;
  appearsInDialogue: boolean;
  appearsInNarration: boolean;
}

interface DialogueInterval {
  readonly start: number;
  readonly end: number;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function isValidOpaqueReference(value: string): boolean {
  return (
    value.length > 0 &&
    !hasLoneSurrogate(value) &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).byteLength <=
      ENTITY_SEED_MAX_REFERENCE_BYTES
  );
}

function sameRange(left: CanonicalRange, right: CanonicalRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function findUniqueDocument(
  snapshot: NarrativeCorpusSnapshot,
  documentRef: string,
) {
  const matches = snapshot.documents.filter(
    (document) => document.ref === documentRef,
  );
  if (matches.length !== 1) {
    throw new TypeError(
      `Invalid or duplicate narrative document ref: ${documentRef}`,
    );
  }
  return matches[0]!;
}

async function verifyAndRebuildSourceViews(
  snapshot: NarrativeCorpusSnapshot,
  sourceViews: readonly NarrativeSourceView[],
): Promise<readonly NarrativeSourceView[]> {
  if (sourceViews.length > ENTITY_SEED_MAX_SOURCES) {
    throw new RangeError("Entity candidate prepass has too many Source Views");
  }
  // Copy every untrusted primitive before the first await so a caller cannot
  // splice a different Source View generation into one request.
  const stableSourceViews = sourceViews.map((sourceView) => ({
    ref: sourceView.ref,
    documentRef: sourceView.documentRef,
    documentRange: {
      start: sourceView.documentRange.start,
      end: sourceView.documentRange.end,
    },
    text: sourceView.text,
    digest: sourceView.digest,
  }));
  const refs = new Set<string>();
  const rebuilt: NarrativeSourceView[] = [];
  for (const stable of stableSourceViews) {
    if (
      !isValidOpaqueReference(stable.ref) ||
      !isValidOpaqueReference(stable.documentRef) ||
      refs.has(stable.ref)
    ) {
      throw new TypeError("Invalid or duplicate narrative Source View ref");
    }
    refs.add(stable.ref);
    const document = findUniqueDocument(snapshot, stable.documentRef);
    const sealed = await buildNarrativeSourceView({
      ref: stable.ref,
      document,
      documentRange: stable.documentRange,
    });
    if (
      sealed.documentRef !== stable.documentRef ||
      sealed.text !== stable.text ||
      sealed.digest !== stable.digest ||
      !sameRange(sealed.documentRange, stable.documentRange)
    ) {
      throw new TypeError(
        "Narrative Source View does not match its sealed document",
      );
    }
    rebuilt.push(sealed);
  }
  return freezeDeep(rebuilt);
}

function contextMatches(
  sourceView: NarrativeSourceView,
  occurrence: NativeEntitySeedOccurrenceV1,
  anchor: ResolvedEvidenceAnchor,
): boolean {
  const { start, end } = anchor.sourceRange;
  const { prefix, suffix } = occurrence.context;
  return (
    sourceView.text.slice(Math.max(0, start - prefix.length), start) ===
      prefix && sourceView.text.slice(end, end + suffix.length) === suffix
  );
}

function buildDialogueIntervals(text: string): readonly DialogueInterval[] {
  const intervals: DialogueInterval[] = [];
  let japaneseDepth = 0;
  let curlyDepth = 0;
  let asciiQuoteOpen = false;
  let activeStart: number | null = null;
  const totalDepth = () =>
    japaneseDepth + curlyDepth + (asciiQuoteOpen ? 1 : 0);

  for (let offset = 0; offset < text.length; ) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const width = character.length;
    const before = totalDepth();
    switch (character) {
      case "「":
      case "『":
        japaneseDepth += 1;
        break;
      case "」":
      case "』":
        japaneseDepth = Math.max(0, japaneseDepth - 1);
        break;
      case "“":
        curlyDepth += 1;
        break;
      case "”":
        curlyDepth = Math.max(0, curlyDepth - 1);
        break;
      case '"':
        asciiQuoteOpen = !asciiQuoteOpen;
        break;
      default:
        break;
    }
    const after = totalDepth();
    if (before === 0 && after > 0) activeStart = offset + width;
    if (before > 0 && after === 0 && activeStart !== null) {
      if (activeStart < offset)
        intervals.push({ start: activeStart, end: offset });
      activeStart = null;
    }
    offset += width;
  }
  if (activeStart !== null && activeStart < text.length) {
    intervals.push({ start: activeStart, end: text.length });
  }
  return intervals;
}

function occurrenceIsDialogue(
  intervals: readonly DialogueInterval[],
  sourceOffset: number,
): boolean {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const interval = intervals[middle];
    if (!interval || sourceOffset < interval.start) {
      high = middle;
    } else if (sourceOffset >= interval.end) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
}

function rejection(
  seedId: string,
  occurrence: NativeEntitySeedOccurrenceV1,
  result: EvidenceResolutionResult | "context-mismatch",
): EntityCandidateRejection {
  return {
    seedId,
    sourceRef: occurrence.sourceRef,
    quote: occurrence.quote,
    canonicalRange: occurrence.canonicalRange,
    reason:
      result === "context-mismatch"
        ? result
        : result.status === "invalid"
          ? result.reason
          : result.status,
  };
}

/**
 * Run the deterministic Native entity-seed prepass against sealed Source
 * Views. No project ids, database ids, or mutable editor state cross the IPC
 * boundary.
 */
export async function runEntityCandidatePrepass(
  input: EntityCandidatePrepassInput,
): Promise<EntityCandidatePrepassResult> {
  const snapshot = input.snapshot;
  const language = snapshot.language;
  const minimumOccurrenceCount = input.minimumOccurrenceCount;
  const createEvidenceAnchorId = input.createEvidenceAnchorId;
  const inputSourceViews = [...input.sourceViews];
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.normalizerVersion !== CANONICAL_TEXT_NORMALIZER_VERSION ||
    typeof language !== "string" ||
    language.length === 0 ||
    hasLoneSurrogate(language) ||
    typeof createEvidenceAnchorId !== "function"
  ) {
    throw new TypeError("Invalid narrative snapshot or prepass options");
  }
  if (language !== "ja") {
    return freezeDeep({
      status: "unsupported-language",
      language,
      seeds: [] as const,
      rejections: [] as const,
    });
  }
  if (!isPositiveSafeInteger(minimumOccurrenceCount)) {
    throw new RangeError("minimumOccurrenceCount must be a positive integer");
  }

  const sourceViews = await verifyAndRebuildSourceViews(
    snapshot,
    inputSourceViews,
  );
  const request: ExtractCodexEntitySeedsRequestV1 = {
    schemaVersion: ENTITY_SEED_SCHEMA_VERSION,
    normalizerVersion: CANONICAL_TEXT_NORMALIZER_VERSION,
    language,
    minimumOccurrenceCount,
    sources: sourceViews.map((sourceView) => ({
      sourceRef: sourceView.ref,
      documentRef: sourceView.documentRef,
      documentRange: sourceView.documentRange,
      text: sourceView.text,
    })),
  };
  if (
    new TextEncoder().encode(JSON.stringify(request)).byteLength >
    ENTITY_SEED_MAX_REQUEST_BYTES
  ) {
    throw new RangeError(
      "Entity candidate prepass exceeds the 8 MiB wire budget",
    );
  }
  const rawResponse = await invoke<unknown>(
    "extract_codex_entity_seeds",
    request as unknown as Record<string, unknown>,
  );
  const response = parseEntitySeedNativeResponse(rawResponse);
  const sourceByRef = new Map(sourceViews.map((view) => [view.ref, view]));
  const dialogueByDocumentRef = new Map<string, readonly DialogueInterval[]>();
  for (const sourceView of sourceViews) {
    if (dialogueByDocumentRef.has(sourceView.documentRef)) continue;
    const document = findUniqueDocument(snapshot, sourceView.documentRef);
    dialogueByDocumentRef.set(
      sourceView.documentRef,
      buildDialogueIntervals(document.canonical.text),
    );
  }
  const resolveEvidence = createDeterministicEvidenceResolver({
    snapshot,
    sourceViews,
    createAnchorId: createEvidenceAnchorId,
    contextRadius: ENTITY_SEED_CONTEXT_RADIUS,
  });
  const merged = new Map<string, MutableSeed>();
  const rejections: EntityCandidateRejection[] = [];

  for (const nativeSeed of response.seeds) {
    let target = merged.get(nativeSeed.normalizedSurface);
    if (!target) {
      target = {
        seedId: nativeSeed.seedId,
        surface: nativeSeed.surface,
        normalizedSurface: nativeSeed.normalizedSurface,
        occurrences: [],
        physicalOccurrences: new Set<string>(),
        appearsAsProperName: false,
        appearsInDialogue: false,
        appearsInNarration: false,
      };
      merged.set(nativeSeed.normalizedSurface, target);
    }
    for (const nativeOccurrence of nativeSeed.occurrences) {
      const provisionalSource = sourceByRef.get(nativeOccurrence.sourceRef);
      const provisionalPhysicalKey = provisionalSource
        ? [
            provisionalSource.documentRef,
            nativeOccurrence.canonicalRange.start,
            nativeOccurrence.canonicalRange.end,
            nativeOccurrence.quote,
          ].join("\u0000")
        : null;
      if (
        provisionalPhysicalKey !== null &&
        target.physicalOccurrences.has(provisionalPhysicalKey)
      ) {
        continue;
      }
      const resolved = await resolveEvidence({
        sourceRef: nativeOccurrence.sourceRef,
        quote: nativeOccurrence.quote,
        canonicalRange: nativeOccurrence.canonicalRange,
      });
      if (resolved.status !== "resolved") {
        rejections.push(
          rejection(nativeSeed.seedId, nativeOccurrence, resolved),
        );
        continue;
      }
      const sourceView = sourceByRef.get(nativeOccurrence.sourceRef);
      if (
        !sourceView ||
        !contextMatches(sourceView, nativeOccurrence, resolved.anchor)
      ) {
        rejections.push(
          rejection(nativeSeed.seedId, nativeOccurrence, "context-mismatch"),
        );
        continue;
      }
      const physicalKey = [
        resolved.anchor.documentRef,
        resolved.anchor.canonicalRange.start,
        resolved.anchor.canonicalRange.end,
        resolved.anchor.quote,
      ].join("\u0000");
      if (target.physicalOccurrences.has(physicalKey)) continue;
      target.physicalOccurrences.add(physicalKey);
      target.appearsAsProperName ||= nativeSeed.features.appearsAsProperName;
      const dialogue = occurrenceIsDialogue(
        dialogueByDocumentRef.get(resolved.anchor.documentRef) ?? [],
        resolved.anchor.canonicalRange.start,
      );
      target.appearsInDialogue ||= dialogue;
      target.appearsInNarration ||= !dialogue;
      if (target.occurrences.length === 0) {
        target.surface = nativeOccurrence.quote;
      }
      target.occurrences.push({
        sourceRef: nativeOccurrence.sourceRef,
        documentRef: resolved.anchor.documentRef,
        quote: nativeOccurrence.quote,
        canonicalRange: nativeOccurrence.canonicalRange,
        context: nativeOccurrence.context,
        evidence: resolved.anchor,
      });
    }
  }

  const seeds = [...merged.values()]
    .filter((seed) => seed.occurrences.length >= minimumOccurrenceCount)
    .map<EntityCandidateSeed>((seed) => ({
      seedId: seed.seedId,
      surface: seed.surface,
      normalizedSurface: seed.normalizedSurface,
      occurrences: seed.occurrences,
      features: {
        occurrenceCount: seed.occurrences.length,
        appearsAsProperName: seed.appearsAsProperName,
        appearsInDialogue: seed.appearsInDialogue,
        appearsInNarration: seed.appearsInNarration,
      },
    }));

  return freezeDeep({ status: "complete", seeds, rejections });
}
