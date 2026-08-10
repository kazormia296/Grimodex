import type { RawEvidenceReference } from "@/features/narrative-extraction/evidence/types";
import type { NarrativeAssertionContext } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type {
  CoarseEntityClass,
  EntityIdentityObservation,
  EntityIdentityPayload,
  EntityMentionForm,
  EntityMentionObservation,
  EntityMentionPayload,
  EntityReference,
} from "@/features/narrative-extraction/ir/observations/entityIdentity";

const MENTION_FORMS: readonly EntityMentionForm[] = [
  "proper-name",
  "alias",
  "title",
  "description",
  "pronoun",
  "collective",
  "implicit",
] as const;

const COARSE_CLASSES: readonly CoarseEntityClass[] = [
  "person",
  "place",
  "organization",
  "item",
  "concept",
  "other",
  "unknown",
] as const;

const TEMPORAL_MODES = [
  "timeless",
  "current",
  "historical",
  "unknown",
] as const;

const NARRATIVE_FRAMES = [
  "story-world",
  "flashback",
  "dream",
  "reported",
  "hypothetical",
  "unknown",
] as const;

const GRAMMATICAL_ROLES = [
  "subject",
  "object",
  "possessor",
  "recipient",
  "speaker",
  "addressee",
  "other",
] as const;

export interface NormalizeEntityObservationsOptions {
  readonly allowedSourceRefs: ReadonlySet<string>;
  readonly createId?: () => string;
}

export interface NormalizedEntityObservations {
  readonly mentions: readonly EntityMentionObservation[];
  readonly identities: readonly EntityIdentityObservation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function parseEvidence(
  value: unknown,
  allowedSourceRefs: ReadonlySet<string>,
): RawEvidenceReference | null {
  if (!isRecord(value)) return null;
  if (typeof value.sourceRef !== "string" || value.sourceRef.length === 0) {
    return null;
  }
  if (!allowedSourceRefs.has(value.sourceRef)) return null;
  if (typeof value.quote !== "string" || value.quote.length === 0) return null;
  return {
    sourceRef: value.sourceRef,
    quote: value.quote,
    ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}),
    ...(typeof value.suffix === "string" ? { suffix: value.suffix } : {}),
  };
}

function parseAssertion(value: unknown): NarrativeAssertionContext | null {
  if (!isRecord(value)) return null;
  const attribution = value.attribution;
  if (
    attribution !== "narrator" &&
    attribution !== "unknown" &&
    !(typeof attribution === "string" && attribution.startsWith("character:"))
  ) {
    return null;
  }
  if (!isOneOf(value.narrativeFrame, NARRATIVE_FRAMES)) return null;
  return {
    attribution: attribution as NarrativeAssertionContext["attribution"],
    narrativeFrame: value.narrativeFrame,
  };
}

function parseEntityReference(value: unknown): EntityReference | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "local") {
    if (typeof value.localId !== "string" || value.localId.trim().length === 0) {
      return null;
    }
    return { kind: "local", localId: value.localId.trim() };
  }
  if (value.kind === "surface") {
    if (typeof value.surface !== "string" || value.surface.trim().length === 0) {
      return null;
    }
    return { kind: "surface", surface: value.surface.trim() };
  }
  return null;
}

function parseMentionPayload(value: unknown): EntityMentionPayload | null {
  if (!isRecord(value)) return null;
  if (!isOneOf(value.mentionForm, MENTION_FORMS)) return null;
  const surface =
    value.surface === null
      ? null
      : typeof value.surface === "string"
        ? value.surface.trim() || null
        : null;
  if (
    surface === null &&
    value.mentionForm !== "pronoun" &&
    value.mentionForm !== "implicit" &&
    value.mentionForm !== "collective"
  ) {
    // proper-name / alias / title / description need a surface on Evidence.
    if (typeof value.surface !== "string" || value.surface.trim().length === 0) {
      return null;
    }
  }
  if (!Array.isArray(value.entityClassHints)) return null;
  const entityClassHints = value.entityClassHints.filter(
    (hint): hint is CoarseEntityClass => isOneOf(hint, COARSE_CLASSES),
  );
  const referent = parseEntityReference(value.referent);
  if (!referent) return null;
  const grammaticalRole = isOneOf(value.grammaticalRole, GRAMMATICAL_ROLES)
    ? value.grammaticalRole
    : undefined;
  return {
    surface:
      typeof value.surface === "string" ? value.surface.trim() || null : null,
    mentionForm: value.mentionForm,
    entityClassHints,
    referent,
    ...(grammaticalRole ? { grammaticalRole } : {}),
  };
}

