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
  FOLDER_PERCENTS,
  HONORIFIC_SUFFIXES,
  WORKS,
  EXTERNAL_COMMANDS,
  assertOutputClean,
  buildAsciiTokenSet,
  buildShingleSet,
  compareHashSets,
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
  safeErrorSummary,
  sanitizeError,
  scenesFromWork,
  stripHonorific,
  summarizeCandidateInventory,
  summarizeSeedInventory,
  surfaceOverlapCounts,
} from "./lib.mjs";
import { countAiRows, precheckEnvironment } from "./run-inventory.mjs";

const NON_ASCII = /[^ -~\n\r\t]/u;
const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATA_DIR = "/home/grimodex/fusion-eval-data/pd-2026-11/scenes";

test("入れ子 folder の累積の場面数は ceil(N×k%)", () => {
  assert.deepEqual(nestedFolderSceneCounts(110), [28, 55, 83, 110]);
  assert.deepEqual(nestedFolderSceneCounts(117), [30, 59, 88, 117]);
  assert.deepEqual(nestedFolderSceneCounts(34), [9, 17, 26, 34]);
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

test("一括承認可は applicable・unreviewed・safe の 3 条件（blocked で safe の提案は数えない）", () => {
  const rows = [
    { applicability: "applicable", status: "unreviewed", safe: true },
    { applicability: "blocked", status: "unreviewed", safe: true },
    { applicability: "applicable", status: "approved", safe: true },
    { applicability: "applicable", status: "unreviewed", safe: false },
  ];
  assert.equal(countBulkApprovable(rows), 1);
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
      path.join(data, "m-ja-3.json"),
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
        "m-ja-3",
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
    assert.ok(existsSync(path.join(out, "inventory", "m-ja-3.failed.json")));
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
  { skip: !existsSync(DATA_DIR) },
  async () => {
    for (const [key, count] of Object.entries(WORKS)) {
      const work = JSON.parse(
        readFileSync(path.join(DATA_DIR, `${key}.json`), "utf8"),
      );
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
