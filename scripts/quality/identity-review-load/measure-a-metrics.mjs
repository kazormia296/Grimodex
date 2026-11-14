// 測定 A（構造抽出）の指標（事前登録 §5・§7）。純関数。入力は renderer.ts の extractStructure の rows
// （表記は hash だけ）と、名簿（repo 外の file を読んだもの）。出力は件数・ID・割合だけで、表記の文字列を持たない。
//
// 名簿の照合は (表記, 場面) → 実体。表記は製品の candidateKey で正規化し、sha256 先頭 16 桁の hash で突き合わせる
// （renderer の rows の keyHash と同じ式）。名簿にも敬称の対応表にも無い表記は「名簿に無い」（未判定）。
//
// 提案の分類（entity の提案だけ。重ならない。順に判定）：
//   0 notInRoster        名簿にも敬称の対応表にも無い（抽出のノイズ。種類別に件数だけ別枠）
//   1 unresolved…        binding が unresolved：
//       unresolvedCandidateIn   名簿の実体が候補に入っている（順位つき。同点は同順位）
//       unresolvedCandidateOut  候補に無い
//   2 typeNeeded         create-new で型が未解決（blocked）
//   3 bindCheck          bind-existing（1 件ずつ確かめる結び付け。AI なしの経路では完全一致だけ）
//   4 bulk               create-new で型が解決済みかつ一括承認可
//   5 manualCreate       残りの create-new
import { candidateKey, hashSurface } from "./lib.mjs";

export const CATEGORIES = Object.freeze([
  "notInRoster",
  "unresolvedCandidateIn",
  "unresolvedCandidateOut",
  "typeNeeded",
  "bindCheck",
  "bulk",
  "manualCreate",
]);

/** roster の type → Codex の型 slug（registerRoster に渡す型）。 */
export function codexTypeOf(rosterType) {
  if (rosterType === "character") return "character";
  if (rosterType === "location") return "location";
  return "lore";
}

/** 名簿の索引。表記の hash → 持ち主（名前・別名・敬称の対応表・場面で指す人が変わる表記）。 */
export async function buildRosterIndex(roster, hash = hashSurface) {
  const hashKey = (surface) => hash(candidateKey(surface));
  const entities = new Map();
  const names = new Map(); // keyHash → Set(entityId)
  const aliases = new Map();
  const honorific = new Map();
  const ambiguous = new Map(); // keyHash → Map(entityId → ranges)
  const push = (map, key, id) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(id);
  };
  for (const entity of roster.entities) {
    entities.set(entity.id, { id: entity.id, type: entity.type });
    if (typeof entity.name === "string")
      push(names, await hashKey(entity.name), entity.id);
    for (const alias of entity.aliases ?? [])
      if (typeof alias.surface === "string")
        push(aliases, await hashKey(alias.surface), entity.id);
    for (const surface of entity.honorificSurfaces ?? [])
      if (typeof surface === "string")
        push(honorific, await hashKey(surface), entity.id);
    for (const item of entity.ambiguousSurfaces ?? []) {
      if (typeof item.surface !== "string") continue;
      const key = await hashKey(item.surface);
      if (!ambiguous.has(key)) ambiguous.set(key, new Map());
      ambiguous.get(key).set(entity.id, item.sceneRanges ?? []);
    }
  }
  return { entities, names, aliases, honorific, ambiguous };
}

function inRanges(ranges, scene) {
  return ranges.some(([from, to]) => scene >= from && scene <= to);
}

/**
 * (表記, 場面) → 実体。
 * { kind: "entity", id, via, honorific } | { kind: "ambiguous", ids } | { kind: "unlisted" }
 * via：exact（名前・別名が 1 つの実体）／name-over-alias（名前が 1 件だけ一致）／scene-range（場面で指す人が変わる表記）／honorific。
 */
