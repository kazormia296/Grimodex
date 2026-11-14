import type { BindCodexEntityPayload } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import { candidateKey } from "../codexCandidates";
import { parseAliases } from "../codexMatcher";
import {
  inspectExactEntityMatch,
  stripHonorific,
  type ExistingEntityCatalogRecord,
} from "./existingEntityMatcher";
import { isRelationalTerm } from "./relationalTerms";

/**
 * 打ち手 1：作者が結び先を選んだ表記（提案の名前）を、確認つきで結び先の別名に残す。
 * 設計 docs/plans/nir1-identity-review-load-reduction-design-draft.md §4・§14。
 *
 * 状態は `binding.enrichment.aliasesToAdd` に表記が入っているかで表す（新しい列は無い）。
 * 足せるのは「敬称を外すと結び先の名前・別名に当たる表記」だけ（作者の確認 Q6）。
 */

export type SurfaceAliasDecline =
  /** 結び付けの種類が bind-existing でない。 */
  | "not-bind-existing"
  /** 表記が 2 字未満（照合は 2 字以上。短い表記は別の語の中でも強調される）。 */
  | "single-char"
  /** 呼び名（続柄・二人称・三人称）。 */
  | "relational-term"
  /** 結び先が名簿に無い。 */
  | "target-missing"
  /** 表記が結び先の名前・別名に既に一致する（足す意味が無い）。 */
  | "already-alias"
  /** 敬称を外しても結び先の名前・別名に当たらない（愛称・呼び方の違い・語の一部の一致は足さない）。 */
  | "not-honorific-form"
  /** 表記が別の Entry の名前・別名に完全一致する。 */
  | "exact-other"
  /** 表記が別の Entry の名前・別名と語の一部で当たる（次の照合が曖昧になる）。 */
  | "partial-other"
  /** 結び先の除外語が表記を含む（足しても効かない）。 */
  | "excluded"
  /** 同じ抽出に、同じ Entry へ別名・要約を書く提案が他にある（commit が丸ごと失敗する）。 */
  | "same-entry-patch";

export type SurfaceAliasVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SurfaceAliasDecline };

/** 判定に使う Entry。catalog（opaque ref）でも今の Codex（Entry id）でも同じ形に揃える。 */
export interface SurfaceAliasRecord {
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[] | string | null;
  /**
   * 除外語。undefined は「読んでいない」（run の catalog には無い）で、(c) を見ない。
   * 画面の表示はこの見込みで、チェックを入れる時・承認時・Apply の前は DB の値で見る。
   */
  readonly excludedAliases?: readonly string[] | string | null;
}

