// 測定 A（構造抽出）の指標（事前登録 §5・§7）。純関数。入力は renderer.ts の extractStructure の rows
// （表記は hash だけ）と、名簿（repo 外の file を読んだもの）。出力は件数・ID・割合だけで、表記の文字列を持たない。
//
// 名簿の照合は (表記, 場面) → 実体。表記は製品の candidateKey で正規化し、sha256 先頭 16 桁の hash で突き合わせる
// （renderer の rows の keyHash と同じ式）。名簿にも敬称の対応表にも無い表記は「名簿に無い」（未判定）。
//
// 提案の分類（entity の提案だけ。重ならない。順に判定）：
//   0 notInRoster        名簿にも敬称の対応表にも無い（抽出のノイズ。種類別に件数だけ別枠）
//   0' relational        名簿の「関係の呼び名」（relationalSurfaces。続柄・二人称・三人称の呼び方）。
//                        Codex には登録しない別の種類で、0 とも 1〜5 とも別の枠に数える
//                        （提案の数と binding の内訳だけ。操作の下限・listedByBinding には入れない）
//   1 unresolved…        binding が unresolved：
//       unresolvedCandidateIn   名簿の実体が候補に入っている（順位つき。同点は同順位）
//       unresolvedCandidateOut  候補に無い
//   2 typeNeeded         create-new で型が未解決（blocked）
//   3 bindCheck          bind-existing のうち、製品の一括承認の対象でないもの（1 件ずつ確かめる結び付け。
//                        AI なしの経路では完全一致だけ）
//   3' bulkBind          bind-existing のうち、製品の一括承認の対象のもの（row.bulkApprovable。完全一致・結び先が人物・
//                        2 字以上・呼び名でない・他に部分一致の Entry が無い・別名／要約の追加が無い・依存提案が無い・
//                        根拠が全件完全一致。renderer が製品の isSafeForCodexEntityBulkApprove で旗を出す）
//   4 bulk               create-new で型が解決済みかつ一括承認可
//   5 manualCreate       残りの create-new
// 一括承認（ボタン 1 回）で通るのは bulk と bulkBind の合計（bulkTotal）。bulk は create-new 専用のまま
// （mismatch.cleanupBulkOfKnownEntity などが create-new を前提にする）。
import assert from "node:assert/strict";
import { candidateKey, hashSurface } from "./lib.mjs";

/**
 * 測定 A の指標の定義の版。computeMeasureA の出力に載せ、aggregate は版が混ざった入力を止める
 * （旧 records は版なし＝"legacy" として扱い、新しい版と混ぜて集計しない）。定義を変えたら上げる。
 *   "legacy"   版の欄が無い records（bindCheck に一括承認可の結び付けを含む・aliasButtons に呼び名を含む定義）。
 *   "a-defs/2" 一括承認の結び付け（bulkBind）を別分類にし、wrongTargetInBulk が名簿の「結び先が 1 つに定まらない表記」
 *              への一括の結び付けも危険として数え、保存済みの未 review を前の回／未採用の run／作者に見える run で分ける。
 *   "a-defs/3" 一括の create-new が名簿の外（ノイズ・関係の呼び名）と結び先が 1 つに定まらない表記に向く件数と、既知の実体への
 *              一括の create-new の件数を合わせた「一括 1 回で誤った Entry ができる件数」（mismatch.bulkCreateWrongEntry）を足し、
 *              関係の呼び名の unresolved のうち部分一致の候補があるもの（作者に unresolved の提案として出る）を別に数える
 *              （relational.unresolvedWithPartialCandidate）。操作の下限（承認の下限・表記を残す下限）の定義は a-defs/2 から変えない。
 *   "a-defs/4" 事前登録 DR-ILM-38 の列（identityColumns）を足す：Ur-all（bindingKind が unresolved の提案の数）・Ur-rosterTarget
 *              （その分類 1 の unresolvedCandidateIn と unresolvedCandidateOut の和）・S5-roster（名簿の場面で指す人が変わる表記の、
 *              重複を除いた数）・S5_seen（その表記のうち提案に出たもの）・S5 の内訳（seed に出ない／seed に出るが提案に出ない／提案に出る、
 *              と候補画面の候補）。a-defs/3 の records には無いので混ぜない。既存の指標の定義は a-defs/3 から変えない。
 */
