// 測定 A の指標の試験（合成の名簿と提案。実在の原稿・名簿は使わない）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { countBulkApprovable, isBulkApprovableRow } from "./lib.mjs";
import {
  buildRosterIndex,
  candidateRank,
  carryOverStability,
  classifyRow,
  codexTypeOf,
  compareSets,
  computeMeasureA,
  lookupRoster,
  METRIC_DEFINITION_VERSION,
  surfaceKindSet,
  unresolvedReason,
} from "./measure-a-metrics.mjs";

// hash は恒等（合成の表記をそのまま key に使う）。
const ident = async (s) => s;

const roster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "alpha",
      aliases: [
        { surface: "al", level: "L2" },
        { surface: "shared", level: "L2" },
      ],
      honorificSurfaces: ["alpha-sensei"],
    },
    {
      id: "e2",
      type: "character",
      name: "beta",
      aliases: [{ surface: "shared", level: "L2" }],
    },
    { id: "e3", type: "location", name: "gamma", aliases: [] },
    {
      id: "e4",
      type: "character",
      name: "delta",
      aliases: [{ surface: "gamma", level: "L2" }], // name-over-alias（名前は e3）
    },
    {
      id: "e5",
      type: "character",
      name: "epsilon",
      aliases: [{ surface: "moving", level: "L3" }],
      ambiguousSurfaces: [{ surface: "moving", sceneRanges: [[1, 5]] }],
    },
    {
      id: "e6",
      type: "character",
      name: "zeta",
      aliases: [{ surface: "moving", level: "L3" }],
      ambiguousSurfaces: [{ surface: "moving", sceneRanges: [[6, 9]] }],
    },
  ],
};

const base = {
  scenes: [[1, 1]],
  coarseClass: "person",
  bindExistingEntityId: null,
  candidates: [],
  typeStatus: "resolved",
  status: "unreviewed",
  bulkApprovable: false,
};
const row = (keyHash, bindingKind, extra = {}) => ({
  ...base,
  keyHash,
  bindingKind,
  ...extra,
});

test("codexTypeOf：名簿の型を Codex の型にする", () => {
  assert.equal(codexTypeOf("character"), "character");
  assert.equal(codexTypeOf("location"), "location");
  assert.equal(codexTypeOf("other"), "lore");
});

test("lookupRoster：名前・別名・敬称・衝突・場面で変わる表記・未判定", async () => {
  const index = await buildRosterIndex(roster, ident);
  assert.deepEqual(lookupRoster(index, "alpha", [1]), {
    kind: "entity",
    id: "e1",
    via: "exact",
    honorific: false,
  });
  assert.equal(lookupRoster(index, "al", [3]).id, "e1");
  assert.deepEqual(lookupRoster(index, "alpha-sensei", [1]), {
    kind: "entity",
    id: "e1",
    via: "honorific",
    honorific: true,
  });
  // 同じ表記が 2 つの実体の別名（i）：ambiguous。
  assert.deepEqual(lookupRoster(index, "shared", [1]), {
    kind: "ambiguous",
    ids: ["e1", "e2"],
  });
  // 名前が別の実体の別名と同じ（ii）：名前の側に結ぶ。
  assert.deepEqual(lookupRoster(index, "gamma", [1]), {
    kind: "entity",
    id: "e3",
    via: "name-over-alias",
    honorific: false,
  });
  // 場面で指す人が変わる表記：場面で決まる。
  assert.equal(lookupRoster(index, "moving", [2]).id, "e5");
  assert.equal(lookupRoster(index, "moving", [7]).id, "e6");
  assert.deepEqual(lookupRoster(index, "moving", [2, 7]), {
    kind: "ambiguous",
    ids: ["e5", "e6"],
  });
  assert.deepEqual(lookupRoster(index, "nobody", [1]), { kind: "unlisted" });
});

