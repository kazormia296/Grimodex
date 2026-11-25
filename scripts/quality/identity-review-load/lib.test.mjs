import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertEntryTypesInCatalog,
  checkEntryTypesInCatalog,
  FOLDER_PERCENTS,
  HONORIFIC_SUFFIXES,
  RETRYABLE_FAILURE_KINDS,
  classifyJudgmentFailure,
  runGuardedJudge,
  WORKS,
  EXTERNAL_COMMANDS,
  STORED_PROPOSAL_KINDS,
  assertOutputClean,
  buildAsciiTokenSet,
  buildShingleSet,
  compareHashSets,
  compareStoredWithProjection,
  countAsciiTokenHits,
  countBulkApprovable,
  countShingleHits,
  countTextMismatches,
  crossSetCounts,
  expectedCanonicalText,
  expectedSceneText,
  findAiCommands,
  findUnsafeStrings,
  hashSurface,
  nestedFolderSceneCounts,
  planNestedFolders,
  planProductVisibleRuns,
  planStoredRead,
  planStoredRuns,
  classifyS5Surfaces,
  reconcileSeedsWithProposals,
  safeErrorSummary,
  sanitizeError,
  scenesFromWork,
  storedNotMeasured,
  stripHonorific,
  summarizeCandidateInventory,
  summarizeSeedInventory,
  summarizeStoredProposals,
  surfaceOverlapCounts,
} from "./lib.mjs";
import { countAiRows, precheckEnvironment } from "./run-inventory.mjs";
import { resolveWorkSource } from "./sources.mjs";

const NON_ASCII = /[^ -~\n\r\t]/u;
const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATA_DIR = resolveWorkSource("m-ja-2");

test("入れ子 folder の累積の場面数は ceil(N×k%)", () => {
  assert.deepEqual(nestedFolderSceneCounts(110), [28, 55, 83, 110]);
  assert.deepEqual(nestedFolderSceneCounts(117), [30, 59, 88, 117]);
  assert.deepEqual(nestedFolderSceneCounts(34), [9, 17, 26, 34]);
  assert.deepEqual(nestedFolderSceneCounts(60), [15, 30, 45, 60]);
  assert.deepEqual([...FOLDER_PERCENTS], [25, 50, 75, 100]);
  assert.throws(() => nestedFolderSceneCounts(0));
  assert.throws(() => nestedFolderSceneCounts(1.5));
});

test("入れ子 folder の計画は F(k-1) を先頭の子にし、場面を重複・欠落なく置く", () => {
  for (const count of Object.values(WORKS)) {
    const { counts, folders } = planNestedFolders(count);
    assert.equal(folders.length, 4);
    assert.equal(folders[0].childFolderPercent, null);
    assert.deepEqual(
      folders.map((f) => f.childFolderPercent),
      [null, 25, 50, 75],
    );
    assert.deepEqual(
      folders.map((f) => f.parentPercent),
      [50, 75, 100, null],
    );
    const placed = folders.flatMap((f) => f.addedSceneIndexes);
    assert.deepEqual(
      placed,
      Array.from({ length: count }, (_, i) => i),
    );
    assert.deepEqual(
      folders.map((f) => f.cumulativeSceneCount),
      counts,
    );
    for (const folder of folders)
      assert.ok(folder.addedSceneIndexes.length > 0);
  }
});

test("表記の hash は sha256 の先頭 16 桁", async () => {
  assert.equal(await hashSurface("abc"), "ba7816bf8f01cfea");
  assert.match(await hashSurface("日本語"), /^[0-9a-f]{16}$/u);
  assert.notEqual(await hashSurface("a"), await hashSurface("b"));
});