function parseIdentityPayload(value: unknown): EntityIdentityPayload | null {
  if (!isRecord(value)) return null;
  const subject = parseEntityReference(value.subject);
  if (!subject) return null;
  if (!isOneOf(value.temporalMode, TEMPORAL_MODES)) return null;
  if (!isRecord(value.identity) || typeof value.identity.kind !== "string") {
    return null;
  }
  if (
    value.identity.kind === "alias" ||
    value.identity.kind === "renamed-to"
  ) {
    if (
      typeof value.identity.surface !== "string" ||
      value.identity.surface.trim().length === 0
    ) {
      return null;
    }
    return {
      subject,
      identity: {
        kind: value.identity.kind,
        surface: value.identity.surface.trim(),
      },
      temporalMode: value.temporalMode,
    };
  }
  if (value.identity.kind === "same-as") {
    const other = parseEntityReference(value.identity.other);
    if (!other) return null;
    return {
      subject,
      identity: { kind: "same-as", other },
      temporalMode: value.temporalMode,
    };
  }
  return null;
}

function asObservationList(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw[key])) return raw[key] as unknown[];
  if (isRecord(raw) && Array.isArray(raw.observations)) {
    return raw.observations as unknown[];
  }
  return [];
}

/**
 * Normalize raw LLM entity mention + identity observations.
 * Drops rows with unknown source refs or invalid structure.
 */
export function normalizeEntityObservations(
  raw: unknown,
  options: NormalizeEntityObservationsOptions,
): NormalizedEntityObservations {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const mentionRows = asObservationList(
    isRecord(raw) && raw.mentions !== undefined ? raw.mentions : raw,
    "mentions",
  );
  const identityRows = isRecord(raw)
    ? asObservationList(raw.identities ?? [], "identities")
    : [];

  const mentions: EntityMentionObservation[] = [];
  for (const row of mentionRows) {
    if (!isRecord(row)) continue;
    if (
      row.kind !== undefined &&
      row.kind !== "entity-mention" &&
      row.kind !== "mention"
    ) {
      continue;
    }
    if (!Array.isArray(row.evidence)) continue;
    const evidence = row.evidence
      .map((item) => parseEvidence(item, options.allowedSourceRefs))
      .filter((item): item is RawEvidenceReference => item !== null);
    if (evidence.length === 0) continue;
    const assertion = parseAssertion(row.assertion) ?? {
      attribution: "narrator" as const,
      narrativeFrame: "story-world" as const,
    };
    const payload = parseMentionPayload(row.payload ?? row);
    if (!payload) continue;
    const localId =
      typeof row.localId === "string" && row.localId.trim().length > 0
        ? row.localId.trim()
        : createId();
    mentions.push({
      localId,
      kind: "entity-mention",
      evidence,
      assertion,
      payload,
    });
  }

  const identities: EntityIdentityObservation[] = [];
  for (const row of identityRows) {
    if (!isRecord(row)) continue;
    if (
      row.kind !== undefined &&
      row.kind !== "entity-identity" &&
      row.kind !== "identity"
    ) {
      continue;
    }
    if (!Array.isArray(row.evidence)) continue;
    const evidence = row.evidence
      .map((item) => parseEvidence(item, options.allowedSourceRefs))
      .filter((item): item is RawEvidenceReference => item !== null);
    if (evidence.length === 0) continue;
    const assertion = parseAssertion(row.assertion) ?? {
      attribution: "narrator" as const,
      narrativeFrame: "story-world" as const,
    };
    const payload = parseIdentityPayload(row.payload ?? row);
    if (!payload) continue;
    const localId =
      typeof row.localId === "string" && row.localId.trim().length > 0
        ? row.localId.trim()
        : createId();
    identities.push({
      localId,
      kind: "entity-identity",
      evidence,
      assertion,
      payload,
    });
  }

  return { mentions, identities };
}
