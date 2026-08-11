import { candidateKey } from "../codexCandidates";
import { parseAliases } from "../codexMatcher";
import type {
  EntityBindingCandidate,
  EntityBindingMatchMethod,
  KnowledgeEntityRef,
  CodexEntityExistingResolution,
} from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";

/** Candidate generation threshold (spec §12). Auto-bind never uses this alone. */
export const EXISTING_ENTITY_CANDIDATE_SCORE_FLOOR = 80;

const HONORIFIC_SUFFIXES = [
  "さん",
  "様",
  "君",
  "くん",
  "ちゃん",
  "殿",
  "氏",
  "先生",
  "隊長",
  "殿方",
] as const;

export interface ExistingEntityCatalogRecord {
  /** Opaque catalog ref (K0001…). Never send sourceKey / DB id to the model. */
  readonly ref: KnowledgeEntityRef;
  /** Real DB / domain key — kept local to the runtime. */
  readonly sourceKey: string;
  readonly name: string;
  readonly aliases: readonly string[] | string | null;
  readonly typeRef: string;
  readonly expectedVersion: number;
}

export interface MatchExistingEntityInput {
  readonly surfaces: readonly string[];
  /** Explicit identity Observation that already names an opaque catalog ref. */
  readonly explicitIdentityRefs?: readonly KnowledgeEntityRef[];
}

function stripHonorific(surface: string): string {
  let value = surface.trim();
  for (const suffix of HONORIFIC_SUFFIXES) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      value = value.slice(0, -suffix.length).trim();
      break;
    }
  }
  return value;
}

function scoreAgainstEntry(
  surfaceKey: string,
  strippedKey: string,
  entryNameKey: string,
  aliasKeys: readonly string[],
): { score: number; methods: EntityBindingMatchMethod[] } {
  const methods: EntityBindingMatchMethod[] = [];
  let score = 0;

  if (surfaceKey.length > 0 && surfaceKey === entryNameKey) {
    methods.push("exact-name");
    score = Math.max(score, 100);
  }
  if (surfaceKey.length > 0 && aliasKeys.includes(surfaceKey)) {
    methods.push("exact-alias");
    score = Math.max(score, 95);
  }
  if (
    strippedKey.length > 0 &&
    strippedKey !== surfaceKey &&
    (strippedKey === entryNameKey || aliasKeys.includes(strippedKey))
  ) {
    methods.push("honorific-strip");
    score = Math.max(score, 85);
  }
  if (
    surfaceKey.length >= 2 &&
    (entryNameKey.startsWith(surfaceKey) ||
      surfaceKey.startsWith(entryNameKey) ||
      aliasKeys.some(
        (alias) => alias.startsWith(surfaceKey) || surfaceKey.startsWith(alias),
      ))
  ) {
    if (!methods.includes("exact-name") && !methods.includes("exact-alias")) {
      methods.push("prefix");
      score = Math.max(score, 75);
    }
  }
  if (
    surfaceKey.length >= 2 &&
    (entryNameKey.includes(surfaceKey) ||
      surfaceKey.includes(entryNameKey) ||
      aliasKeys.some(
        (alias) => alias.includes(surfaceKey) || surfaceKey.includes(alias),
      ))
  ) {
    if (
      !methods.includes("exact-name") &&
      !methods.includes("exact-alias") &&
      !methods.includes("prefix")
    ) {
      methods.push("substring");
      score = Math.max(score, 70);
    }
  }

  return { score, methods };
}

function mergeCandidate(
  map: Map<KnowledgeEntityRef, EntityBindingCandidate>,
  next: EntityBindingCandidate,
): void {
  const previous = map.get(next.ref);
  if (!previous) {
    map.set(next.ref, next);
    return;
  }
  const methods = Array.from(
    new Set([...previous.methods, ...next.methods]),
  ) as EntityBindingMatchMethod[];
  map.set(next.ref, {
    ref: next.ref,
    score: Math.max(previous.score, next.score),
    methods,
  });
}

/**
 * Existing Codex Entry matcher for Entity Identity auto-bind.
 *
 * Reuses name/alias scanning ideas from {@link createCodexMatcher} /
 * {@link candidateKey}, but auto-resolves ONLY on unique exact-name,
 * unique exact-alias, or explicit-identity. Honorific strip / prefix /
 * substring / embedding alone never auto-bind.
 */