test("敬称の並びは製品の existingEntityMatcher.ts と同じ", () => {
  const source = readFileSync(
    path.join(ROOT, "src/features/codex/extraction/existingEntityMatcher.ts"),
    "utf8",
  );
  const block = /const HONORIFIC_SUFFIXES = \[([\s\S]*?)\] as const;/u.exec(
    source,
  );
  assert.ok(block, "HONORIFIC_SUFFIXES block not found");
  const product = [...block[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  assert.deepEqual([...HONORIFIC_SUFFIXES], product);
});

test("stripHonorific は最初に合った敬称 1 つだけを外し、敬称だけの語は残す", () => {
  assert.equal(stripHonorific("田中さん"), "田中");
  assert.equal(stripHonorific("田中先生"), "田中");
  assert.equal(stripHonorific("さん"), "さん");
  assert.equal(stripHonorific("田中さんさん"), "田中さん");
});

test("表記の重なり：敬称・部分文字列の件数", () => {
  const counts = surfaceOverlapCounts([
    "田中",
    "田中さん",
    "田中先生",
    "山田さん",
    "田",
    "Ab",
    "ab",
  ]);
  // distinct：田中, 田中さん, 田中先生, 山田さん, 田, ab（Ab と ab は 1 つ）
  assert.equal(counts.distinct, 6);
  assert.equal(counts.honorificStrippable, 3);
  assert.equal(counts.honorificOverlap, 2); // 田中さん・田中先生（山田さん→山田 は集合に無い）
  // 部分文字列：田中（田中さん等の中）・田は 1 文字なので除外
  assert.equal(counts.substringWithinSet, 1);
});

test("seed の目録：出現数・場面あたりの分布・固有名詞の数", () => {
  const out = summarizeSeedInventory([
    {
      surface: "甲",
      occurrenceCount: 3,
      sceneIds: ["a", "a", "b"],
      appearsAsProperName: true,
    },
    {
      surface: "乙さん",
      occurrenceCount: 1,
      sceneIds: ["a"],
      appearsAsProperName: false,
    },
  ]);
  assert.equal(out.seedCount, 2);
  assert.equal(out.occurrenceCount, 4);
  assert.equal(out.properNameSeedCount, 1);
  assert.equal(out.aliasFormSeedCount, 1);
  assert.equal(out.scenesWithSeeds, 2);
  assert.equal(out.distinctSeedsPerScene.max, 2);
  assert.equal(out.distinctSeedsPerScene.min, 1);
  assert.deepEqual(
    Object.keys(out).filter((k) => typeof out[k] === "string"),
    [],
  );
});

test("候補の目録と共通部分", () => {
  const out = summarizeCandidateInventory([
    { surface: "甲", count: 4 },
    { surface: "甲さん", count: 2 },
  ]);
  assert.equal(out.candidateCount, 2);
  assert.equal(out.occurrenceCount, 6);
  assert.equal(out.honorificOverlap, 1);
  assert.deepEqual(crossSetCounts(["甲", "乙"], ["甲", "丙", "丁"]), {
    seedOnly: 1,
    candidateOnly: 2,
    both: 1,
  });
});

test("canonical text の期待値は段落を改行で区切り、末尾に改行を付けない", () => {
  assert.equal(expectedCanonicalText(["a", "b"]), "a\nb");
  assert.equal(expectedSceneText(["a", "b"]), "a\nb\n");
});

test("本文の一致検査は件数だけを返す（本文を載せない）", () => {
  const expected = [expectedSceneText(["一", "二"]), expectedSceneText(["三"])];
  assert.deepEqual(countTextMismatches(expected, [...expected]), {
    expected: 2,
    actual: 2,
    mismatched: 0,
  });
  const result = countTextMismatches(expected, [expected[0], "別"]);
  assert.equal(result.mismatched, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    "actual",
    "expected",
    "mismatched",
  ]);
  assert.equal(countTextMismatches(expected, [expected[0]]).mismatched, 2);
  assert.equal(expectedSceneText(["a", "b"]), "a\nb\n");
});

test("出力の混入検査：文字列の欄は ASCII の識別子の形だけ許す", () => {
  const ok = {
    work: "m-ja-1",
    startedAt: "2026-11-14T00:00:00.000Z",
    hash: "0123456789abcdef",
    path: "/home/x/identity-review-load-2026-11/inventory/m-ja-1.json",
    counts: { a: 1, b: [1, 2, 3] },
  };
  assert.deepEqual(findUnsafeStrings(ok), []);
  assert.deepEqual(findUnsafeStrings({ name: "田中" }), ["$.name"]);
  assert.deepEqual(findUnsafeStrings({ list: ["ok", "日本"] }), ["$.list[1]"]);
  assert.deepEqual(findUnsafeStrings({ 田中: 1 }), ["$.<key>"]);
  assert.ok(findUnsafeStrings({ q: 'He said: "hi"' }).length > 0);
});

test("shingle 走査：原稿の連続 8 文字が出力にあれば検出する（合成の原稿）", () => {
  const scenes = ["abcdefghijklmnop\n", "あいうえおかきくけこ\n"];
  const shingles = buildShingleSet(scenes);
  assert.equal(countShingleHits("xx-abcdefgh-xx", shingles), 1);
  assert.equal(countShingleHits("abcdefg", shingles), 0);
  assert.equal(countShingleHits("あいうえおかきく", shingles), 1);
  assert.equal(countShingleHits("0123456789abcdef", shingles), 0);
  assert.throws(
    () => assertOutputClean({ k: "abcdefghijk" }, scenes),
    /shingle=[1-9]/u,
  );
  assert.throws(() => assertOutputClean({ k: "あ" }, scenes), /unsafe=[1-9]/u);
  assert.doesNotThrow(() =>
    assertOutputClean({ k: "0123456789abcdef", n: 3 }, scenes),
  );
});

/** electron/main/profileEgress.ts から、DENIED_COMMANDS の全 key（route 不問）を取り出す。 */
function deniedCommandNames() {
  const source = readFileSync(
    path.join(ROOT, "electron/main/profileEgress.ts"),
    "utf8",
  );
  const block =
    /const DENIED_COMMANDS = new Map<string, D2aRoute>\(\[([\s\S]*?)\]\);/u.exec(
      source,
    );
  assert.ok(block, "DENIED_COMMANDS block not found");
  return [...block[1].matchAll(/\["([^"]+)", "([^"]+)"\]/gu)].map((m) => m[1]);
}

test("AI／外部の command の判定は DENIED_COMMANDS の全 key と license・key・モデル取得を拾う", () => {
  const denied = deniedCommandNames();
  assert.ok(denied.length > 20);
  // route 不問（plaintext-publication・external-url も含む）。
  assert.deepEqual(findAiCommands(denied), [...new Set(denied)].sort());
  const source = readFileSync(
    path.join(ROOT, "electron/main/profileEgress.ts"),
    "utf8",
  );
  const license =
    /const LICENSE_CONTROL_COMMANDS = \[([\s\S]*?)\] as const/u.exec(source);
  assert.ok(license, "LICENSE_CONTROL_COMMANDS block not found");
  const licenseNames = [...license[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1]);
  assert.ok(licenseNames.length >= 3);
  assert.deepEqual(findAiCommands(licenseNames), [...licenseNames].sort());
  // EXTERNAL_COMMANDS の各名は ipcContract に実在する（stale を拾う）。
  const contract = readFileSync(
    path.join(ROOT, "electron/shared/ipcContract.ts"),
    "utf8",
  );
  for (const name of EXTERNAL_COMMANDS)
    assert.ok(contract.includes(`  ${name}: {`), `${name} not in ipcContract`);
  // 停止だけの abort_* と、AI でない通常の command は拾わない。
  assert.deepEqual(
    findAiCommands([
      "abort_chat_stream",
      "abort_inline_ai_stream",
      "tree_node_create",
      "project_create",
      "open_workspace",
      "extract_codex_candidates",
      "extract_codex_entity_seeds",
      "codex_create",
      "get_license_state",
      "narrative_extraction_create_run",
      "ai_audit_read_snapshot",
      "ai_audit_verify",
    ]),
    [],
  );
  assert.deepEqual(
    findAiCommands(["codex_judgment", "ai_usage_record", "send_chat_message"]),
    ["ai_usage_record", "codex_judgment", "send_chat_message"],
  );
});

test("S5 の分類：表記を集合の所属から 3 区分の 1 つに振り（和は S5 の件数）、候補は重なってよい別の数にする", () => {
  // S5：a・b・c・d・e（e は S5 の入力に 2 回出ても 1 件）。seed：b・c・d・x。提案：c・d・x。候補：a・b・e・y。
  const r = classifyS5Surfaces({
    s5Hashes: ["a", "b", "c", "d", "e", "e"],
    seedHashes: ["b", "c", "d", "x"],
    proposalHashes: ["c", "d", "x"],
    candidateHashes: ["a", "b", "e", "y"],
  });
  assert.equal(r.rosterSurfaces, 5);
  // a・e：seed に無い／b：seed にあるが提案に無い／c・d：提案に出る。
  assert.deepEqual(
    [r.notSeed, r.seedNotProposed, r.proposed, r.proposedOutsideSeed],
    [2, 1, 2, 0],
  );
  assert.equal(r.notSeed + r.seedNotProposed + r.proposed, r.rosterSurfaces);
  // 候補：a・b・e が S5 に当たる（y は S5 でない）。うち seed にならないのは a・e（両方に当てはまらない表記は、この fixture には置いていない）。
  assert.deepEqual(r.candidate, {
    inCandidate: 3,
    notSeedInCandidate: 2,
    neitherSeedNorCandidate: 0,
  });
  // 候補が未計測（null）なら 0 でなく null。
  assert.equal(
    classifyS5Surfaces({
      s5Hashes: ["a"],
      seedHashes: [],
      proposalHashes: [],
    }).candidate,
    null,
  );
  // 「seed にも候補にもならない」：seed に無く、候補にも無い。
  assert.equal(
    classifyS5Surfaces({
      s5Hashes: ["a", "b", "c"],
      seedHashes: ["c"],
      proposalHashes: [],
      candidateHashes: ["b"],
    }).candidate.neitherSeedNorCandidate,
    1,
  );
  // 提案に出るのに seed に無い表記は、提案に出る側に入れたうえで異常として数える（件数を引き算で作らない）。
  const odd = classifyS5Surfaces({
    s5Hashes: ["a"],
    seedHashes: [],
    proposalHashes: ["a"],
  });
  assert.deepEqual(
    [odd.proposed, odd.proposedOutsideSeed, odd.notSeed],
    [1, 1, 0],
  );
  // 出力は件数だけ（hash も持たない）。
  assert.ok(
    Object.values(r).every(
      (v) => Number.isInteger(v) || v === null || typeof v === "object",
    ),
  );
});

test("一括承認可は applicable・unreviewed・safe の 3 条件（blocked で safe の提案は数えない）", () => {
  const rows = [
    { applicability: "applicable", status: "unreviewed", safe: true },
    { applicability: "blocked", status: "unreviewed", safe: true },
    { applicability: "applicable", status: "approved", safe: true },
    { applicability: "applicable", status: "unreviewed", safe: false },
  ];
  assert.equal(countBulkApprovable(rows), 1);
});

test("seed と提案の突合：製品が落とした seed（呼び名・却下済み）を引いた集合が提案と一致すれば ok", () => {
  const ok = reconcileSeedsWithProposals({
    seedHashes: ["a", "b", "c", "rel", "dis"],
    proposalHashes: ["a", "b", "c"],
    droppedRelationalHashes: ["rel"],
    droppedDismissedHashes: ["dis"],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.droppedRelational, 1);
  assert.equal(ok.droppedFoldedDismissed, 1);
  // 落とした表記が無い run は、従来どおり集合の一致だけを見る。
  assert.equal(
    reconcileSeedsWithProposals({
      seedHashes: ["a", "b"],
      proposalHashes: ["b", "a"],
    }).ok,
    true,
  );
  // 落とした表記を申告していない seed の欠落は、planner が飛ばした印として失敗する。
  const missing = reconcileSeedsWithProposals({
    seedHashes: ["a", "b", "rel"],
    proposalHashes: ["a"],
    droppedRelationalHashes: ["rel"],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.seedOnlyUnexplained, 1);
  // seed に無い提案。
  assert.equal(
    reconcileSeedsWithProposals({
      seedHashes: ["a"],
      proposalHashes: ["a", "x"],
    }).proposalOnlyUnexplained,
    1,
  );
  // 落とした表記が提案に残る場合の検査。
  const both = reconcileSeedsWithProposals({
    seedHashes: ["a", "rel"],
    proposalHashes: ["a", "rel"],
    droppedRelationalHashes: ["rel"],
  });
  assert.equal(both.ok, false);
  assert.equal(both.droppedAndProposed, 1);
  assert.equal(both.proposalOnlyUnexplained, 1);
  // 落としたと言う表記が、道具の seed の読みに無い（prepass の読みが製品と違う）。
  const ghost = reconcileSeedsWithProposals({
    seedHashes: ["a"],
    proposalHashes: ["a"],
    droppedDismissedHashes: ["ghost"],
  });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.droppedNotInSeed, 1);
  // 同じ表記が両方の落とし先に入るのは製品の順序（呼び名が先）と合わない。
  assert.equal(
    reconcileSeedsWithProposals({
      seedHashes: ["a", "x"],
      proposalHashes: ["a"],
      droppedRelationalHashes: ["x"],
      droppedDismissedHashes: ["x"],
    }).relationalAndDismissed,
    1,
  );
});

test("hash の集合の突合は件数だけを返す", () => {
  assert.deepEqual(compareHashSets(["a", "b", "b", "c"], ["b", "c", "d"]), {
    left: 3,
    right: 3,
    both: 2,
    leftOnly: 1,
    rightOnly: 1,
  });
  assert.equal(compareHashSets([], []).both, 0);
});

test("seed の目録：全 seed が固有名詞形なら敬称の 0 は構造上の 0 と記す", () => {
  const seeds = [
    {
      surface: "alpha",
      occurrenceCount: 1,
      sceneIds: ["s1"],
      appearsAsProperName: true,
    },
  ];
  assert.equal(summarizeSeedInventory(seeds).honorificStructurallyZero, true);
  assert.equal(
    summarizeSeedInventory([{ ...seeds[0], appearsAsProperName: false }])
      .honorificStructurallyZero,
    false,
  );
});

test("エラーの要約は自由文を載せない（名前・印・code だけ）", () => {
  const withProse = new Error(
    "[artifact] 架空の人物サンプル太郎 failed NEX_READ_SET_STALE with Zorvath Keldrin",
  );
  const summary = safeErrorSummary(withProse);
  assert.deepEqual(summary, {
    name: "Error",
    tag: "artifact",
    codes: ["NEX_READ_SET_STALE"],
    pairs: [],
  });
  assert.deepEqual(
    safeErrorSummary(
      new Error(
        "page.evaluate: Error: [artifact] X_Y differs: seedOnly=3 proposalOnly=0",
      ),
    ),
    {
      name: "Error",
      tag: "artifact",
      codes: ["X_Y"],
      pairs: ["seedOnly=3", "proposalOnly=0"],
    },
  );
  assert.doesNotThrow(() => assertOutputClean({ errors: [summary] }, ["架空"]));
  assert.deepEqual(safeErrorSummary("plain string"), {
    name: "NonError",
    tag: "none",
    codes: [],
    pairs: [],
  });
  // 名前に非 ASCII があれば Error に置き換える。
  const odd = new Error("x");
  odd.name = "架空Error";
  assert.equal(safeErrorSummary(odd).name, "Error");
  // sanitizeError は非 ASCII を潰す。
  assert.equal(NON_ASCII.test(sanitizeError("日本語 abc")), false);
});

test("混入検査：SAFE_STRING を通る ASCII の原稿でも、shingle・ASCII の語で単独に検出する", () => {
  const manuscript = ["Zorvath Keldrin walked past the old harbour gate"];
  // (1) 文字列の欄の拒否は通る（ASCII の識別子の形）。
  assert.deepEqual(findUnsafeStrings({ note: "Zorvath Keldrin walked" }), []);
  // (2) 連続 8 文字（shingle）で検出。
  assert.throws(
    () => assertOutputClean({ note: "x Zorvath Kel y" }, manuscript),
    /shingle=[1-9]/u,
  );
  // (3) 短い ASCII の語（8 文字未満で shingle に届かない）でも検出。
  assert.equal(countShingleHits("Keldrin", buildShingleSet(manuscript)), 0);
  assert.throws(
    () => assertOutputClean({ error: "bad Keldrin here" }, manuscript),
    /asciiToken=[1-9]/u,
  );
  assert.ok(buildAsciiTokenSet(manuscript).has("keldrin"));
  assert.equal(
    countAsciiTokenHits(
      { status: "ok", hash: "0123456789abcdef" },
      buildAsciiTokenSet(manuscript),
    ),
    0,
  );
});

test("起動前の検査：Wayland・login bus・TMPDIR の外・欠落を止める", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "idl-test-"));
  try {
    chmodSync(out, 0o700);
    const tmp = path.join(out, "tmp");
    mkdirSync(tmp, { mode: 0o700 });
    chmodSync(tmp, 0o700);
    const good = {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-test",
      TMPDIR: tmp,
    };
    assert.doesNotThrow(() => precheckEnvironment(out, good));
    assert.doesNotThrow(() =>
      precheckEnvironment(out, { ...good, XDG_SESSION_TYPE: "x11" }),
    );
    for (const bad of [
      { ...good, WAYLAND_DISPLAY: "wayland-0" },
      { ...good, WAYLAND_SOCKET: "3" },
      { ...good, XDG_SESSION_TYPE: "wayland" },
      { ...good, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      { ...good, TMPDIR: os.tmpdir() },
      { ...good, TMPDIR: "" },
      { ...good, TMPDIR: path.join(out, "missing") },
    ])
      assert.throws(() => precheckEnvironment(out, bad), /\[precheck\]/u);
    chmodSync(tmp, 0o755);
    assert.throws(() => precheckEnvironment(out, good), /mode 0700/u);
    assert.throws(
      () => precheckEnvironment(path.join(out, "x".repeat(90)), good),
      /OUTPUT_PATH_TOO_LONG/u,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("AI の行の確認は fail-closed：DB が無い・table が読めないと verified にならない", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-ai-"));
  try {
    assert.equal(countAiRows(path.join(dir, "absent")).verified, false);
    assert.equal(countAiRows(dir).verified, false);
    const partial = path.join(dir, "partial.db");
    execFileSync("sqlite3", [partial, "CREATE TABLE ai_usage(x);"]);
    const half = countAiRows(dir);
    assert.equal(half.verified, false);
    assert.equal(half.tables.ai_usage, 0);
    execFileSync("sqlite3", [partial, "CREATE TABLE ai_audit_events(x);"]);
    const full = countAiRows(dir);
    assert.equal(full.verified, true);
    assert.deepEqual(full.tables, { ai_audit_events: 0, ai_usage: 0 });
    execFileSync("sqlite3", [partial, "INSERT INTO ai_usage VALUES (1);"]);
    assert.equal(countAiRows(dir).tables.ai_usage, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher と renderer の source：録画・trace・screenshot を使わず、keyring を止める", () => {
  for (const file of ["run-inventory.mjs", "renderer.ts"]) {
    const source = readFileSync(path.join(import.meta.dirname, file), "utf8");
    // 検査語は結合して書く（この試験自体を自己一致させない）。
    for (const word of [
      "recordVi" + "deo",
      "trac" + "ing",
      "screenshot",
      "recordHar",
      "page.pdf",
    ])
      assert.equal(source.includes(word), false, `${file} uses ${word}`);
  }
  const launcher = readFileSync(
    path.join(import.meta.dirname, "run-inventory.mjs"),
    "utf8",
  );
  assert.ok(launcher.includes("--password-store=basic"));
  assert.ok(launcher.includes("--host-resolver-rules="));
});

test("launcher：壊れた原稿 JSON（日本語入り）でも stdout・stderr・出力に非 ASCII を出さない", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "idl-launch-"));
  try {
    chmodSync(base, 0o700);
    const out = path.join(base, "out");
    const data = path.join(base, "data");
    mkdirSync(out, { mode: 0o700 });
    mkdirSync(path.join(out, "tmp"), { mode: 0o700 });
    mkdirSync(data);
    writeFileSync(
      path.join(data, "m-ja-2.json"),
      '{"scenes":[{"index":1,"paragraphs":["架空の人物サンプル太郎が走った"],,,',
    );
    const env = {
      ...process.env,
      TMPDIR: path.join(out, "tmp"),
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-test",
    };
    for (const name of [
      "WAYLAND_DISPLAY",
      "WAYLAND_SOCKET",
      "XDG_SESSION_TYPE",
    ])
      delete env[name];
    const run = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "run-inventory.mjs"),
        "--works",
        "m-ja-2",
        "--output",
        out,
        "--data-dir",
        data,
      ],
      { env, encoding: "utf8", timeout: 120000 },
    );
    assert.notEqual(run.status, 0);
    assert.equal(NON_ASCII.test(run.stdout + run.stderr), false);
    // 入力の断片が ASCII 側にも出ない。
    assert.equal((run.stdout + run.stderr).includes("paragraphs"), false);
    assert.ok(existsSync(path.join(out, "inventory", "m-ja-2.failed.json")));
    for (const dirName of ["inventory"])
      for (const name of readdirSync(path.join(out, dirName))) {
        const text = readFileSync(path.join(out, dirName, name), "utf8");
        assert.equal(NON_ASCII.test(text), false);
        assert.equal(text.includes("paragraphs"), false);
      }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 前提を満たさない起動も、自由文でなく固定形式で止まる。
test("launcher：precheck の失敗は固定形式の 1 行で止まる", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "idl-launch2-"));
  try {
    const env = { ...process.env, WAYLAND_DISPLAY: "wayland-0" };
    const run = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "run-inventory.mjs"), "--output", base],
      { env, encoding: "utf8", timeout: 60000 },
    );
    assert.notEqual(run.status, 0);
    const line = JSON.parse(run.stdout.trim());
    assert.equal(line.status, "launcher-failed");
    assert.equal(line.tag, "precheck");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test(
  "原稿 4 作品：scenes JSON の場面数・段落が計画と一致し、出力に原稿の連続 8 文字が出ない",
  {
    skip: existsSync(DATA_DIR)
      ? false
      : "実データ（repo 外の 0700 の dir）が無い環境では実行しない",
  },
  async () => {
    for (const [key, count] of Object.entries(WORKS)) {
      const work = JSON.parse(readFileSync(resolveWorkSource(key), "utf8"));
      const scenes = scenesFromWork(work);
      assert.equal(scenes.length, count, `${key} scene count`);
      const texts = scenes.map((scene) => expectedSceneText(scene.paragraphs));
      // 正常な出力（hash と件数だけ）は通る。
      const clean = {
        work: key,
        hashes: [await hashSurface(texts[0].slice(0, 3))],
        n: texts.length,
      };
      assert.doesNotThrow(() => assertOutputClean(clean, texts));
      // 原稿から実行時に切り出した 8 文字（テストのコードにも出力にも載せない）を含む出力は落ちる。
      const probe = [...texts[0]].slice(0, 8).join("");
      assert.throws(
        () => assertOutputClean({ note: probe }, texts),
        /unclean: unsafe=[1-9]|shingle=[1-9]/u,
      );
      // 日本語を含まない原稿の断片でも shingle で落ちる経路：ASCII だけの出力に原稿の連続を入れても検出される。
      const shingles = buildShingleSet(texts);
      assert.ok(shingles.size > 1000);
      assert.equal(countShingleHits(JSON.stringify(clean), shingles), 0);
    }
  },
);

