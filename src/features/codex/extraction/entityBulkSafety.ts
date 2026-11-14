import type { BindCodexEntityPayload } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type {
  CodexEntityReviewProposal,
  CodexStructureCatalogSnapshot,
  CodexStructureExtractionReviewProjection,
} from "../codexStructureExtractionStore";
import {
  inspectExactEntityMatch,
  type ExistingEntityCatalogRecord,
} from "./existingEntityMatcher";
import { candidateKey } from "../codexCandidates";
import { isRelationalTerm } from "./relationalTerms";

/**
 * 完全一致の既存 Entry への結び付け（bind-existing）を、読まずに一括承認してよいかの判定。
 * 設計 docs/plans/nir1-identity-review-load-reduction-design-draft.md §3.2 の (a)(b)(c)(f)(g)(h)
 * と (e)。(d)（根拠が全件完全一致）は `evidenceExact` の旗が持つ。
 *
 * 判定の前提：`codex.entity.bind-existing` は Codex の行を書かない op（版と所属の検査だけ）で、
 * 別名の追加も要約の fill も無い結び付けだけがこの op に compile される（(c)）。
 * 別名の追加か要約の fill が 1 件でもあれば `codex.entry.patch` になり、Codex の行を書くので一括の対象外。
 */

/** 一括承認で通した完全一致の結び付けの印（decision の `decisionJson.source`）。 */
export const BULK_EXACT_BIND_DECISION_SOURCE = "bulk-exact-bind";

/** Apply の前に古い・条件が変わった結び付けを承認前へ戻したときの理由（`decisionJson.reason`）。 */
export const STALE_BIND_DECISION_REASON = "stale-bind";

/** 人物の型。`coarseClassForSlug` が person を返す slug はこれだけ。 */
export const PERSON_TYPE_SLUG = "character";

export type ExactBindDecline =
  /** 結び付けの種類が bind-existing でない。 */
  | "not-bind-existing"
  /** 別名の追加か要約の fill がある（patch になり、Codex の行を書く）。 */
  | "enrichment"
  /** 呼び名（続柄・二人称・三人称）に当たる表記。 */
  | "relational-term"
  /**
   * 表記が 1 字。1 字の名前は、語の一部だけが当たる他の Entry（蓮と蓮司）を照合が数えないので、
   * (h) の防御が働かない。読まずには通さない。
   */
  | "single-char"
  /** 結び先が名簿に無い（削除された・catalog に無い）。 */
  | "target-missing"
  /** 表記が結び先の名前・別名に完全一致しない（改名・別名の削除を含む）。 */
  | "no-exact-match"
  /** 完全一致が結び先以外にもある（名前が A・別名が B 等）。 */
  | "multiple-exact"
  /** 語の一部だけが当たる他の Entry がある。 */
  | "partial-other"
  /** 結び先の型が人物の型でない、または型を判定できない。 */
  | "type-not-person";

export type ExactBindVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExactBindDecline };

/** 判定に使う Entry。catalog（opaque ref）でも今の Codex（Entry id）でも同じ形に揃える。 */
interface BindTargetRecord {
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[] | string | null;
  /** 型の slug。判定できないとき null。 */
  readonly typeSlug: string | null;
}

/** 判定に使う Entry 群の索引。同じ参照では 1 回だけ作り、提案ごとの全 Entry の作り直しを避ける。 */
interface PreparedBindRecords {
  readonly byKey: ReadonlyMap<string, BindTargetRecord>;
  readonly asCatalog: readonly ExistingEntityCatalogRecord[];
}

function prepareBindRecords(
  records: readonly BindTargetRecord[],
): PreparedBindRecords {
  return {
    byKey: new Map(records.map((record) => [record.key, record] as const)),
    asCatalog: records.map((record) => ({
      ref: record.key,
      sourceKey: record.key,
      name: record.name,
      aliases: record.aliases,
      typeRef: "",
      expectedVersion: 0,
    })),
  };
}