function keysOf(record: SurfaceAliasRecord): Set<string> {
  const keys = new Set<string>();
  const nameKey = candidateKey(record.name ?? "");
  if (nameKey) keys.add(nameKey);
  for (const alias of parseAliases(
    record.aliases as string[] | string | null | undefined,
  )) {
    const key = candidateKey(alias);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * 表記を結び先の別名に足してよいか（§4.2 の 4 の (a)(b)(b')(c)(d)(e) と Q6）。
 * 同じ抽出の他の提案との衝突（§4.2 の 5）は {@link hasOtherPatchOnSameEntry} が別に見る。
 */
export function evaluateSurfaceAlias(args: {
  readonly surface: string;
  readonly targetKey: string | null;
  readonly records: readonly SurfaceAliasRecord[];
}): SurfaceAliasVerdict {
  const surface = args.surface.trim();
  const surfaceKey = candidateKey(surface);
  if (Array.from(surfaceKey).length < 2) {
    return { ok: false, reason: "single-char" };
  }
  const stripped = stripHonorific(surface);
  if (isRelationalTerm(surface) || isRelationalTerm(stripped)) {
    return { ok: false, reason: "relational-term" };
  }
  const target =
    args.targetKey === null
      ? undefined
      : args.records.find((record) => record.key === args.targetKey);
  if (!target) return { ok: false, reason: "target-missing" };
  const targetKeys = keysOf(target);
  if (targetKeys.has(surfaceKey)) {
    return { ok: false, reason: "already-alias" };
  }
  const strippedKey = candidateKey(stripped);
  if (
    strippedKey === surfaceKey ||
    Array.from(strippedKey).length < 2 ||
    !targetKeys.has(strippedKey)
  ) {
    return { ok: false, reason: "not-honorific-form" };
  }
  const catalog: ExistingEntityCatalogRecord[] = args.records.map((record) => ({
    ref: record.key,
    sourceKey: record.key,
    name: record.name ?? "",
    aliases: record.aliases,
    typeRef: "",
    expectedVersion: 0,
  }));
  const inspection = inspectExactEntityMatch(surface, catalog);
  if (inspection.exactRefs.length > 0) {
    return { ok: false, reason: "exact-other" };
  }
  if (inspection.partialOtherRefs.some((ref) => ref !== target.key)) {
    return { ok: false, reason: "partial-other" };
  }
  if (target.excludedAliases !== undefined) {
    const excluded = parseAliases(
      target.excludedAliases as string[] | string | null | undefined,
    ).map(candidateKey);
    if (excluded.some((key) => key.length > 0 && key.includes(surfaceKey))) {
      return { ok: false, reason: "excluded" };
    }
  }
  return { ok: true };
}

function explicitAliasSurfaces(payload: BindCodexEntityPayload): Set<string> {
  return new Set(
    payload.aliases
      .filter((alias) => alias.status === "explicit")
      .map((alias) => alias.surface),
  );
}

/** 作者が足すと決めた表記の別名があるか（表記が aliasesToAdd に入り、AI の明示の別名ではない）。 */
export function hasSurfaceAlias(payload: BindCodexEntityPayload): boolean {
  const binding = payload.binding;
  if (binding.kind !== "bind-existing") return false;
  const surface = payload.canonicalName.trim();
  return (
    surface.length > 0 &&
    binding.enrichment.aliasesToAdd.includes(surface) &&
    !explicitAliasSurfaces(payload).has(surface)
  );
}

/**
 * aliasesToAdd に表記を足す／外す。AI の明示の別名と同じ表記なら外さない。
 * 表記（名前）を編集したときは、前の表記の印を外してから新しい名前で決め直す。
 */
export function withSurfaceAlias(
  payload: BindCodexEntityPayload,
  add: boolean,
  previousSurface: string = payload.canonicalName,
): BindCodexEntityPayload {
  const binding = payload.binding;
  if (binding.kind !== "bind-existing") return payload;
  const explicit = explicitAliasSurfaces(payload);
  const previous = previousSurface.trim();
  const surface = payload.canonicalName.trim();
  const kept = binding.enrichment.aliasesToAdd.filter(
    (alias) => explicit.has(alias) || (alias !== previous && alias !== surface),
  );
  const next =
    add && surface.length > 0 && !kept.includes(surface)
      ? [...kept, surface]
      : kept;
  if (
    next.length === binding.enrichment.aliasesToAdd.length &&
    next.every(
      (alias, index) => alias === binding.enrichment.aliasesToAdd[index],
    )
  ) {
    return payload;
  }
  return {
    ...payload,
    binding: {
      ...binding,
      enrichment: { ...binding.enrichment, aliasesToAdd: next },
    },
  };
}

/** 提案が compile で patch（Codex の行を書く）になるか。bind-existing のうち別名か要約を書くもの。 */
export function compilesToEntryPatch(payload: BindCodexEntityPayload): boolean {
  const binding = payload.binding;
  return (
    binding.kind === "bind-existing" &&
    (binding.enrichment.aliasesToAdd.length > 0 ||
      binding.enrichment.summary.kind !== "leave")
  );
}

/** 同じ Entry に向く提案の比較に使う最小の形。 */
export interface SameEntryProposalView {
  readonly proposalId: string;
  readonly status: string;
  readonly application?: unknown;
  readonly proposal: { readonly payload: BindCodexEntityPayload };
}

/**
 * 同じ抽出に、同じ Entry へ patch を書く他の提案があるか（§4.2 の 5、§14 の T1-1）。
 * 結び付けだけ（bind-existing のまま）の提案は妨げない（Apply が先に並べるので通る）。
 * 却下した提案と取り込み済みの提案は数えない。
 */
export function hasOtherPatchOnSameEntry(
  proposals: readonly SameEntryProposalView[],
  proposalId: string,
  entityRef: string,
): boolean {
  return proposals.some(
    (other) =>
      other.proposalId !== proposalId &&
      other.status !== "rejected" &&
      !other.application &&
      other.proposal.payload.binding.kind === "bind-existing" &&
      other.proposal.payload.binding.entityRef === entityRef &&
      compilesToEntryPatch(other.proposal.payload),
  );
}