test("repo の走査：件数だけを返し、一致の中身は返さない。参考の一致と失敗の一致を分ける（合成）", async () => {
  const { scanText } = await import("./scan-repo-diff.mjs");
  const shingles = buildShingleSet([
    "あいうえおかきくけこ\n",
    "functionAlpha\n",
  ]);
  const material = {
    shingles,
    surfaces: new Set(["架空太郎", "架空"]),
    hashes: new Set(["0123456789abcdef"]),
  };
  assert.deepEqual(scanText("無関係な文 and code 0000000000000000", material), {
    shingleHits: 0,
    asciiShingleHits: 0,
    surfaceHits: 0,
    shortSurfaceHits: 0,
    hashHits: 0,
  });
  assert.deepEqual(
    scanText(
      "x あいうえおかきく y 架空太郎と架空太郎 z 0123456789abcdef function(",
      material,
    ),
    // 架空太郎 2 件（失敗の対象）、架空 2 件（2 文字、参考）。"function(" の先頭 8 文字は ASCII の shingle に一致する（参考）。
    {
      shingleHits: 1,
      asciiShingleHits: 1,
      surfaceHits: 2,
      shortSurfaceHits: 2,
      hashHits: 1,
    },
  );
  assert.equal(scanText("use functionAlpha", material).asciiShingleHits, 6);
});