test("candidateRank：同点は同順位、無ければ null", () => {
  const cands = [
    { id: "a", score: 90, methods: ["prefix"] },
    { id: "b", score: 80, methods: ["substring"] },
    { id: "c", score: 80, methods: ["substring"] },
    { id: "d", score: 70, methods: ["substring"] },
  ];
  assert.equal(candidateRank(cands, ["a"]), 1);
  assert.equal(candidateRank(cands, ["b"]), 2);
  assert.equal(candidateRank(cands, ["c"]), 2);
  assert.equal(candidateRank(cands, ["d"]), 4);
  assert.equal(candidateRank(cands, ["zz"]), null);
  assert.equal(candidateRank(cands, ["zz", "d"]), 4);
});

test("unresolvedReason：最も強い方法を理由にする", () => {
  assert.equal(
    unresolvedReason([{ methods: ["substring"] }, { methods: ["exact-name"] }]),
    "exact-multiple",
  );
  assert.equal(
    unresolvedReason([{ methods: ["honorific-strip", "prefix"] }]),
    "honorific-strip",
  );
  assert.equal(
    unresolvedReason([{ methods: ["prefix"] }, { methods: ["substring"] }]),
    "prefix",
  );
  assert.equal(unresolvedReason([{ methods: ["embedding"] }]), "other");
});

test("classifyRow：5 分類と 0（名簿に無い）。順に判定する", async () => {
  const index = await buildRosterIndex(roster, ident);
  const listed = lookupRoster(index, "alpha", [1]);
  const unlisted = lookupRoster(index, "zzz", [1]);
  assert.equal(
    classifyRow(row("zzz", "create-new"), unlisted, { bulkApprovable: true })
      .category,
    "notInRoster",
  );
  assert.equal(
    classifyRow(
      row("al", "unresolved", {
        candidates: [{ id: "e1", score: 90, methods: ["prefix"] }],
      }),
      listed,
      { bulkApprovable: false },
    ).category,
    "unresolvedCandidateIn",
  );
  assert.equal(
    classifyRow(
      row("al", "unresolved", {
        candidates: [{ id: "e9", score: 90, methods: ["prefix"] }],
      }),
      listed,
      { bulkApprovable: false },
    ).category,
    "unresolvedCandidateOut",
  );
  assert.equal(
    classifyRow(row("al", "create-new", { typeStatus: "unresolved" }), listed, {
      bulkApprovable: false,
    }).category,
    "typeNeeded",
  );
  assert.equal(
    classifyRow(row("alpha", "bind-existing"), listed, {
      bulkApprovable: false,
    }).category,
    "bindCheck",
  );
  assert.equal(
    classifyRow(row("al", "create-new"), listed, { bulkApprovable: true })
      .category,
    "bulk",
  );
  assert.equal(
    classifyRow(row("al", "create-new"), listed, { bulkApprovable: false })
      .category,
    "manualCreate",
  );
});

test("classifyRow：bind-existing は一括承認可なら bulkBind、そうでなければ bindCheck（create-new の bulk とは別）", async () => {
  const index = await buildRosterIndex(roster, ident);
  const listed = lookupRoster(index, "alpha", [1]);
  assert.equal(
    classifyRow(row("alpha", "bind-existing"), listed, {
      bulkApprovable: true,
    }).category,
    "bulkBind",
  );
  assert.equal(
    classifyRow(row("alpha", "bind-existing"), listed, {
      bulkApprovable: false,
    }).category,
    "bindCheck",
  );
  // 名簿の外の行は、一括承認可でも名簿の外のまま（分類の順序は変えない）。
  assert.equal(
    classifyRow(row("zzz", "bind-existing"), lookupRoster(index, "zzz", [1]), {
      bulkApprovable: true,
    }).category,
    "notInRoster",
  );
});

