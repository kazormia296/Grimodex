import { candidateKey } from "../codexCandidates";
import { parseAliases } from "../codexMatcher";
import { isRelationalTerm } from "./relationalTerms";
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

/** 表記の末尾の敬称（さん・様・先生 等）を 1 つだけ外す。外せなければそのまま。 */
export function stripHonorific(surface: string): string {
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
  exactOnly: boolean,
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
  // 関係の呼び名（姉ちゃん・あなた 等）は話し手で指す人が変わる。作者が名前・別名に
  // 入れた語の完全一致だけを残し、敬称除去・prefix・substring の候補は作らない。
  if (exactOnly) return { score, methods };
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
    const exactOnly = isRelationalTerm(surface);
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
        exactOnly,
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

/** {@link inspectExactEntityMatch} の結果。resolved／ambiguous の判定は変えない別の見方。 */
export interface ExactEntityMatchInspection {
  /** 名前または別名が完全一致した Entry（名前と別名を通した重複なしの一覧）。 */
  readonly exactRefs: readonly KnowledgeEntityRef[];
  /**
   * 完全一致していないが、語の一部だけが当たる他の Entry（敬称除去・prefix・substring）。
   * 姓だけの Entry と姓名の Entry が両方ある名簿で、姓だけの表記が前者に完全一致しても、
   * 後者がここに出る。呼び名の完全一致だけに狭める規則（{@link isRelationalTerm}）はかけず、
   * 常に全部の当たり方を見る。
   */
  readonly partialOtherRefs: readonly KnowledgeEntityRef[];
}

const entryKeyCache = new WeakMap<
  ExistingEntityCatalogRecord,
  { readonly entryNameKey: string; readonly aliasKeys: readonly string[] }
>();

/**
 * Entry の正規化済みの名前・別名キー。同じ record 参照では 1 回だけ作って使い回す
 * （一括の再検査が提案ごとに全 Entry の別名を JSON.parse し直さないため）。
 * 名前の無い Entry は、空文字列が全部の表記に prefix で当たってしまうので、名前側では
 * 何にも当たらないようにする（別名は別に数える）。matchExistingEntity は変えていない。
 */
function entryKeysOf(entry: ExistingEntityCatalogRecord): {
  readonly entryNameKey: string;
  readonly aliasKeys: readonly string[];
} {
  const cached = entryKeyCache.get(entry);
  if (cached) return cached;
  const keys = {
    entryNameKey: candidateKey(entry.name) || "\u0000",
    aliasKeys: parseAliases(
      entry.aliases as string[] | string | null | undefined,
    )
      .map(candidateKey)
      .filter((key) => key.length > 0),
  };
  entryKeyCache.set(entry, keys);
  return keys;
}

/**
 * 表記 1 つが名簿のどの Entry に当たるかを、{@link matchExistingEntity} と同じ走査で数える。
 * 一括承認の条件（完全一致が 1 Entry だけ・他に部分一致が無い）の判定に使う。
 * {@link matchExistingEntity} は名前に 1 件当たると別名の当たりを見ないので、
 * 「名前が A、別名が B」のような表記は resolved（A）のまま、ここでだけ該当 2 Entry になる。
 */
export function inspectExactEntityMatch(
  surface: string,
  catalog: readonly ExistingEntityCatalogRecord[],
): ExactEntityMatchInspection {
  const surfaceKey = candidateKey(surface);
  if (!surfaceKey) return { exactRefs: [], partialOtherRefs: [] };
  const strippedKey = candidateKey(stripHonorific(surface));
  const exactRefs: KnowledgeEntityRef[] = [];
  const partialOtherRefs: KnowledgeEntityRef[] = [];
  for (const entry of catalog) {
    const { entryNameKey, aliasKeys } = entryKeysOf(entry);
    const { methods } = scoreAgainstEntry(
      surfaceKey,
      strippedKey,
      entryNameKey,
      aliasKeys,
      false,
    );
    if (methods.length === 0) continue;
    if (methods.includes("exact-name") || methods.includes("exact-alias")) {
      if (!exactRefs.includes(entry.ref)) exactRefs.push(entry.ref);
    } else if (!partialOtherRefs.includes(entry.ref)) {
      partialOtherRefs.push(entry.ref);
    }
  }
  return { exactRefs, partialOtherRefs };
}