// ---- 保存済みの未 review の提案の件数（問い 4）-----------------------------------------------

const storedRun = (role, proposals, extra = {}) => ({
  role,
  listedByProduct: true,
  tracked: true,
  runStatus: "completed",
  setStatus: "draft",
  proposals,
  ...extra,
});
const proposalsOf = (kind, status, n, applied = false) =>
  Array.from({ length: n }, () => ({ kind, status, applied }));

test("summarizeStoredProposals：未 review を今回の run と前の回の run に分け、種類は製品の kind の名前で数える", () => {
  const summary = summarizeStoredProposals({
    runs: [
      // 並びは製品の列挙の順（新しい順）。current が先頭とは限らない。
      storedRun("prior", [
        ...proposalsOf("codex.entity.bind", "unreviewed", 3),
        ...proposalsOf("codex.relation.create", "unreviewed", 1),
        ...proposalsOf("codex.entity.bind", "approved", 2),
      ]),
      storedRun("current", [
        ...proposalsOf("codex.entity.bind", "unreviewed", 5),
        ...proposalsOf("codex.phase.bind", "unreviewed", 2),
        ...proposalsOf("codex.entity.bind", "rejected", 1, true),
      ]),
    ],
    listedCount: 2,
  });
  assert.equal(summary.status, "measured");
  assert.equal(summary.runCount, 2);
  assert.equal(summary.currentRunCount, 1);
  assert.equal(summary.priorRunCount, 1);
  assert.equal(summary.unreviewed.total, 11);
  assert.equal(summary.unreviewed.currentRun, 7);
  assert.equal(summary.unreviewed.priorRuns, 4);
  assert.equal(summary.unreviewed.priorRunsByKind["codex.entity.bind"], 3);
  assert.equal(summary.unreviewed.priorRunsByKind["codex.relation.create"], 1);
  assert.equal(summary.unreviewed.currentRunByKind["codex.phase.bind"], 2);
  assert.equal(summary.stored.total, 14);
  assert.equal(summary.stored.byStatus.unreviewed, 11);
  assert.equal(summary.stored.byStatus.approved, 2);
  assert.equal(summary.stored.byStatus.rejected, 1);
  assert.equal(summary.stored.applied, 1);
  // key は 0 件でも残す（形が固定）。run ごとの行は current が先頭。
  assert.deepEqual(Object.keys(summary.unreviewed.byKind), [
    ...STORED_PROPOSAL_KINDS,
    "other",
  ]);
  assert.deepEqual(
    summary.perRun.map((r) => [r.role, r.total, r.unreviewed]),
    [
      ["current", 8, 7],
      ["prior", 6, 4],
    ],
  );
  assert.equal(summary.listTruncated, false);
});