export function lookupRoster(index, keyHash, sceneIndexes) {
  const nameOwners = [...(index.names.get(keyHash) ?? [])];
  const aliasOwners = [...(index.aliases.get(keyHash) ?? [])].filter(
    (id) => !nameOwners.includes(id),
  );
  const allOwners = [...nameOwners, ...aliasOwners];
  const scenes = [...new Set(sceneIndexes)];
  const byRange = index.ambiguous.get(keyHash);
  if (byRange && scenes.length > 0) {
    const picked = new Set();
    for (const scene of scenes) {
      let found = null;
      for (const [id, ranges] of byRange)
        if (inRanges(ranges, scene)) {
          found = id;
          break;
        }
      if (found) picked.add(found);
      else for (const id of allOwners) picked.add(id);
    }
    if (picked.size === 1)
      return {
        kind: "entity",
        id: [...picked][0],
        via: "scene-range",
        honorific: false,
      };
    if (picked.size > 1) return { kind: "ambiguous", ids: [...picked] };
  }
  if (allOwners.length === 1)
    return { kind: "entity", id: allOwners[0], via: "exact", honorific: false };
  if (allOwners.length > 1) {
    if (nameOwners.length === 1)
      return {
        kind: "entity",
        id: nameOwners[0],
        via: "name-over-alias",
        honorific: false,
      };
    return { kind: "ambiguous", ids: allOwners };
  }
  const hon = [...(index.honorific.get(keyHash) ?? [])];
  if (hon.length === 1)
    return { kind: "entity", id: hon[0], via: "honorific", honorific: true };
  if (hon.length > 1) return { kind: "ambiguous", ids: hon };
  return { kind: "unlisted" };
}

const METHOD_STRENGTH = [
  ["exact-multiple", ["exact-name", "exact-alias", "explicit-identity"]],
  ["honorific-strip", ["honorific-strip"]],
  ["prefix", ["prefix"]],
  ["substring", ["substring"]],
];
/** unresolved の理由：候補の methods のうち最も強いもの。 */
export function unresolvedReason(candidates) {
  const all = new Set(candidates.flatMap((c) => c.methods ?? []));
  for (const [reason, methods] of METHOD_STRENGTH)
    if (methods.some((m) => all.has(m))) return reason;
  return "other";
}

/** 候補の順位（同点は同順位）。見つからなければ null。ids：名簿の実体（複数なら最良のもの）。 */
export function candidateRank(candidates, ids) {
  let best = null;
  for (const id of ids) {
    const hit = candidates.find((c) => c.id === id);
    if (!hit) continue;
    const rank = 1 + candidates.filter((c) => c.score > hit.score).length;
    if (best === null || rank < best) best = rank;
  }
  return best;
}

const PARTIAL = new Set(["prefix", "substring"]);

/** 1 行を分類する。 */
export function classifyRow(row, lookup, { bulkApprovable }) {
  if (lookup.kind === "unlisted") return { category: "notInRoster" };
  const ids = lookup.kind === "entity" ? [lookup.id] : lookup.ids;
  if (row.bindingKind === "unresolved") {
    const rank = candidateRank(row.candidates, ids);
    return rank === null
      ? { category: "unresolvedCandidateOut", rank: null }
      : { category: "unresolvedCandidateIn", rank };
  }
  if (row.bindingKind === "bind-existing") return { category: "bindCheck" };
  // create-new
  if (row.typeStatus !== "resolved") return { category: "typeNeeded" };
  if (bulkApprovable) return { category: "bulk" };
  return { category: "manualCreate" };
}

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

/**
 * 1 run の指標。
 * rows：renderer の extractStructure の rows（bulkApprovable を含む）。
 * 返り値は件数・ID・割合だけ。
 */