function evaluateExactBind(
  payload: BindCodexEntityPayload,
  prepared: PreparedBindRecords,
  targetKey: string | null,
): ExactBindVerdict {
  const binding = payload.binding;
  if (binding.kind !== "bind-existing") {
    return { ok: false, reason: "not-bind-existing" };
  }
  if (
    binding.enrichment.aliasesToAdd.length > 0 ||
    payload.aliases.length > 0 ||
    binding.enrichment.summary.kind !== "leave"
  ) {
    return { ok: false, reason: "enrichment" };
  }
  if (isRelationalTerm(payload.canonicalName)) {
    return { ok: false, reason: "relational-term" };
  }
  if (Array.from(candidateKey(payload.canonicalName)).length < 2) {
    return { ok: false, reason: "single-char" };
  }
  const target = targetKey === null ? undefined : prepared.byKey.get(targetKey);
  if (!target) return { ok: false, reason: "target-missing" };

  const inspection = inspectExactEntityMatch(
    payload.canonicalName,
    prepared.asCatalog,
  );
  if (!inspection.exactRefs.includes(target.key)) {
    return { ok: false, reason: "no-exact-match" };
  }
  if (inspection.exactRefs.length !== 1) {
    return { ok: false, reason: "multiple-exact" };
  }
  if (inspection.partialOtherRefs.length > 0) {
    return { ok: false, reason: "partial-other" };
  }
  if (target.typeSlug !== PERSON_TYPE_SLUG) {
    return { ok: false, reason: "type-not-person" };
  }
  return { ok: true };
}

const preparedByCatalog = new WeakMap<
  CodexStructureCatalogSnapshot,
  PreparedBindRecords
>();
const preparedByEntries = new WeakMap<
  readonly CurrentCodexEntryRecord[],
  PreparedBindRecords
>();

function recordsFromCatalog(
  catalog: CodexStructureCatalogSnapshot,
): BindTargetRecord[] {
  const slugByTypeRef = new Map(
    catalog.types.map((type) => [type.ref, type.slug] as const),
  );
  return catalog.entities.map((entity) => ({
    key: entity.ref,
    name: entity.name,
    aliases: entity.aliases ?? [],
    typeSlug: slugByTypeRef.get(entity.typeRef) ?? null,
  }));
}

/**
 * run 時点の catalog だけで判定する（live・復元・編集後で同じ値になる）。
 * catalog の型は、型の一覧に無い type の Entry が先頭の型に落ちた形を区別できないので、
 * 決め手は {@link recheckExactBindAgainstEntries}（今の Codex の `entry.type`）。
 */
export function evaluateExactBindFromCatalog(
  payload: BindCodexEntityPayload,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
): ExactBindVerdict {
  if (payload.binding.kind !== "bind-existing") {
    return { ok: false, reason: "not-bind-existing" };
  }
  if (!catalog) return { ok: false, reason: "target-missing" };
  let prepared = preparedByCatalog.get(catalog);
  if (!prepared) {
    prepared = prepareBindRecords(recordsFromCatalog(catalog));
    preparedByCatalog.set(catalog, prepared);
  }
  return evaluateExactBind(payload, prepared, payload.binding.entityRef);
}

/** 今の Codex の Entry（`listCodexEntries` の行の必要な列）。 */
export interface CurrentCodexEntryRecord {
  readonly id: string;
  readonly name?: string | null;
  readonly aliases: string | null;
  readonly type: string;
  readonly version: number;
  /** 除外語（打ち手 1 の判定 (c) だけに使う。AI へは送らない）。読んでいなければ undefined。 */
  readonly excludedAliases?: string | null;
}

/**
 * 今の Codex の Entry を読み直して (b)(g)(h) を引き直す。run の後に同名の別 Entry が足された・
 * 結び先が改名・型変更・削除された場合をここで外す。結び先は catalog の `sourceKey`（Entry id）で引く。
 */
export function recheckExactBindAgainstEntries(
  payload: BindCodexEntityPayload,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
  entries: readonly CurrentCodexEntryRecord[],
): ExactBindVerdict {
  if (payload.binding.kind !== "bind-existing") {
    return { ok: false, reason: "not-bind-existing" };
  }
  const entityRef = payload.binding.entityRef;
  const targetKey =
    catalog?.entities.find((entity) => entity.ref === entityRef)?.sourceKey ??
    entityRef;
  // 同じ entries の配列（一括・Apply の前の検査のループ）では、索引と正規化済みのキーを使い回す。
  let prepared = preparedByEntries.get(entries);
  if (!prepared) {
    prepared = prepareBindRecords(
      entries.map((entry) => ({
        key: entry.id,
        name: entry.name ?? "",
        aliases: entry.aliases,
        typeSlug: entry.type || null,
      })),
    );
    preparedByEntries.set(entries, prepared);
  }
  return evaluateExactBind(payload, prepared, targetKey);
}