test("summarizeStoredProposals：0 件は 0（未計測ではない）。未知の kind・status・run の状態は other に落とし、原文を出力に残さない", () => {
  const empty = summarizeStoredProposals({
    runs: [storedRun("current", [])],
    listedCount: 1,
  });
  assert.equal(empty.status, "measured");
  assert.equal(empty.unreviewed.total, 0);
  assert.equal(empty.stored.total, 0);
  // 製品が将来 kind／status を増やした、または payload の自由文が混ざった場合でも、語を原形で出力しない。
  const odd = summarizeStoredProposals({
    runs: [
      storedRun(
        "current",
        [
          { kind: "山田太郎の項目", status: "unreviewed", applied: false },
          { kind: "codex.entity.bind", status: "山田太郎", applied: false },
        ],
        { runStatus: "山田太郎", setStatus: "山田太郎" },
      ),
    ],
    listedCount: 1,
  });
  assert.equal(odd.unreviewed.total, 1);
  assert.equal(odd.unreviewed.byKind.other, 1);
  assert.equal(odd.stored.byStatus.other, 1);
  assert.equal(odd.perRun[0].runStatus, "other");
  assert.equal(odd.perRun[0].setStatus, "other");
  assert.doesNotMatch(JSON.stringify(odd), /山田/u);
  assert.deepEqual(findUnsafeStrings(odd), []);
  assert.doesNotThrow(() => assertOutputClean(odd, ["昔々、ある所に"]));
});

test("summarizeStoredProposals：製品の列挙が上限に達したら打ち切りの旗を立て、今回の run が 2 つなら止まる", () => {
  const truncated = summarizeStoredProposals({
    runs: [storedRun("current", [])],
    listedCount: 100,
  });
  assert.equal(truncated.listTruncated, true);
  assert.equal(truncated.listLimit, 100);
  // 列挙に載らない保存済みの run（再開できる run でない）は、数えた上で旗に出す。道具が保存していない run も旗に出す。
  const notListed = summarizeStoredProposals({
    runs: [
      storedRun("current", [], { listedByProduct: false }),
      storedRun("prior", [], { listedByProduct: false }),
      storedRun("prior", [], { tracked: false }),
    ],
    listedCount: 1,
  });
  assert.equal(notListed.trackedNotListedByProductCount, 2);
  assert.equal(notListed.untrackedRunCount, 1);
  // 道具が控えていない run は「前の回」に数えず、採用しなかった run として別に持つ（役割は untracked）。
  assert.equal(notListed.priorRunCount, 1);
  assert.equal(notListed.notAdoptedRunCount, 1);
  assert.deepEqual(
    notListed.perRun.map((r) => [r.role, r.tracked, r.listedByProduct]),
    [
      ["current", true, false],
      ["prior", true, false],
      ["untracked", false, true],
    ],
  );
  assert.throws(
    () =>
      summarizeStoredProposals({
        runs: [storedRun("current", []), storedRun("current", [])],
        listedCount: 2,
      }),
    /STORED_CURRENT_RUN_NOT_UNIQUE/u,
  );
});

test("planStoredRuns：製品の列挙に、道具が保存した前の段の run も足す（一覧から落ちた run の未 review を 0 と読まない）", () => {
  // 製品の列挙（新しい順）に前の段 s1 が無い（status が再開できる状態でない等）。s2・s3 は載る。
  const plan = planStoredRuns({
    listedIds: ["s3", "x9", "s2"],
    trackedIds: ["s1", "s2", "s3"],
  });
  assert.deepEqual(
    plan.map((r) => [r.runId, r.role, r.listedByProduct, r.tracked]),
    [
      ["s3", "current", true, true],
      ["x9", "prior", true, false], // 列挙にだけある（道具が保存していない）
      ["s2", "prior", true, true],
      ["s1", "prior", false, true], // 控えにだけある（列挙から落ちた前の段）
    ],
  );
  // 今回の run が列挙に無くても current として足す。保存した run が無ければ current は無い。
  assert.deepEqual(
    planStoredRuns({ listedIds: [], trackedIds: ["s1"] }).map((r) => [
      r.runId,
      r.role,
      r.listedByProduct,
    ]),
    [["s1", "current", false]],
  );
  assert.ok(
    planStoredRuns({ listedIds: ["a"], trackedIds: [] }).every(
      (r) => r.role === "prior",
    ),
  );
  // 一覧から落ちた前の段の未 review が、前の回の件数に入る。
  const summary = summarizeStoredProposals({
    runs: plan.map((r) =>
      storedRun(r.role, proposalsOf("codex.entity.bind", "unreviewed", 2), {
        listedByProduct: r.listedByProduct,
        tracked: r.tracked,
      }),
    ),
    listedCount: 3,
  });
  // 道具が控えていない run（x9）は前の回に数えない（採用しなかった run として別に数える）。
  assert.equal(summary.unreviewed.priorRuns, 4);
  assert.equal(summary.unreviewed.notAdoptedRuns, 2);
  assert.equal(summary.unreviewed.total, 8);
  assert.equal(summary.trackedNotListedByProductCount, 1);
});