test("computeMeasureA：一括で通る結び付けは一括の側に数え、承認の下限は『ボタン 1 回』にまとめる。renderer の一括承認可の数と合計が一致する", async () => {
  const index = await buildRosterIndex(roster, ident);
  // renderer の行は applicability・status・safe から bulkApprovable を作る（製品の 3 条件）。
  const mk = (keyHash, bindingKind, safe, extra = {}) => {
    const r = row(keyHash, bindingKind, {
      applicability: "applicable",
      status: "unreviewed",
      safe,
      ...extra,
    });
    return { ...r, bulkApprovable: isBulkApprovableRow(r) };
  };
  const rows = [
    // 一括で通る結び付け（名簿どおり／名簿と違う結び先）。
    mk("alpha", "bind-existing", true, { bindExistingEntityId: "e1" }),
    mk("beta", "bind-existing", true, { bindExistingEntityId: "e1" }),
    // 1 件ずつの結び付け。
    mk("gamma", "bind-existing", false, { bindExistingEntityId: "e3" }),
    // 一括で通る create-new。
    mk("al", "create-new", true),
    // 名簿に無い表記の一括承認可（件数の合計には入るが、分類は名簿の外）。
    mk("noise", "create-new", true),
    mk("noise2", "bind-existing", true, { bindExistingEntityId: "e1" }),
  ];
  const m = computeMeasureA({
    index,
    rows,
    seedDrops: { relationalTerms: 2, foldedDismissed: 1 },
  });
  assert.equal(m.categoryCounts.bulkBind, 2);
  assert.equal(m.categoryCounts.bindCheck, 1);
  assert.equal(m.categoryCounts.bulk, 1);
  assert.equal(m.categoryCounts.notInRoster, 2);
  // 一括承認可の合計は renderer の countBulkApprovable（全行）と同じ。内訳に取りこぼしは無い。
  assert.equal(m.bulkApprovable.total, countBulkApprovable(rows));
  assert.equal(m.bulkApprovable.total, 5);
  assert.deepEqual(m.bulkApprovable.byCategory, {
    bulkBind: 2,
    bulk: 1,
    notInRoster: 2,
  });
  assert.equal(m.bulkApprovable.unexpectedBinding, 0);
  assert.equal(m.bulkApprovable.outsideBulkCategories, 0);
  assert.equal(m.bulkApprovable.bulkTotal, 3);
  // 一括承認は create と結び付けを合わせてボタン 1 回（2 回に数えない）。
  assert.equal(m.operations.surfaceUnit.counts.bulk, 1);
  assert.equal(m.operations.surfaceUnit.counts.bindCheck, 1);
  assert.equal(m.operations.surfaceUnit.approval, 1 + 1);
  // 一括に入った結び付けの結び先の違いは別に数える（beta の名簿の実体は e2 だが e1 に結んでいる）。
  assert.equal(m.mismatch.wrongTarget, 1);
  assert.equal(m.mismatch.wrongTargetInBulk, 1);
  // 製品が seed を落とした件数は、加工せず記録する（件数だけ）。
  assert.deepEqual(m.seedDrops, { relationalTerms: 2, foldedDismissed: 1 });
  assert.equal(computeMeasureA({ index, rows: [] }).seedDrops, null);
});