// ---------------------------------------------------------------------------
// 依存 (e)
// ---------------------------------------------------------------------------

/**
 * この実体を端点・依存に持つ関係・Phase・Base Detail の提案があるか。
 * 提案の状態は問わない（却下済み・already-satisfied も数える。保守側）。
 */
export function entitiesWithDependents(
  projection: Pick<
    CodexStructureExtractionReviewProjection,
    "proposals" | "relationProposals" | "baseDetailProposals" | "phaseProposals"
  >,
): ReadonlySet<string> {
  const narrativeIdByProposalId = new Map(
    projection.proposals.map((entity) => [
      entity.proposalId,
      entity.proposal.payload.narrativeEntityId,
    ]),
  );
  const out = new Set<string>();
  const mark = (narrativeEntityId: string | undefined) => {
    if (narrativeEntityId) out.add(narrativeEntityId);
  };
  const markDependencies = (
    dependencies: readonly { readonly proposalId: string }[] | undefined,
  ) => {
    for (const dependency of dependencies ?? []) {
      mark(narrativeIdByProposalId.get(dependency.proposalId));
    }
  };
  for (const relation of projection.relationProposals ?? []) {
    mark(relation.proposal.payload.subjectEntityId);
    mark(relation.proposal.payload.objectEntityId);
    markDependencies(relation.proposal.dependencies);
  }
  for (const detail of projection.baseDetailProposals ?? []) {
    mark(detail.proposal.payload.narrativeEntityId);
    markDependencies(detail.proposal.dependencies);
  }
  for (const phase of projection.phaseProposals ?? []) {
    mark(phase.proposal.payload.narrativeEntityId);
    markDependencies(phase.proposal.dependencies);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 旗の引き直し（projection 全体から）
// ---------------------------------------------------------------------------

const catalogVerdictCache = new WeakMap<
  BindCodexEntityPayload,
  WeakMap<CodexStructureCatalogSnapshot, boolean>
>();

function existingExactBindFromCatalog(
  payload: BindCodexEntityPayload,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
): boolean {
  if (payload.binding.kind !== "bind-existing" || !catalog) return false;
  let byCatalog = catalogVerdictCache.get(payload);
  if (!byCatalog) {
    byCatalog = new WeakMap();
    catalogVerdictCache.set(payload, byCatalog);
  }
  const cached = byCatalog.get(catalog);
  if (cached !== undefined) return cached;
  const value = evaluateExactBindFromCatalog(payload, catalog).ok;
  byCatalog.set(catalog, value);
  return value;
}

/**
 * 実体の提案の `existingExactBind`（静的な照合の旗）と `existingBindNoDependents`（(e)）を
 * projection 全体から引き直す。live・復元・候補を選んだ後・編集後の全部が同じ値になる。
 * 変わらない提案は同じ参照のまま返す。
 */
export function refreshEntityBindSafety<
  P extends Pick<
    CodexStructureExtractionReviewProjection,
    | "proposals"
    | "relationProposals"
    | "baseDetailProposals"
    | "phaseProposals"
    | "catalog"
  >,
>(projection: P): P {
  const withDependents = entitiesWithDependents(projection);
  let changed = false;
  const proposals = projection.proposals.map(
    (proposal): CodexEntityReviewProposal => {
      const existingExactBind = existingExactBindFromCatalog(
        proposal.proposal.payload,
        projection.catalog,
      );
      const existingBindNoDependents = !withDependents.has(
        proposal.proposal.payload.narrativeEntityId,
      );
      if (
        proposal.safety.existingExactBind === existingExactBind &&
        proposal.safety.existingBindNoDependents === existingBindNoDependents
      ) {
        return proposal;
      }
      changed = true;
      return {
        ...proposal,
        safety: {
          ...proposal.safety,
          existingExactBind,
          existingBindNoDependents,
        },
      };
    },
  );
  return changed ? { ...projection, proposals } : projection;
}