export function matchExistingEntity(
  input: MatchExistingEntityInput,
  catalog: readonly ExistingEntityCatalogRecord[],
): CodexEntityExistingResolution {
  const explicit = [
    ...new Set(
      (input.explicitIdentityRefs ?? []).filter((ref) => ref.length > 0),
    ),
  ];
  if (explicit.length === 1) {
    const hit = catalog.find((entry) => entry.ref === explicit[0]);
    if (hit) {
      return {
        status: "resolved",
        ref: hit.ref,
        method: "explicit-identity",
      };
    }
  }
  if (explicit.length > 1) {
    const candidates = explicit
      .map((ref) => catalog.find((entry) => entry.ref === ref))
      .filter((entry): entry is ExistingEntityCatalogRecord => entry != null)
      .map((entry) => ({
        ref: entry.ref,
        score: 100,
        methods: ["explicit-identity" as const],
      }));
    if (candidates.length > 0) {
      return { status: "ambiguous", candidates };
    }
  }

  const exactNameHits = new Map<KnowledgeEntityRef, EntityBindingCandidate>();
  const exactAliasHits = new Map<KnowledgeEntityRef, EntityBindingCandidate>();
  const reviewCandidates = new Map<
    KnowledgeEntityRef,
    EntityBindingCandidate
  >();

  for (const surface of input.surfaces) {
    const surfaceKey = candidateKey(surface);
    if (!surfaceKey) continue;
    const strippedKey = candidateKey(stripHonorific(surface));

    for (const entry of catalog) {
      const entryNameKey = candidateKey(entry.name);
      const aliasKeys = parseAliases(
        entry.aliases as string[] | string | null | undefined,
      )
        .map(candidateKey)
        .filter((key) => key.length > 0);
      const { score, methods } = scoreAgainstEntry(
        surfaceKey,
        strippedKey,
        entryNameKey,
        aliasKeys,
      );
      if (methods.length === 0) continue;
      const candidate: EntityBindingCandidate = {
        ref: entry.ref,
        score,
        methods,
      };
      if (methods.includes("exact-name")) {
        mergeCandidate(exactNameHits, candidate);
      }
      if (methods.includes("exact-alias")) {
        mergeCandidate(exactAliasHits, candidate);
      }
      // Soft matches (honorific / prefix / substring) stay review-only.
      // Score floor still ranks probable candidates; exact hits always qualify.
      if (
        score >= EXISTING_ENTITY_CANDIDATE_SCORE_FLOOR ||
        methods.includes("exact-name") ||
        methods.includes("exact-alias") ||
        methods.includes("honorific-strip") ||
        methods.includes("prefix") ||
        methods.includes("substring")
      ) {
        mergeCandidate(reviewCandidates, candidate);
      }
    }
  }

  if (exactNameHits.size === 1) {
    const only = [...exactNameHits.values()][0]!;
    return { status: "resolved", ref: only.ref, method: "exact-name" };
  }
  if (exactNameHits.size > 1) {
    return {
      status: "ambiguous",
      candidates: [...exactNameHits.values()].sort((a, b) => b.score - a.score),
    };
  }

  if (exactAliasHits.size === 1) {
    const only = [...exactAliasHits.values()][0]!;
    return { status: "resolved", ref: only.ref, method: "exact-alias" };
  }
  if (exactAliasHits.size > 1) {
    return {
      status: "ambiguous",
      candidates: [...exactAliasHits.values()].sort(
        (a, b) => b.score - a.score,
      ),
    };
  }

  // Honorific / prefix / substring / embedding remain review-only.
  const soft = [...reviewCandidates.values()].filter(
    (candidate) =>
      !candidate.methods.includes("exact-name") &&
      !candidate.methods.includes("exact-alias") &&
      !candidate.methods.includes("explicit-identity"),
  );
  if (soft.length > 0) {
    return {
      status: "ambiguous",
      candidates: soft.sort((a, b) => b.score - a.score),
    };
  }

  return { status: "none" };
}