test("computeMeasureA：名簿で結び先が 1 つに定まらない（場面で指す人が変わる・別名の衝突・敬称が複数）表記への一括の結び付けは、結び先違いの危険に数える", async () => {
  const index = await buildRosterIndex(roster, ident);
  const mk = (keyHash, bindingKind, safe, extra = {}) => {
    const r = row(keyHash, bindingKind, {
      applicability: "applicable",
      status: "unreviewed",
      safe,
      ...extra,
    });
    return { ...r, bulkApprovable: isBulkApprovableRow(r) };
  };
  const rows = [
    // 2 つの実体が別名に持つ表記（衝突。ambiguous）。結び先 e1 は集合の中。製品は一括の結び付けにした。
    mk("shared", "bind-existing", true, { bindExistingEntityId: "e1" }),
    // 場面 1〜9 にまたがり e5・e6 を指す表記。結び先 e5 は集合の中。
    mk("moving", "bind-existing", true, {
      bindExistingEntityId: "e5",
      scenes: [
        [2, 1],
        [7, 1],
      ],
    }),
    // 同じ ambiguous でも、結び先が指しうる実体の集合の外。
    mk("shared", "bind-existing", true, { bindExistingEntityId: "e3" }),
    // ambiguous への 1 件ずつの結び付け（一括でない）は、この危険の件数に入らない。
    mk("shared", "bind-existing", false, { bindExistingEntityId: "e1" }),
    // 名簿が 1 つの実体に定める表記への一括の結び付けで、結び先が違うもの（従来の数え方）。
    mk("beta", "bind-existing", true, { bindExistingEntityId: "e1" }),
    // 名簿どおりの一括の結び付けは数えない。
    mk("alpha", "bind-existing", true, { bindExistingEntityId: "e1" }),
  ];
  const m = computeMeasureA({ index, rows });
  assert.equal(m.collision.ambiguousRows, 4);
  assert.equal(m.categoryCounts.bulkBind, 5);
  assert.equal(m.mismatch.bulkBindOnAmbiguous, 3);
  assert.equal(m.mismatch.bulkBindOnAmbiguousOutOfSet, 1);
  assert.equal(m.mismatch.wrongTargetInBulkEntity, 1);
  // wrongTargetInBulk は 2 つの合計（定義の版 a-defs/2）。
  assert.equal(m.mismatch.wrongTargetInBulk, 4);
  assert.equal(
    m.mismatch.wrongTargetInBulk,
    m.mismatch.wrongTargetInBulkEntity + m.mismatch.bulkBindOnAmbiguous,
  );
  // wrongTarget（一括かどうかを問わない、名簿が 1 つに定める表記だけの数え方）は変えない。
  assert.equal(m.mismatch.wrongTarget, 1);
  assert.equal(m.definitionVersion, METRIC_DEFINITION_VERSION);
});

test("computeMeasureA：一括承認可の行が bulk 系にも名簿の外にも入らなければ、取りこぼしとして数える", async () => {
  const index = await buildRosterIndex(roster, ident);
  // bulkApprovable なのに unresolved（製品の旗の定義上ありえない行）。
  const m = computeMeasureA({
    index,
    rows: [
      row("al", "unresolved", {
        bulkApprovable: true,
        candidates: [{ id: "e1", score: 90, methods: ["prefix"] }],
      }),
    ],
  });
  assert.equal(m.bulkApprovable.unexpectedBinding, 1);
  assert.equal(m.bulkApprovable.outsideBulkCategories, 1);
});