export function computeMeasureA({ index, rows }) {
  const categoryCounts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const notInRosterByKind = {};
  const reasons = {};
  const unlistedUnresolvedReasons = {};
  const rankCounts = { r1: 0, r2: 0, r3: 0, r4to10: 0, r11plus: 0 };
  const candidateCountDistribution = {};
  const partial = {
    unresolvedListed: 0,
    withPartialCandidate: 0,
    anyPartialWrong: 0,
    allPartialWrong: 0,
    partialSlots: 0,
    partialSlotsWrong: 0,
  };
  const mismatch = {
    wrongTarget: 0,
    leftoverCreateNew: 0,
    leftoverUnresolvedOut: 0,
    cleanupBulkOfKnownEntity: 0,
    typePersonOnNonCharacter: 0,
    typePersonOnNonCharacterInBulk: 0,
  };
  const collision = {
    ambiguousRows: 0,
    ambiguousByBinding: {},
    ambiguousBindTargetInSet: 0,
    nameOverAliasRows: 0,
    nameOverAliasByBinding: {},
    nameOverAliasBoundToNameOwner: 0,
    sceneRangeRows: 0,
    sceneRangeByBinding: {},
  };
  const honorific = {
    listedRows: 0,
    unresolvedByHonorificStrip: 0,
    unlistedUnresolvedByHonorificStrip: 0,
  };
  const entityKeysByCategory = {};
  let bulkTotal = 0;
  const proposalByBinding = {};
  const listedByBinding = {};

  for (const row of rows) {
    bump(proposalByBinding, row.bindingKind);
    const lookup = lookupRoster(
      index,
      row.keyHash,
      (row.scenes ?? []).map((pair) => pair[0]),
    );
    const bulkApprovable = Boolean(row.bulkApprovable);
    const cls = classifyRow(row, lookup, { bulkApprovable });
    categoryCounts[cls.category]++;
    if (cls.category === "notInRoster") {
      bump(notInRosterByKind, row.bindingKind);
      if (
        row.bindingKind === "unresolved" &&
        row.candidates.some((c) => (c.methods ?? []).includes("honorific-strip"))
      )
        honorific.unlistedUnresolvedByHonorificStrip++;
      if (row.bindingKind === "unresolved")
        bump(unlistedUnresolvedReasons, unresolvedReason(row.candidates));
      continue;
    }
    bump(listedByBinding, row.bindingKind);
    if (bulkApprovable && row.bindingKind === "create-new") bulkTotal++;
    const entityKey =
      lookup.kind === "entity"
        ? lookup.id
        : `ambiguous:${[...lookup.ids].sort().join("+")}`;
    (entityKeysByCategory[cls.category] ??= new Set()).add(entityKey);
    if (lookup.kind === "entity" && lookup.honorific) honorific.listedRows++;

    // 衝突・場面で指す人が変わる表記の挙動。
    if (lookup.kind === "ambiguous") {
      collision.ambiguousRows++;
      bump(collision.ambiguousByBinding, row.bindingKind);
      if (
        row.bindingKind === "bind-existing" &&
        lookup.ids.includes(row.bindExistingEntityId)
      )
        collision.ambiguousBindTargetInSet++;
    } else if (lookup.via === "name-over-alias") {
      collision.nameOverAliasRows++;
      bump(collision.nameOverAliasByBinding, row.bindingKind);
      if (
        row.bindingKind === "bind-existing" &&
        row.bindExistingEntityId === lookup.id
      )
        collision.nameOverAliasBoundToNameOwner++;
    } else if (lookup.via === "scene-range") {
      collision.sceneRangeRows++;
      bump(collision.sceneRangeByBinding, row.bindingKind);
    }

    if (row.bindingKind === "unresolved") {
      bump(reasons, unresolvedReason(row.candidates));
      bump(candidateCountDistribution, String(row.candidates.length));
      if (row.candidates.some((c) => (c.methods ?? []).includes("honorific-strip")))
        honorific.unresolvedByHonorificStrip++;
      if (cls.rank !== null && cls.rank !== undefined) {
        if (cls.rank === 1) rankCounts.r1++;
        else if (cls.rank === 2) rankCounts.r2++;
        else if (cls.rank === 3) rankCounts.r3++;
        else if (cls.rank <= 10) rankCounts.r4to10++;
        else rankCounts.r11plus++;
      }
      if (lookup.kind === "entity") {
        partial.unresolvedListed++;
        const partials = row.candidates.filter((c) =>
          (c.methods ?? []).some((m) => PARTIAL.has(m)),
        );
        if (partials.length > 0) {
          partial.withPartialCandidate++;
          const wrong = partials.filter((c) => c.id !== lookup.id);
          partial.partialSlots += partials.length;
          partial.partialSlotsWrong += wrong.length;
          if (wrong.length > 0) partial.anyPartialWrong++;
          if (wrong.length === partials.length) partial.allPartialWrong++;
        }
      }
      if (cls.category === "unresolvedCandidateOut" && lookup.kind === "entity")
        mismatch.leftoverUnresolvedOut++;
    }
    if (row.bindingKind === "bind-existing" && lookup.kind === "entity") {
      if (row.bindExistingEntityId !== lookup.id) mismatch.wrongTarget++;
    }
    if (row.bindingKind === "create-new" && lookup.kind === "entity") {
      mismatch.leftoverCreateNew++;
      if (cls.category === "bulk") mismatch.cleanupBulkOfKnownEntity++;
      const type = index.entities.get(lookup.id)?.type;
      if (row.coarseClass === "person" && type !== "character") {
        mismatch.typePersonOnNonCharacter++;
        if (cls.category === "bulk") mismatch.typePersonOnNonCharacterInBulk++;
      }
    }
  }

  // 操作の数（§7.1）。承認の下限と、表記を残す下限。entity の提案だけ。
  const surfaceUnit = {
    bulk: bulkTotal > 0 ? 1 : 0,
    bindCheck: categoryCounts.bindCheck,
    unresolvedCandidateIn: categoryCounts.unresolvedCandidateIn,
    unresolvedCandidateOut: categoryCounts.unresolvedCandidateOut,
    typeNeeded: categoryCounts.typeNeeded,
    manualCreate: categoryCounts.manualCreate,
  };
  const entityUnit = {
    bulk: bulkTotal > 0 ? 1 : 0,
    bindCheck: entityKeysByCategory.bindCheck?.size ?? 0,
    unresolvedCandidateIn: entityKeysByCategory.unresolvedCandidateIn?.size ?? 0,
    unresolvedCandidateOut:
      entityKeysByCategory.unresolvedCandidateOut?.size ?? 0,
    typeNeeded: entityKeysByCategory.typeNeeded?.size ?? 0,
    manualCreate: entityKeysByCategory.manualCreate?.size ?? 0,
  };
  const floors = (unit) => ({
    approval:
      unit.bulk +
      unit.bindCheck * 1 +
      unit.unresolvedCandidateIn * 2 +
      unit.unresolvedCandidateOut * 2 +
      unit.typeNeeded * 2 +
      unit.manualCreate * 1,
    keepSurface:
      unit.bulk +
      unit.bindCheck * 2 +
      unit.unresolvedCandidateIn * 3 +
      unit.unresolvedCandidateOut * 2 +
      unit.typeNeeded * 2 +
      unit.manualCreate * 1,
  });

  return {
    proposalCount: rows.length,
    proposalByBinding,
    listedByBinding,
    categoryCounts,
    notInRosterByKind,
    unresolved: {
      reasons,
      unlistedReasons: unlistedUnresolvedReasons,
      rankCounts,
      candidateCountDistribution,
    },
    partial,
    mismatch,
    collision,
    honorific,
    operations: {
      scope: "entity-proposals-only",
      fixedOperations: {
        open: 1,
        run: 1,
        apply: 1,
      },
      surfaceUnit: { counts: surfaceUnit, ...floors(surfaceUnit) },
      entityUnit: { counts: entityUnit, ...floors(entityUnit) },
    },
    // restore 列（DB から組み直した reviewPayload の再計算）は保存経路が使えるまで出せない。
    restoreColumn: "not-available",
  };
}