test("失敗した段の run は前の回の run に数えない：planStoredRuns の failedIds と、summarizeStoredProposals の採用しなかった run の列", () => {
  // s1・s2 は採用した段の run。f1 は run を作った後にその段が失敗した run（採用されず、控えにも入らない）。
  // f1 は製品の列挙に載るので、列挙の和集合でも現れる。
  const plan = planStoredRuns({
    listedIds: ["s2", "f1", "s1"],
    trackedIds: ["s1", "s2"],
    failedIds: ["f1"],
  });
  assert.deepEqual(
    plan.map((r) => [r.runId, r.role, r.tracked, r.failedStage]),
    [
      ["s2", "current", true, false],
      ["f1", "prior", false, true],
      ["s1", "prior", true, false],
    ],
  );
  // 列挙に載らない失敗した段の run も、控えから足して読む（DB に残る未 review を 0 と読まない）。
  assert.deepEqual(
    planStoredRuns({
      listedIds: [],
      trackedIds: ["s1"],
      failedIds: ["f9"],
    }).map((r) => [r.runId, r.listedByProduct, r.failedStage]),
    [
      ["s1", false, false],
      ["f9", false, true],
    ],
  );
  const summary = summarizeStoredProposals({
    runs: plan.map((r) =>
      storedRun(
        r.role,
        proposalsOf(
          "codex.entity.bind",
          "unreviewed",
          r.runId === "f1" ? 7 : 2,
        ),
        {
          listedByProduct: r.listedByProduct,
          tracked: r.tracked,
          failedStage: r.failedStage,
        },
      ),
    ),
    listedCount: 3,
  });
  // 前の回は採用した前の段（s1 の 2 件）だけ。失敗した段の 7 件は別の列。
  assert.equal(summary.unreviewed.priorRuns, 2);
  assert.equal(summary.unreviewed.currentRun, 2);
  assert.equal(summary.unreviewed.notAdoptedRuns, 7);
  assert.equal(summary.unreviewed.total, 11);
  assert.equal(summary.stored.priorRuns, 2);
  assert.equal(summary.stored.notAdoptedRuns, 7);
  assert.equal(summary.priorRunCount, 1);
  assert.equal(summary.notAdoptedRunCount, 1);
  assert.equal(summary.failedStageRunCount, 1);
  assert.equal(summary.untrackedRunCount, 0);
  assert.deepEqual(
    summary.perRun.map((r) => r.role),
    ["current", "prior", "failed-stage"],
  );
  assert.equal(
    summary.unreviewed.total,
    summary.unreviewed.currentRun +
      summary.unreviewed.priorRuns +
      summary.unreviewed.notAdoptedRuns,
  );
});

test("planProductVisibleRuns：製品の restore が作者に出す run は、folder ごとに、列挙（新しい順）の先頭 8 件のうち再開できる最初の run", () => {
  const run = (runId, folderKey, runStatus = "completed") => ({
    runId,
    folderKey,
    runStatus,
  });
  // folder A の新しい run a2 が見え、古い a1 は見えない。folder B の b1 は見える。再開できない状態の run は出ない。
  assert.deepEqual(
    [
      ...planProductVisibleRuns({
        listed: [
          run("a2", "A"),
          run("x", "C", "failed"),
          run("b1", "B"),
          run("a1", "A"),
        ],
      }),
    ],
    ["a2", "b1"],
  );
  // 先頭 8 件より後ろは、製品の列挙（limit 8）に載らないので出ない。
  const long = Array.from({ length: 9 }, (_, i) => run(`r${i}`, `F${i}`));
  const visible = planProductVisibleRuns({ listed: long });
  assert.equal(visible.size, 8);
  assert.equal(visible.has("r8"), false);
  assert.equal(planProductVisibleRuns({ listed: [] }).size, 0);
});

test("summarizeStoredProposals：未 review を、作者に見える run の分とそれ以外に分ける（合計は変わらない）", () => {
  const summary = summarizeStoredProposals({
    runs: [
      storedRun("current", proposalsOf("codex.entity.bind", "unreviewed", 5), {
        visibleToAuthor: true,
      }),
      // 前の回の run。同じ folder の新しい run があるので作者の画面には出ない。
      storedRun("prior", proposalsOf("codex.entity.bind", "unreviewed", 3), {
        visibleToAuthor: false,
      }),
      // 別の folder の前の回の run は、その folder を開けば出る。
      storedRun(
        "prior",
        [
          ...proposalsOf("codex.relation.create", "unreviewed", 2),
          ...proposalsOf("codex.entity.bind", "approved", 4),
        ],
        { visibleToAuthor: true },
      ),
      // 欄が無い run は見えるとは数えない。
      storedRun("prior", proposalsOf("codex.entity.bind", "unreviewed", 1)),
    ],
    listedCount: 4,
  });
  assert.equal(summary.unreviewed.total, 11);
  assert.equal(summary.unreviewed.visibleToAuthor, 7);
  assert.equal(summary.unreviewed.notVisibleToAuthor, 4);
  assert.equal(
    summary.unreviewed.visibleToAuthor + summary.unreviewed.notVisibleToAuthor,
    summary.unreviewed.total,
  );
  assert.equal(summary.visibleToAuthorRunCount, 2);
  assert.equal(
    summary.unreviewed.visibleToAuthorByKind["codex.entity.bind"],
    5,
  );
  assert.equal(
    summary.unreviewed.visibleToAuthorByKind["codex.relation.create"],
    2,
  );
  assert.deepEqual(
    summary.perRun.map((r) => r.visibleToAuthor),
    [true, false, true, false],
  );
  assert.equal(summary.restoreListLimit, 8);
  // folder の識別子が読めた run は 0 件が正常。読めない run は数えて出す（見える分が過少のとき気づけるように）。
  assert.equal(summary.folderUnknownRunCount, 4);
  const known = summarizeStoredProposals({
    runs: [
      storedRun("current", [], { visibleToAuthor: true, folderKnown: true }),
      storedRun("prior", [], { folderKnown: false }),
    ],
    listedCount: 2,
  });
  assert.equal(known.folderUnknownRunCount, 1);
  assert.deepEqual(
    known.perRun.map((r) => r.folderKnown),
    [true, false],
  );
});