test("computeMeasureA：件数・食い違い・操作の数・衝突の挙動", async () => {
  const index = await buildRosterIndex(roster, ident);
  const rows = [
    // 名簿に無い（create-new・unresolved）：別枠。
    row("noise1", "create-new", { bulkApprovable: true }),
    row("noise2", "unresolved", {
      candidates: [{ id: "e1", score: 80, methods: ["honorific-strip"] }],
    }),
    // 完全一致の bind-existing：e1 に結ぶ（名簿どおり）／e2 に結ぶ（名簿と違う結び先）。
    row("alpha", "bind-existing", { bindExistingEntityId: "e1" }),
    row("beta", "bind-existing", { bindExistingEntityId: "e1" }),
    // 解決が要る（候補に e1 が順位 1、部分一致の候補に別人 e2 も）。
    row("al", "unresolved", {
      candidates: [
        { id: "e1", score: 90, methods: ["prefix"] },
        { id: "e2", score: 80, methods: ["substring"] },
      ],
    }),
    // 候補外。
    row("alpha-sensei", "unresolved", {
      candidates: [{ id: "e2", score: 80, methods: ["honorific-strip"] }],
    }),
    // 結び残し（create-new）で、一括承認で通る（後始末）、型は person だが名簿は location。
    row("gamma2", "create-new", {
      bulkApprovable: true,
      coarseClass: "person",
    }),
    // 衝突：shared は ambiguous、gamma は name-over-alias で e3 に結ぶ。
    row("shared", "unresolved", {
      candidates: [
        { id: "e1", score: 100, methods: ["exact-alias"] },
        { id: "e2", score: 100, methods: ["exact-alias"] },
      ],
    }),
    row("gamma", "bind-existing", { bindExistingEntityId: "e3" }),
    // 型が未解決の create-new（名簿の実体 e5 の別名 moving、場面 2）。
    row("moving", "create-new", { typeStatus: "unresolved", scenes: [[2, 1]] }),
  ];
  // gamma2 を e3 の表記として引けるよう、名簿の索引に足す代わりに、行を e3 の別名の表記にする。
  rows[6].keyHash = "gamma"; // → name-over-alias で e3（location）
  const m = computeMeasureA({ index, rows });
  assert.equal(m.proposalCount, 10);
  assert.equal(m.categoryCounts.notInRoster, 2);
  assert.deepEqual(m.notInRosterByKind, { "create-new": 1, unresolved: 1 });
  assert.equal(m.honorific.unlistedUnresolvedByHonorificStrip, 1);
  assert.equal(m.categoryCounts.bindCheck, 3);
  assert.equal(m.mismatch.wrongTarget, 1);
  assert.equal(m.categoryCounts.unresolvedCandidateIn, 2); // al と shared（ids に e1）
  assert.equal(m.categoryCounts.unresolvedCandidateOut, 1);
  assert.equal(m.categoryCounts.bulk, 1);
  assert.equal(m.categoryCounts.typeNeeded, 1);
  assert.equal(m.mismatch.leftoverCreateNew, 2);
  assert.equal(m.mismatch.leftoverUnresolvedOut, 1);
  assert.equal(m.mismatch.cleanupBulkOfKnownEntity, 1);
  assert.equal(m.mismatch.typePersonOnNonCharacter, 1);
  assert.equal(m.mismatch.typePersonOnNonCharacterInBulk, 1);
  // 部分一致：al の候補のうち別人（e2）。shared は ambiguous の表記なので分母に入らない。
  assert.equal(m.partial.unresolvedListed, 2); // al, alpha-sensei
  assert.equal(m.partial.withPartialCandidate, 1);
  assert.equal(m.partial.anyPartialWrong, 1);
  assert.equal(m.partial.allPartialWrong, 0);
  assert.equal(m.partial.partialSlots, 2);
  assert.equal(m.partial.partialSlotsWrong, 1);
  assert.equal(m.honorific.listedRows, 1);
  assert.equal(m.honorific.unresolvedWithHonorificStripCandidate, 1);
  // 衝突。
  assert.equal(m.collision.ambiguousRows, 1);
  assert.deepEqual(m.collision.ambiguousByBinding, { unresolved: 1 });
  assert.equal(m.collision.nameOverAliasRows, 2); // gamma（bind）と gamma（bulk create）
  assert.equal(m.collision.nameOverAliasBoundToNameOwner, 1);
  assert.equal(m.collision.sceneRangeRows, 1);
  // 順位。
  assert.equal(m.unresolved.rankCounts.r1, 2);
  // 操作の数：bulk 1 ＋ bind 3×1 ＋ in 2×2 ＋ out 1×2 ＋ typeNeeded 1×2 ＋ manual 0。
  assert.equal(m.operations.surfaceUnit.approval, 1 + 3 + 4 + 2 + 2);
  // 表記を残す下限：bind は 2、in は 3。
  assert.equal(m.operations.surfaceUnit.keepSurface, 1 + 6 + 6 + 2 + 2);
  // 実体単位は、同じ実体に束ねた表記を 1 件にする（bindCheck は e1・e3 の 2 実体）。
  assert.equal(m.operations.entityUnit.counts.bindCheck, 3);
  assert.ok(
    m.operations.entityUnit.approval <= m.operations.surfaceUnit.approval,
  );
  assert.equal(m.restoreColumn, "not-available");
});