export const METRIC_DEFINITION_VERSION = "a-defs/4";

export const CATEGORIES = Object.freeze([
  "notInRoster",
  "relational",
  "unresolvedCandidateIn",
  "unresolvedCandidateOut",
  "typeNeeded",
  "bindCheck",
  "bulkBind",
  "bulk",
  "manualCreate",
]);

/** 一括承認可の行が入ってよい分類（名簿の外の 2 つは分類の前に抜かれる）。 */
const BULK_ALLOWED_CATEGORIES = new Set([
  "bulk",
  "bulkBind",
  "notInRoster",
  "relational",
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
  const relational = new Map(); // 関係の呼び名（登録しない。keyHash → Set(entityId)）
  const ambiguous = new Map(); // keyHash → Map(entityId → ranges)
  // 名簿の「場面で指す人が変わる表記」の、重複を除いた hash 集合（S5-roster。DR-ILM-38）。表記そのままの hash
  // （renderer の提案の surfaceHash・seed の hash と同じ式。candidateKey で正規化しない）。実体ごとの配列の重複は 1 件に畳む。
  const s5Hashes = new Set();
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
    for (const surface of entity.relationalSurfaces ?? [])
      if (typeof surface === "string")
        push(relational, await hashKey(surface), entity.id);
    for (const item of entity.ambiguousSurfaces ?? []) {
      if (typeof item.surface !== "string") continue;
      // S5 の hash は「表記そのまま」の空間（rows の surfaceHash・renderer の seed と同じ）。候補キー（NFC・小文字・trim）では畳まない：
      // 大文字小文字・NFC だけ違う別の形は 2 件に数え、S5_seen でも一致しない（日本語の作品では起きにくい。試験で固定）。
      s5Hashes.add(await hash(item.surface));
      const key = await hashKey(item.surface);
      if (!ambiguous.has(key)) ambiguous.set(key, new Map());
      ambiguous.get(key).set(entity.id, item.sceneRanges ?? []);
    }
  }
  return {
    entities,
    names,
    aliases,
    honorific,
    relational,
    ambiguous,
    s5Hashes,
  };
}

function inRanges(ranges, scene) {
  return ranges.some(([from, to]) => scene >= from && scene <= to);
}

/**
 * (表記, 場面) → 実体。
 * { kind: "entity", id, via, honorific } | { kind: "ambiguous", ids } | { kind: "relational", ids } | { kind: "unlisted" }
 * via：exact（名前・別名が 1 つの実体）／name-over-alias（名前が 1 件だけ一致）／scene-range（場面で指す人が変わる表記）／honorific。
 * relational：名簿の関係の呼び名（ids は指しうる実体の一覧）。名前・別名・場面依存の表記として引けなかった表記だけが
 * 当たる（登録した名前・別名として製品が結ぶ表記は、そちらを優先する）。敬称の対応表より先に判定する。
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
  const rel = [...(index.relational?.get(keyHash) ?? [])];
  if (rel.length > 0) return { kind: "relational", ids: rel };
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
  if (lookup.kind === "relational") return { category: "relational" };
  const ids = lookup.kind === "entity" ? [lookup.id] : lookup.ids;
  if (row.bindingKind === "unresolved") {
    const rank = candidateRank(row.candidates, ids);
    return rank === null
      ? { category: "unresolvedCandidateOut", rank: null }
      : { category: "unresolvedCandidateIn", rank };
  }
  if (row.bindingKind === "bind-existing")
    return { category: bulkApprovable ? "bulkBind" : "bindCheck" };
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
 * seedDrops：renderer が返す、製品が planner の前段で seed を落とした件数（件数だけ。表記は持たない）。
 * 受け取った値を加工せず metrics.seedDrops に記録する（無ければ null）。
 * s5Breakdown：renderer が classifyS5Surfaces で数えた S5-roster の内訳（件数だけ。無ければ null＝未計測。
 * seed が読めない run・欄の無い renderer）。ここでは rows から数えた S5_seen と突き合わせ、食い違えば止める。
 * 返り値は件数・ID・割合だけ。
 */