// ---- run 間の比較 -----------------------------------------------------------

/** 表記×提案の種類の集合（提案 id・scene id は run ごとに変わるので比べない）。 */
export function surfaceKindSet(rows) {
  return new Set(rows.map((row) => `${row.keyHash}:${row.bindingKind}`));
}

export function compareSets(left, right) {
  let both = 0;
  for (const key of left) if (right.has(key)) both++;
  return {
    left: left.size,
    right: right.size,
    both,
    leftOnly: left.size - both,
    rightOnly: right.size - both,
    equal: left.size === right.size && both === left.size,
  };
}

/**
 * ★8 の参考値：累積の列（同じ workspace、決定なし）で、前の回の未 review の提案が最新の run に
 * 同じ表記で残る件数と、各表記が未 review のまま何 run 分たまるか。seed の安定性で、
 * 作者が 1 回決めた後の再抽出での繰り返しではない（「上限」とは呼ばない）。
 * runs：[{ label, rows }]（古い順）。未 review は row.status === "unreviewed"。
 */
export function carryOverStability(runs) {
  const unreviewed = runs.map(
    (run) =>
      new Map(
        run.rows
          .filter((row) => row.status === "unreviewed")
          .map((row) => [row.keyHash, row.bindingKind]),
      ),
  );
  const last = unreviewed.at(-1) ?? new Map();
  const perRun = unreviewed.slice(0, -1).map((map, i) => {
    let sameSurface = 0;
    let sameSurfaceAndKind = 0;
    for (const [key, kind] of map) {
      if (last.has(key)) {
        sameSurface++;
        if (last.get(key) === kind) sameSurfaceAndKind++;
      }
    }
    return {
      label: runs[i].label,
      unreviewed: map.size,
      remainingInLatestSameSurface: sameSurface,
      remainingInLatestSameSurfaceAndKind: sameSurfaceAndKind,
    };
  });
  const runsPerSurface = new Map();
  for (const map of unreviewed)
    for (const key of map.keys())
      runsPerSurface.set(key, (runsPerSurface.get(key) ?? 0) + 1);
  const pileUp = {};
  for (const count of runsPerSurface.values()) bump(pileUp, String(count));
  return {
    runCount: runs.length,
    perRun,
    surfacesByRunsUnreviewed: pileUp,
    note: "seed-stability-not-reauthoring",
  };
}