test("指標は表記の文字列を持たない（hash と ID と件数だけ）", async () => {
  const index = await buildRosterIndex(roster, ident);
  const m = computeMeasureA({
    index,
    rows: [row("alpha", "bind-existing", { bindExistingEntityId: "e1" })],
  });
  const json = JSON.stringify(m);
  assert.ok(!json.includes("alpha"));
});

test("run 間の比較：表記×種類の集合", () => {
  const a = surfaceKindSet([row("x", "create-new"), row("y", "unresolved")]);
  const b = surfaceKindSet([row("y", "unresolved"), row("x", "create-new")]);
  assert.deepEqual(compareSets(a, b), {
    left: 2,
    right: 2,
    both: 2,
    leftOnly: 0,
    rightOnly: 0,
    equal: true,
  });
  const c = surfaceKindSet([row("x", "bind-existing")]);
  const d = compareSets(a, c);
  assert.equal(d.equal, false);
  assert.equal(d.both, 0);
});

test("★8：前の回の未 review が最新の run に同じ表記で残る件数と、たまる run 数", () => {
  const runs = [
    { label: "F25", rows: [row("a", "create-new"), row("b", "create-new")] },
    {
      label: "F50",
      rows: [
        row("a", "create-new"),
        row("b", "unresolved"),
        row("c", "create-new"),
      ],
    },
    {
      label: "F100",
      rows: [
        row("a", "create-new"),
        row("b", "create-new"),
        row("c", "create-new"),
        row("d", "create-new"),
      ],
    },
  ];
  const r = carryOverStability(runs);
  assert.equal(r.runCount, 3);
  assert.deepEqual(r.perRun[0], {
    label: "F25",
    unreviewed: 2,
    remainingInLatestSameSurface: 2,
    remainingInLatestSameSurfaceAndKind: 2,
  });
  assert.equal(r.perRun[1].unreviewed, 3);
  assert.equal(r.perRun[1].remainingInLatestSameSurface, 3);
  assert.equal(r.perRun[1].remainingInLatestSameSurfaceAndKind, 2); // b は種類が変わった
  assert.deepEqual(r.surfacesByRunsUnreviewed, { 3: 2, 2: 1, 1: 1 });
  assert.equal(r.note, "seed-stability-not-reauthoring");
  // 未 review でない提案は数えない。
  const reviewed = carryOverStability([
    { label: "x", rows: [row("a", "create-new", { status: "approved" })] },
    { label: "y", rows: [row("a", "create-new")] },
  ]);
  assert.equal(reviewed.perRun[0].unreviewed, 0);
});

// ---- 関係の呼び名（relationalSurfaces）：名簿に無い表記（0 番）とは別の枠 ----------------

const relationalRoster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "alpha",
      aliases: [],
      relationalSurfaces: ["kin-call", "shared-call"],
    },
    {
      id: "e2",
      type: "character",
      name: "beta",
      aliases: [{ surface: "beta-alias", level: "L2" }],
      relationalSurfaces: ["shared-call", "beta-alias-rel"],
    },
    // 別の実体の別名と同じ表記：登録した別名として結ぶ方を優先する。
    {
      id: "e3",
      type: "character",
      name: "gamma",
      aliases: [],
      relationalSurfaces: ["beta-alias"],
    },
  ],
};