test("planStoredRead／storedNotMeasured：保存つきの段だけ読む。保存しない段・保存の失敗は 0 件でなく未計測", () => {
  assert.deepEqual(planStoredRead({ status: "ok" }), { read: true });
  for (const [attempt, reason] of [
    [{ status: "not-attempted" }, "persist-skipped"],
    [undefined, "persist-skipped"],
    [{ status: "failed", name: "Error" }, "persist-failed"],
  ]) {
    const plan = planStoredRead(attempt);
    assert.equal(plan.read, false);
    assert.equal(plan.result.status, "not-measured");
    assert.equal(plan.result.reason, reason);
    assert.equal("unreviewed" in plan.result, false);
  }
  assert.equal(storedNotMeasured("read-failed", { name: "X" }).error.name, "X");
  assert.throws(() => storedNotMeasured("whatever"), /unknown not-measured/u);
});

test("compareStoredWithProjection：今回の run の保存済みの件数を、同じ段の projection の件数と種類ごとに比べる", () => {
  const stored = summarizeStoredProposals({
    runs: [
      storedRun("current", [
        ...proposalsOf("codex.entity.bind", "unreviewed", 4),
        ...proposalsOf("codex.relation.create", "unreviewed", 2),
      ]),
    ],
    listedCount: 1,
  });
  assert.deepEqual(
    compareStoredWithProjection(stored, {
      entityProposalCount: 4,
      relationProposalCount: 2,
      baseDetailProposalCount: 0,
      phaseProposalCount: 0,
    }),
    { compared: true, ok: true, differingKinds: [] },
  );
  assert.deepEqual(
    compareStoredWithProjection(stored, {
      entityProposalCount: 5,
      relationProposalCount: 2,
      baseDetailProposalCount: 0,
      phaseProposalCount: 1,
    }),
    {
      compared: true,
      ok: false,
      differingKinds: ["codex.entity.bind", "codex.phase.bind"],
    },
  );
  // 未計測、または今回の run が無いときは比べない（ok を true と偽らない）。
  assert.equal(
    compareStoredWithProjection(storedNotMeasured("persist-skipped"), {}).ok,
    null,
  );
});

test("保存済みの提案を読む command は AI／外部通信の command ではない（保存を読むだけで、cell の採用を落とさない）", () => {
  assert.deepEqual(
    findAiCommands([
      "narrative_extraction_list_resumable_runs",
      "narrative_extraction_get_run_review_bundle",
      "narrative_extraction_get_run",
      "nir1_change_review_read",
    ]),
    [],
  );
});

test("失敗の分類（F2 の R7）：IPC の timeout は再送しない種類に分け、再送してよいのは送られていないと言える失敗だけ", () => {
  const kind = (error) => classifyJudgmentFailure(error).kind;
  // IPC の timeout（tauri.ts の IpcInvokeError の code・文面のどちらでも）は ipc-timeout。timed out の語があっても network にしない。
  assert.equal(
    kind(
      Object.assign(
        new Error("IPC timeout after 300000ms: send_chat_message"),
        { code: "IPC_TIMEOUT" },
      ),
    ),
    "ipc-timeout",
  );
  assert.equal(
    kind(new Error("IPC timeout after 300000ms: send_chat_message")),
    "ipc-timeout",
  );
  assert.equal(
    kind({ code: "IPC_TIMEOUT", message: "timed out" }),
    "ipc-timeout",
  );
  // 接続が張れる前に終わったと言える語だけ network-unsent。
  for (const text of [
    "error sending request: dns error: failed to lookup address information",
    "getaddrinfo ENOTFOUND api.example.invalid",
    "getaddrinfo EAI_AGAIN api.example.invalid",
    "connect ECONNREFUSED 203.0.113.1:443",
    "tcp connect error: Connection refused (os error 111)",
  ])
    assert.equal(kind(new Error(text)), "network-unsent", text);
  // 届いたか分からないもの（timeout・reset・hang up・文面だけでは分からない送信の失敗）は network（再送しない）。
  for (const text of [
    "read ECONNRESET",
    "socket hang up",
    "request timed out",
    "connect ETIMEDOUT 203.0.113.1:443",
    "fetch failed",
    "dns error: lookup timed out",
  ])
    assert.equal(kind(new Error(text)), "network", text);
  // 文面から通信の失敗と分からないもの（reqwest の "error sending request" だけなど）は other。再送せず、台帳が停止する。
  assert.equal(kind(new Error("error sending request for url")), "other");
  // 429・5xx は従来どおり。
  assert.equal(kind(new Error("HTTP 429 too many requests")), "rate-limit");
  assert.equal(kind(new Error("status 529 overloaded")), "server");
  assert.deepEqual(
    [...RETRYABLE_FAILURE_KINDS],
    ["rate-limit", "server", "network-unsent"],
  );
  for (const k of [
    "ipc-timeout",
    "network",
    "other",
    "no-valid-result",
    "auth",
  ])
    assert.ok(!RETRYABLE_FAILURE_KINDS.includes(k), k);
});

test("失敗の分類（F3a の m1）：Rust の文面の括弧の status を優先して読み、届いたか分からない語は数字より先に見て再送しない側へ倒す", () => {
  const classify = (text) => classifyJudgmentFailure(new Error(text));
  const retryable = (text) =>
    RETRYABLE_FAILURE_KINDS.includes(classify(text).kind);
  // 届いたか分からない語は、文中の status らしい数字があっても network（再送しない）。
  for (const text of [
    "timed out after 500 ms",
    "connection reset (status 502 bad gateway)",
    "request timeout (status 503)",
    "write EPIPE",
    "broken pipe while sending",
    "operation timed out: HTTP 504",
    "unexpected EOF during read, status 500",
  ]) {
    assert.equal(classify(text).kind, "network", text);
    assert.equal(retryable(text), false, text);
  }
  // 応答が返った失敗の文面 "AI request failed (NNN)"／"(HTTP NNN)" は、括弧の status が正本（本文の数字・語に引きずられない）。
  assert.deepEqual(
    classify("AI request failed (400): invalid request, max 512 tokens"),
    {
      kind: "other",
      httpStatus: 400,
    },
  );
  assert.deepEqual(
    classify("AI request failed (400): rate limit header is missing"),
    {
      kind: "other",
      httpStatus: 400,
    },
  );
  assert.equal(retryable("AI request failed (400): found 512 items"), false);
  assert.equal(retryable("AI request failed (400): rate limit"), false);
  assert.deepEqual(classify("AI request failed (429): slow down"), {
    kind: "rate-limit",
    httpStatus: 429,
  });
  assert.deepEqual(classify("AI request failed (HTTP 503): unavailable"), {
    kind: "server",
    httpStatus: 503,
  });
  assert.deepEqual(classify("AI request failed (529): Overloaded"), {
    kind: "server",
    httpStatus: 529,
  });
  assert.deepEqual(classify("AI request failed (401): invalid x-api-key"), {
    kind: "auth",
    httpStatus: 401,
  });
  // 応答が返った（status が括弧にある）なら、本文に reset・timeout の語があっても応答の失敗として扱う（5xx は再送してよい）。
  assert.deepEqual(
    classify("AI request failed (502): upstream connection reset"),
    {
      kind: "server",
      httpStatus: 502,
    },
  );
  // status の語を伴わない数字は status にしない（再送しない）。接続前の失敗は従来どおり再送してよい。
  assert.equal(classify("upstream said 503 service unavailable").kind, "other");
  assert.equal(retryable("upstream said 503 service unavailable"), false);
  assert.equal(retryable("getaddrinfo ENOTFOUND api.example.invalid"), true);
  assert.equal(retryable("HTTP 429 too many requests"), true);
  assert.equal(retryable("status 529 overloaded"), true);
  assert.equal(retryable("error sending request for url"), false);
});