export function computeMeasureA({
  index,
  rows,
  seedDrops = null,
  s5Breakdown = null,
}) {
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
    // 一括承認の対象の結び付けで、結び先が違う（または定まらない）危険のあるもの。次の 2 つの合計：
    //   wrongTargetInBulkEntity  名簿が 1 つの実体に定める表記に、製品が一括で別の実体へ結ぶもの
    //   bulkBindOnAmbiguous      名簿で結び先が 1 つに定まらない表記（lookup が ambiguous：場面で指す人が変わる表記・
    //                            別名の衝突・敬称が複数の実体にある表記の 3 種）に、製品が一括で結んだもの
    //                            （結び先が集合の中でも外でも数える。黙って別人に結ぶ最も危険な型。3 種は分けて数えない）
    wrongTargetInBulk: 0,
    wrongTargetInBulkEntity: 0,
    bulkBindOnAmbiguous: 0,
    bulkBindOnAmbiguousOutOfSet: 0, // うち結び先が名簿の指しうる実体の集合の外
    leftoverCreateNew: 0,
    leftoverUnresolvedOut: 0,
    cleanupBulkOfKnownEntity: 0,
    typePersonOnNonCharacter: 0,
    typePersonOnNonCharacterInBulk: 0,
    // 一括承認（ボタン 1 回）で、名簿が正しい Entry と認めない（または認める Entry が既にある）create-new が通る件数。
    // 操作の下限（bulkTotal）からは名簿の外の行を外したまま（§7.1 の別枠）、危険の側に数える：
    //   notInRoster   名簿にも敬称の対応表にも無い表記（ノイズ）への一括の create-new
    //   relational    関係の呼び名（Codex に登録しない種類）への一括の create-new
    //   ambiguous     名簿で結び先が 1 つに定まらない表記（別名の衝突・場面で指す人が変わる表記・敬称が複数）への一括の create-new
    //   outsideRoster 上の 3 つの合計（名簿の外・結び先が定まらない表記）
    //   knownEntity   名簿が 1 つの実体に定める表記への一括の create-new（＝ cleanupBulkOfKnownEntity。後始末の重複）
    //   total         outsideRoster ＋ knownEntity
    bulkCreateWrongEntry: {
      notInRoster: 0,
      relational: 0,
      ambiguous: 0,
      outsideRoster: 0,
      knownEntity: 0,
      total: 0,
    },
  };
  const relationalByBinding = {};
  // 関係の呼び名の unresolved のうち、部分一致（prefix・substring）の候補があるもの。製品は部分一致の候補がある呼び名を
  // 落とさず（status none のときだけ落とす）、unresolved の提案として作者に出す。操作の下限には入れない（別枠のまま）。
  let relationalUnresolvedWithPartialCandidate = 0;
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
  // unresolvedWithHonorificStripCandidate は「候補のどれかに honorific-strip がある」行の数で、
  // reasons（最も強い methods 1 つで排他に分類）とは別の数え方。exact-multiple と重なる行が両方に入りうる。
  const honorific = {
    listedRows: 0,
    unresolvedWithHonorificStripCandidate: 0,
    unlistedUnresolvedByHonorificStrip: 0,
  };
  const entityKeysByCategory = {};
  let bulkTotal = 0;
  // 一括承認可（row.bulkApprovable）の全行の内訳。renderer の counts.bulkApprovable は全行を数えるので、
  // notInRoster・relational に入った行も含めて合計を取り、同じ run で renderer の数と一致することを呼び側が確かめる。
  const bulkApprovableAudit = {
    total: 0,
    byCategory: {},
    byBinding: {},
    unexpectedBinding: 0, // 一括承認可なのに create-new・bind-existing でない行（製品の旗の定義上は 0）
    // 一括承認可なのに bulk・bulkBind でも、名簿の外（notInRoster・relational）でもない分類に入った行
    // （分類が製品の一括承認の対象を取りこぼしている印。0 のはず）。
    outsideBulkCategories: 0,
  };
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
    if (bulkApprovable) {
      bulkApprovableAudit.total++;
      bump(bulkApprovableAudit.byCategory, cls.category);
      bump(bulkApprovableAudit.byBinding, row.bindingKind);
      if (
        row.bindingKind !== "create-new" &&
        row.bindingKind !== "bind-existing"
      )
        bulkApprovableAudit.unexpectedBinding++;
      if (!BULK_ALLOWED_CATEGORIES.has(cls.category))
        bulkApprovableAudit.outsideBulkCategories++;
    }
    // 一括承認可の create-new（ボタン 1 回で Entry が作られる提案）。名簿の外の 2 分類は下で `continue` で抜けるので、
    // 抜ける前に数える（抜けた後では一括 1 回の危険が表から消える）。
    const bulkCreate = bulkApprovable && row.bindingKind === "create-new";
    if (cls.category === "notInRoster") {
      if (bulkCreate) mismatch.bulkCreateWrongEntry.notInRoster++;
      bump(notInRosterByKind, row.bindingKind);
      if (
        row.bindingKind === "unresolved" &&
        row.candidates.some((c) =>
          (c.methods ?? []).includes("honorific-strip"),
        )
      )
        honorific.unlistedUnresolvedByHonorificStrip++;
      if (row.bindingKind === "unresolved")
        bump(unlistedUnresolvedReasons, unresolvedReason(row.candidates));
      continue;
    }
    if (cls.category === "relational") {
      // 関係の呼び名が作る提案。名簿の実体の提案とは別枠（listedByBinding・操作の下限に入れない）。
      bump(relationalByBinding, row.bindingKind);
      if (
        row.bindingKind === "unresolved" &&
        (row.candidates ?? []).some((c) =>
          (c.methods ?? []).some((m) => PARTIAL.has(m)),
        )
      )
        relationalUnresolvedWithPartialCandidate++;
      if (bulkCreate) mismatch.bulkCreateWrongEntry.relational++;
      continue;
    }
    bump(listedByBinding, row.bindingKind);
    if (cls.category === "bulk" || cls.category === "bulkBind") bulkTotal++;
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
      if (bulkCreate) mismatch.bulkCreateWrongEntry.ambiguous++;
      if (
        row.bindingKind === "bind-existing" &&
        lookup.ids.includes(row.bindExistingEntityId)
      )
        collision.ambiguousBindTargetInSet++;
      // 一括承認の結び付け（bulkBind）が、名簿で結び先が 1 つに定まらない表記（ambiguous の 3 種）に向く行は危険に数える。
      if (cls.category === "bulkBind") {
        mismatch.bulkBindOnAmbiguous++;
        mismatch.wrongTargetInBulk++;
        if (!lookup.ids.includes(row.bindExistingEntityId))
          mismatch.bulkBindOnAmbiguousOutOfSet++;
      }
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
      if (
        row.candidates.some((c) =>
          (c.methods ?? []).includes("honorific-strip"),
        )
      )
        honorific.unresolvedWithHonorificStripCandidate++;
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
      if (row.bindExistingEntityId !== lookup.id) {
        mismatch.wrongTarget++;
        if (cls.category === "bulkBind") {
          mismatch.wrongTargetInBulkEntity++;
          mismatch.wrongTargetInBulk++;
        }
      }
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

  const wrongEntry = mismatch.bulkCreateWrongEntry;
  wrongEntry.outsideRoster =
    wrongEntry.notInRoster + wrongEntry.relational + wrongEntry.ambiguous;
  wrongEntry.knownEntity = mismatch.cleanupBulkOfKnownEntity;
  wrongEntry.total = wrongEntry.outsideRoster + wrongEntry.knownEntity;

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
    unresolvedCandidateIn:
      entityKeysByCategory.unresolvedCandidateIn?.size ?? 0,
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

  // DR-ILM-38 の列。Ur-all は名簿の外・関係の呼び名も含む全行の unresolved（proposalByBinding。listedByBinding は
  // 名簿の外を抜いた後なので使わない）。Ur-rosterTarget は分類 1 の 2 つの和（categoryCounts をそのまま使い、数え直さない）。
  const urAll = proposalByBinding.unresolved ?? 0;
  const urRosterTarget =
    categoryCounts.unresolvedCandidateIn +
    categoryCounts.unresolvedCandidateOut;
  // S5_seen：S5-roster の表記のうち、提案（rows の surfaceHash）に出たもの。分類の枝（sceneRangeRows など）に依らず
  // 全行の表記の hash の一致で数える（表記単位。同じ表記の行が複数あっても 1 件）。
  const proposalSurfaceHashes = new Set(
    rows.map((r) => r.surfaceHash).filter((h) => typeof h === "string"),
  );
  let s5Seen = 0;
  for (const hash of index.s5Hashes ?? [])
    if (proposalSurfaceHashes.has(hash)) s5Seen++;
  const s5Roster = index.s5Hashes?.size ?? 0;
  if (s5Breakdown) {
    // renderer の内訳（seed・提案の集合から 1 つずつ分類した件数）と、host が rows から数えた値が合わなければ、
    // 表記の hash の空間か S5 の渡し方がずれている。黙って出さず止める。
    const { notSeed, seedNotProposed, proposed } = s5Breakdown;
    assert.equal(
      s5Breakdown.rosterSurfaces,
      s5Roster,
      `[artifact] S5_ROSTER_COUNT_DIFFERS renderer=${s5Breakdown.rosterSurfaces} host=${s5Roster}`,
    );
    assert.equal(
      proposed,
      s5Seen,
      `[artifact] S5_SEEN_COUNT_DIFFERS renderer=${proposed} host=${s5Seen}`,
    );
    assert.equal(
      notSeed + seedNotProposed + proposed,
      s5Roster,
      "[artifact] S5_BREAKDOWN_NOT_PARTITION",
    );
    assert.equal(
      s5Breakdown.proposedOutsideSeed,
      0,
      "[artifact] S5_PROPOSED_OUTSIDE_SEED a roster surface is proposed but is not in the seed set",
    );
  }
  const identityColumns = {
    ur: { all: urAll, rosterTarget: urRosterTarget },
    s5: {
      roster: s5Roster,
      seen: s5Seen,
      // 内訳（seed が読めた run だけ。null は 0 でなく未計測）。
      breakdown: s5Breakdown
        ? {
            notSeed: s5Breakdown.notSeed,
            seedNotProposed: s5Breakdown.seedNotProposed,
            proposed: s5Breakdown.proposed,
            candidate: s5Breakdown.candidate
              ? {
                  inCandidate: s5Breakdown.candidate.inCandidate,
                  notSeedInCandidate: s5Breakdown.candidate.notSeedInCandidate,
                  neitherSeedNorCandidate:
                    s5Breakdown.candidate.neitherSeedNorCandidate,
                }
              : null,
          }
        : null,
    },
  };

  return {
    definitionVersion: METRIC_DEFINITION_VERSION,
    identityColumns,
    proposalCount: rows.length,
    proposalByBinding,
    listedByBinding,
    relational: {
      rows: categoryCounts.relational,
      byBinding: relationalByBinding,
      unresolvedWithPartialCandidate: relationalUnresolvedWithPartialCandidate,
    },
    categoryCounts,
    bulkApprovable: { ...bulkApprovableAudit, bulkTotal },
    // 製品が planner の前段で seed を落とした件数（呼び名・候補画面で却下済みの表記）。件数だけ。
    seedDrops,
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