test("lookupRoster：関係の呼び名は kind relational（指しうる実体の一覧つき）。名前・別名として引ける表記が先", async () => {
  const index = await buildRosterIndex(relationalRoster, ident);
  assert.deepEqual(lookupRoster(index, "kin-call", [1]), {
    kind: "relational",
    ids: ["e1"],
  });
  assert.deepEqual(lookupRoster(index, "shared-call", [1]), {
    kind: "relational",
    ids: ["e1", "e2"],
  });
  // 名簿の別名（e2）として引けるので relational にはならない。
  assert.equal(lookupRoster(index, "beta-alias", [1]).kind, "entity");
  assert.deepEqual(lookupRoster(index, "nobody", [1]), { kind: "unlisted" });
  // 関係の呼び名の欄が無い名簿でも引ける（これまでと同じ）。
  const plain = await buildRosterIndex(
    { entities: [relationalRoster.entities[0]] },
    ident,
  );
  assert.equal(lookupRoster(plain, "alpha", [1]).kind, "entity");
});

test("computeMeasureA：関係の呼び名が作る提案は別の枠（relational）に数え、notInRoster・名簿の実体の分類・操作の下限に入れない", async () => {
  const index = await buildRosterIndex(relationalRoster, ident);
  const rows = [
    row("alpha", "bind-existing", { bindExistingEntityId: "e1" }),
    row("kin-call", "create-new", { bulkApprovable: true }),
    row("kin-call", "unresolved", {
      candidates: [{ id: "e1", score: 90, methods: ["prefix"] }],
    }),
    row("shared-call", "bind-existing", { bindExistingEntityId: "e2" }),
    row("shared-call", "create-new"),
    row("zzz", "create-new"),
  ];
  const m = computeMeasureA({ index, rows });
  assert.equal(m.proposalCount, 6);
  assert.equal(m.categoryCounts.relational, 4);
  assert.equal(m.categoryCounts.notInRoster, 1);
  assert.equal(m.categoryCounts.bindCheck, 1);
  assert.equal(m.categoryCounts.bulk, 0);
  assert.equal(m.categoryCounts.unresolvedCandidateIn, 0);
  assert.equal(m.relational.rows, 4);
  assert.deepEqual(m.relational.byBinding, {
    "create-new": 2,
    unresolved: 1,
    "bind-existing": 1,
  });
  assert.deepEqual(m.listedByBinding, { "bind-existing": 1 });
  assert.equal(m.mismatch.leftoverCreateNew, 0);
  assert.equal(m.operations.surfaceUnit.approval, 1); // bindCheck の 1 件だけ
  assert.equal(m.honorific.unresolvedWithHonorificStripCandidate, 0);
  assert.ok(Object.keys(m.categoryCounts).includes("relational"));
});

test("classifyRow：relational は 0（名簿に無い）とも 1〜5 とも別の分類", () => {
  assert.equal(
    classifyRow(
      row("kin-call", "create-new"),
      { kind: "relational", ids: ["e1"] },
      { bulkApprovable: true },
    ).category,
    "relational",
  );
});

// ---- 一括 1 回で誤った Entry ができる件数（a-defs/3。M1）・関係の呼び名の unresolved（m3）-------------------

const wrongEntryRoster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "alpha",
      aliases: [{ surface: "shared", level: "L2" }],
      relationalSurfaces: ["kin-call"],
    },
    {
      id: "e2",
      type: "character",
      name: "beta",
      aliases: [{ surface: "shared", level: "L2" }],
    },
  ],
};
const mkBulk = (keyHash, bindingKind, extra = {}) => {
  const r = row(keyHash, bindingKind, {
    applicability: "applicable",
    status: "unreviewed",
    safe: true,
    ...extra,
  });
  return { ...r, bulkApprovable: isBulkApprovableRow(r) };
};

