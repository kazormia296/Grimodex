import { hasLoneSurrogate } from "@/features/narrative-extraction/source/digest";
import type { CanonicalRange } from "@/features/narrative-extraction/source/types";
import { candidateKey } from "../codexCandidates";

export const ENTITY_SEED_SCHEMA_VERSION = 1 as const;
export const ENTITY_SEED_MAX_SOURCES = 900;
export const ENTITY_SEED_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const ENTITY_SEED_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const ENTITY_SEED_MAX_SEEDS = 10_000;
export const ENTITY_SEED_MAX_OCCURRENCES = 100_000;
export const ENTITY_SEED_MAX_REFERENCE_BYTES = 1_024;
export const ENTITY_SEED_MAX_QUOTE_LENGTH = 4_096;
export const ENTITY_SEED_CONTEXT_RADIUS = 64;

export interface EntitySeedCanonicalSourceV1 {
  readonly sourceRef: string;
  readonly documentRef: string;
  readonly documentRange: CanonicalRange;
  readonly text: string;
}

export interface ExtractCodexEntitySeedsRequestV1 {
  readonly schemaVersion: typeof ENTITY_SEED_SCHEMA_VERSION;
  readonly normalizerVersion: "gdx-canonical-text/1";
  readonly language: string;
  readonly minimumOccurrenceCount: number;
  readonly sources: readonly EntitySeedCanonicalSourceV1[];
}

export interface NativeEntitySeedOccurrenceV1 {
  readonly sourceRef: string;
  readonly quote: string;
  readonly canonicalRange: CanonicalRange;
  readonly context: {
    readonly prefix: string;
    readonly suffix: string;
  };
}

export interface NativeEntitySeedV1 {
  readonly seedId: string;
  readonly surface: string;
  readonly normalizedSurface: string;
  readonly occurrences: readonly NativeEntitySeedOccurrenceV1[];
  readonly features: {
    readonly occurrenceCount: number;
    readonly appearsAsProperName: boolean;
    readonly appearsInDialogue: boolean;
    readonly appearsInNarration: boolean;
  };
}

export interface ExtractCodexEntitySeedsResponseV1 {
  readonly schemaVersion: typeof ENTITY_SEED_SCHEMA_VERSION;
  readonly seeds: readonly NativeEntitySeedV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record).sort();
  const canonical = [...expected].sort();
  return (
    keys.length === canonical.length &&
    keys.every((key, index) => key === canonical[index])
  );
}

function validString(
  value: unknown,
  options: { readonly min: number; readonly max: number },
): value is string {
  return (
    typeof value === "string" &&
    value.length >= options.min &&
    value.length <= options.max &&
    !hasLoneSurrogate(value)
  );
}

function validReference(value: unknown): value is string {
  return (
    validString(value, {
      min: 1,
      max: ENTITY_SEED_MAX_REFERENCE_BYTES,
    }) &&
    !/\p{Cc}/u.test(value) &&
    new TextEncoder().encode(value).byteLength <=
      ENTITY_SEED_MAX_REFERENCE_BYTES
  );
}

function parseRange(value: unknown): CanonicalRange | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["start", "end"]) ||
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end)
  ) {
    return null;
  }
  const start = value.start as number;
  const end = value.end as number;
  if (start < 0 || end < start || end > 0xffff_ffff) return null;
  return { start, end };
}

function parseOccurrence(value: unknown): NativeEntitySeedOccurrenceV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sourceRef", "quote", "canonicalRange", "context"]) ||
    !validReference(value.sourceRef) ||
    !validString(value.quote, {
      min: 1,
      max: ENTITY_SEED_MAX_QUOTE_LENGTH,
    })
  ) {
    throw new TypeError("Invalid entity seed occurrence");
  }
  const canonicalRange = parseRange(value.canonicalRange);
  const context = value.context;
  if (
    canonicalRange === null ||
    canonicalRange.end - canonicalRange.start !== value.quote.length ||
    !isRecord(context) ||
    !hasExactKeys(context, ["prefix", "suffix"]) ||
    !validString(context.prefix, {
      min: 0,
      max: ENTITY_SEED_CONTEXT_RADIUS,
    }) ||
    !validString(context.suffix, {
      min: 0,
      max: ENTITY_SEED_CONTEXT_RADIUS,
    })
  ) {
    throw new TypeError("Invalid entity seed occurrence coordinates");
  }
  return {
    sourceRef: value.sourceRef,
    quote: value.quote,
    canonicalRange,
    context: { prefix: context.prefix, suffix: context.suffix },
  };
}