test("runGuardedJudge（F3a の m6）：guard が 1 つでも通らなければ judge を呼ばない。全部通ったときだけ 1 回呼ぶ", async () => {
  const roleOk = {
    nonDefaultRoleKeys: 0,
    roleProvidersNonDefault: false,
    sendOverrideClear: true,
  };
  const make = (override = {}) => {
    const calls = [];
    const deps = {
      sendArmed: true,
      blockedByPolicyOrLicense: () => {
        calls.push("policy");
        return false;
      },
      visibleCount: 3,
      assertRoleDefaults: async () => {
        calls.push("role");
        return roleOk;
      },
      countHiddenInSentWindow: async () => {
        calls.push("hidden");
        return 0;
      },
      judge: async () => {
        calls.push("judge");
        return { ok: true, judgments: [], durationMs: 1 };
      },
      ...override,
    };
    return { deps, calls };
  };
  // 全部通れば、guard の順（policy→役割→hidden）の後で judge を 1 回だけ呼び、judge の結果を加工せず返す。
  const pass = make();
  assert.deepEqual(await runGuardedJudge(pass.deps), {
    ok: true,
    judgments: [],
    durationMs: 1,
  });
  assert.deepEqual(pass.calls, ["policy", "role", "hidden", "judge"]);
  // どれかが通らなければ judge は 0 回で、理由の分類だけを返す。
  const roleBad = (patch) => async () => ({ ...roleOk, ...patch });
  for (const [override, kind] of [
    [{ sendArmed: false }, "not-armed"],
    [{ blockedByPolicyOrLicense: () => true }, "policy-or-license"],
    [{ visibleCount: 0 }, "no-candidates"],
    [
      { assertRoleDefaults: roleBad({ nonDefaultRoleKeys: 1 }) },
      "role-override",
    ],
    [
      { assertRoleDefaults: roleBad({ roleProvidersNonDefault: true }) },
      "role-override",
    ],
    [
      { assertRoleDefaults: roleBad({ sendOverrideClear: false }) },
      "role-override",
    ],
    [
      {
        assertRoleDefaults: async () => {
          throw new Error("settings unreadable");
        },
      },
      "role-override",
    ],
    [{ assertRoleDefaults: async () => undefined }, "role-override"],
    [{ countHiddenInSentWindow: async () => 2 }, "hidden-roster"],
    [
      {
        countHiddenInSentWindow: async () => {
          throw new Error("db unreadable");
        },
      },
      "hidden-roster",
    ],
  ]) {
    const { deps, calls } = make(override);
    const result = await runGuardedJudge(deps);
    assert.deepEqual(result, { ok: false, kind, durationMs: 0 }, kind);
    assert.ok(!calls.includes("judge"), kind);
  }
  // 役割の確認が通らなければ hidden の確認にも進まない（順序）。
  const ordered = make({
    assertRoleDefaults: roleBad({ nonDefaultRoleKeys: 1 }),
  });
  await runGuardedJudge(ordered.deps);
  assert.ok(!ordered.calls.includes("hidden"));
});

// ---- 名簿の型が catalog に入ったか（F3b の m2）----------------------------------------------

/**
 * 製品の buildCodexStructureCatalogs の型の落とし方（codexStructureExtractionApi.ts の existingCatalog。
 * project の型の一覧に無い型の Entry は先頭の型に落ちる）を写した fake。写しが製品と合うことは product-parity.test が見る。
 */
function fakeProductCatalog(entries, projectTypes) {
  const typeCatalog = projectTypes.map((slug, index) => ({
    ref: `T${String(index + 1).padStart(4, "0")}`,
    slug,
  }));
  const refBySlug = new Map(typeCatalog.map((t) => [t.slug, t.ref]));
  const existingCatalog = entries.map((entry, index) => ({
    sourceKey: entry.id,
    typeRef: refBySlug.get(entry.type) ?? typeCatalog[0]?.ref ?? "T0001",
    ref: `K${index + 1}`,
  }));
  return { typeCatalog, existingCatalog };
}

test("名簿の型が catalog に入ったか：型が project の型の一覧に有れば通り、無ければ先頭の型への落ちとして止める（件数だけ）", () => {
  const entries = [
    { id: "e1", type: "character" },
    { id: "e2", type: "location" },
    { id: "e3", type: "lore" },
  ];
  const ok = fakeProductCatalog(entries, ["character", "location", "lore"]);
  assert.deepEqual(checkEntryTypesInCatalog({ entries, ...ok }), {
    determinable: true,
    checked: 3,
    missingFromCatalog: 0,
    typeMismatch: 0,
  });
  assert.doesNotThrow(() => assertEntryTypesInCatalog({ entries, ...ok }));
  // project の型の一覧に lore が無い：製品は e3 を先頭の型（character）に落とす。
  const fallen = fakeProductCatalog(entries, ["character", "location"]);
  assert.equal(
    checkEntryTypesInCatalog({ entries, ...fallen }).typeMismatch,
    1,
  );
  assert.throws(
    () => assertEntryTypesInCatalog({ entries, ...fallen }),
    /\[precheck\] ENTRY_TYPE_NOT_IN_CATALOG checked=3 missing=0 typeMismatch=1$/u,
  );
  // 型の一覧の順序が違っても、slug が合えば通る（先頭かどうかでなく、slug で比べる）。
  const reordered = fakeProductCatalog(entries, [
    "lore",
    "location",
    "character",
  ]);
  assert.doesNotThrow(() =>
    assertEntryTypesInCatalog({ entries, ...reordered }),
  );
  // catalog に Entry が載っていない。
  assert.throws(
    () =>
      assertEntryTypesInCatalog({
        entries,
        typeCatalog: ok.typeCatalog,
        existingCatalog: ok.existingCatalog.slice(0, 2),
      }),
    /ENTRY_TYPE_NOT_IN_CATALOG checked=3 missing=1 typeMismatch=0/u,
  );
  // 返す文に id・型の文字列を含まない。
  try {
    assertEntryTypesInCatalog({ entries, ...fallen });
  } catch (error) {
    assert.ok(!/e3|lore|character/u.test(error.message));
  }
});

test("名簿の型が catalog に入ったか：判定できなければ（型の一覧が空・型が文字列でない・入力の形が違う）止める。Entry が 0 件なら通る", () => {
  const entries = [{ id: "e1", type: "character" }];
  for (const input of [
    { entries, existingCatalog: [], typeCatalog: [] },
    {
      entries: [{ id: "e1", type: null }],
      existingCatalog: [],
      typeCatalog: [{ ref: "T1", slug: "character" }],
    },
    { entries, existingCatalog: undefined, typeCatalog: [] },
    { entries: undefined, existingCatalog: [], typeCatalog: [] },
  ])
    assert.throws(
      () => assertEntryTypesInCatalog(input),
      /ENTRY_TYPE_CATALOG_UNDETERMINABLE/u,
    );
  assert.doesNotThrow(() =>
    assertEntryTypesInCatalog({
      entries: [],
      existingCatalog: [],
      typeCatalog: [{ ref: "T1", slug: "character" }],
    }),
  );
});