test("computeMeasureA：一括の create-new が名簿の外・結び先が定まらない表記・既知の実体に向く件数を、一括 1 回で誤った Entry ができる件数として数える（操作の下限は変えない）", async () => {
  const index = await buildRosterIndex(wrongEntryRoster, ident);
  const rows = [
    // 名簿にも対応表にも無い表記（ノイズ）への一括の create-new：2 件。
    mkBulk("noise-1", "create-new"),
    mkBulk("noise-2", "create-new"),
    // 関係の呼び名への一括の create-new：1 件。
    mkBulk("kin-call", "create-new"),
    // 名簿で結び先が定まらない表記（別名の衝突）への一括の create-new：1 件。
    mkBulk("shared", "create-new"),
    // 名簿が 1 つの実体に定める表記への一括の create-new（後始末の重複）：1 件。
    mkBulk("alpha", "create-new"),
    // 数えないもの：一括でない create-new、結び付け、名簿の外でも一括でない行。
    row("noise-3", "create-new"),
    mkBulk("beta", "bind-existing", { bindExistingEntityId: "e2" }),
    row("kin-call", "create-new"),
  ];
  const m = computeMeasureA({ index, rows });
  const w = m.mismatch.bulkCreateWrongEntry;
  assert.deepEqual(w, {
    notInRoster: 2,
    relational: 1,
    ambiguous: 1,
    outsideRoster: 4,
    knownEntity: 1,
    total: 5,
  });
  assert.equal(w.knownEntity, m.mismatch.cleanupBulkOfKnownEntity);
  // 一括承認可の全行（renderer の数と照合する値）には名簿の外の行も入っている。
  assert.equal(m.bulkApprovable.total, 6);
  // 操作の下限は a-defs/2 のまま：名簿の外の行は下限に入れず、一括の「ボタン 1 回」は名簿の実体の行（alpha の create-new・
  // shared の create-new・beta の結び付け）で数える。
  assert.equal(m.categoryCounts.notInRoster, 3);
  assert.equal(m.categoryCounts.relational, 2);
  assert.equal(m.bulkApprovable.bulkTotal, 3);
  assert.equal(m.operations.surfaceUnit.counts.bulk, 1);
});

test("computeMeasureA：名簿の外の一括の create-new しか無くても、一括 1 回の危険は数え、下限の『一括承認 1』は足さない", async () => {
  const index = await buildRosterIndex(wrongEntryRoster, ident);
  const m = computeMeasureA({
    index,
    rows: [mkBulk("noise-1", "create-new"), mkBulk("kin-call", "create-new")],
  });
  assert.equal(m.mismatch.bulkCreateWrongEntry.total, 2);
  assert.equal(m.mismatch.bulkCreateWrongEntry.outsideRoster, 2);
  assert.equal(m.operations.surfaceUnit.counts.bulk, 0);
  assert.equal(m.operations.surfaceUnit.approval, 0);
  assert.equal(m.operations.surfaceUnit.keepSurface, 0);
});

test("computeMeasureA：関係の呼び名の unresolved のうち部分一致の候補があるものを別に数える（作者に出る提案。操作の下限には入れない）", async () => {
  const index = await buildRosterIndex(wrongEntryRoster, ident);
  const rows = [
    row("kin-call", "unresolved", {
      candidates: [{ id: "e1", score: 80, methods: ["prefix"] }],
    }),
    row("kin-call", "unresolved", {
      candidates: [{ id: "e2", score: 60, methods: ["substring", "x"] }],
    }),
    // 部分一致でない候補（完全一致）だけの unresolved は数えない。
    row("kin-call", "unresolved", {
      candidates: [{ id: "e1", score: 100, methods: ["exact-name"] }],
    }),
    row("kin-call", "create-new"),
  ];
  const m = computeMeasureA({ index, rows });
  assert.equal(m.relational.byBinding.unresolved, 3);
  assert.equal(m.relational.unresolvedWithPartialCandidate, 2);
  assert.equal(m.operations.surfaceUnit.approval, 0);
  assert.equal(m.operations.surfaceUnit.keepSurface, 0);
  assert.equal(m.operations.entityUnit.approval, 0);
});