function parseSeed(
  value: unknown,
  occurrenceBudget: { count: number },
): NativeEntitySeedV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "seedId",
      "surface",
      "normalizedSurface",
      "occurrences",
      "features",
    ]) ||
    !validString(value.seedId, { min: 1, max: 256 }) ||
    !validString(value.surface, {
      min: 1,
      max: ENTITY_SEED_MAX_QUOTE_LENGTH,
    }) ||
    !validString(value.normalizedSurface, {
      min: 1,
      max: ENTITY_SEED_MAX_QUOTE_LENGTH,
    }) ||
    candidateKey(value.surface) !== value.normalizedSurface ||
    !Array.isArray(value.occurrences) ||
    value.occurrences.length === 0 ||
    !isRecord(value.features) ||
    !hasExactKeys(value.features, [
      "occurrenceCount",
      "appearsAsProperName",
      "appearsInDialogue",
      "appearsInNarration",
    ]) ||
    !Number.isSafeInteger(value.features.occurrenceCount) ||
    (value.features.occurrenceCount as number) < 0 ||
    typeof value.features.appearsAsProperName !== "boolean" ||
    typeof value.features.appearsInDialogue !== "boolean" ||
    typeof value.features.appearsInNarration !== "boolean"
  ) {
    throw new TypeError("Invalid entity seed response entry");
  }
  occurrenceBudget.count += value.occurrences.length;
  if (occurrenceBudget.count > ENTITY_SEED_MAX_OCCURRENCES) {
    throw new RangeError("Entity seed response has too many occurrences");
  }
  if (value.features.occurrenceCount !== value.occurrences.length) {
    throw new TypeError("Entity seed occurrence count does not match payload");
  }
  const occurrences = value.occurrences.map(parseOccurrence);
  if (
    occurrences.some(
      (occurrence) =>
        candidateKey(occurrence.quote) !== value.normalizedSurface,
    ) ||
    !occurrences.some((occurrence) => occurrence.quote === value.surface)
  ) {
    throw new TypeError("Entity seed surface is not grounded by an occurrence");
  }
  return {
    seedId: value.seedId,
    surface: value.surface,
    normalizedSurface: value.normalizedSurface,
    occurrences,
    features: {
      occurrenceCount: value.features.occurrenceCount as number,
      appearsAsProperName: value.features.appearsAsProperName,
      appearsInDialogue: value.features.appearsInDialogue,
      appearsInNarration: value.features.appearsInNarration,
    },
  };
}

/** Parse the Native wire strictly before any value enters the extraction IR. */
export function parseEntitySeedNativeResponse(
  value: unknown,
): ExtractCodexEntitySeedsResponseV1 {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("Entity seed response is not JSON-serializable", {
      cause: error,
    });
  }
  if (
    new TextEncoder().encode(encoded).byteLength >
    ENTITY_SEED_MAX_RESPONSE_BYTES
  ) {
    throw new RangeError("Entity seed response exceeds the wire limit");
  }
  const stableValue = JSON.parse(encoded) as unknown;
  if (
    !isRecord(stableValue) ||
    !hasExactKeys(stableValue, ["schemaVersion", "seeds"]) ||
    stableValue.schemaVersion !== ENTITY_SEED_SCHEMA_VERSION ||
    !Array.isArray(stableValue.seeds) ||
    stableValue.seeds.length > ENTITY_SEED_MAX_SEEDS
  ) {
    throw new TypeError("Invalid entity seed response envelope");
  }
  const occurrenceBudget = { count: 0 };
  const seedIds = new Set<string>();
  const normalizedSurfaces = new Set<string>();
  const seeds = stableValue.seeds.map((seedValue) => {
    const seed = parseSeed(seedValue, occurrenceBudget);
    if (seedIds.has(seed.seedId)) {
      throw new TypeError("Duplicate entity seed id");
    }
    if (normalizedSurfaces.has(seed.normalizedSurface)) {
      throw new TypeError("Duplicate normalized entity seed surface");
    }
    seedIds.add(seed.seedId);
    normalizedSurfaces.add(seed.normalizedSurface);
    return seed;
  });
  return { schemaVersion: ENTITY_SEED_SCHEMA_VERSION, seeds };
}
