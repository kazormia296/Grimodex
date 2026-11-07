// 注釈の表示（本文を含む）を repo の外に作る／注釈者が記入した表示を注釈 file に取り込む。
// この script 自体は本文を含まない。出力（sheet-<annotator>.md・sheet-key.json）は repo の外だけ。
// 候補は由来（IR／Raw）・順位・位置・作品を隠し、seed 固定で混ぜる。Scene には匿名 ID（seed 固定の hash の 6 桁）を付け、
// 同じ Scene の 2 回目以降は本文を繰り返さず参照だけにする。候補 0 件の query は出さない。対応表は sheet-key.json。
//
// 使い方：
//   node render-annotation-sheet.mjs --selection <selection-run1.json> --annotator <user|…> \
//        [--scenes-dir <dir>] [--out-dir <repo 外の dir>]
//   node render-annotation-sheet.mjs --ingest <記入済み sheet.md> --key <sheet-key.json> \
//        --annotator <名> --out <annotations.json> [--allow-partial] [--key-section run2Additions]
//   run 2 の追加分（run 1 に無い組だけ）：
//   node render-annotation-sheet.mjs --selection <selection-run2.json> --additions-of <selection-run1.json> \
//        --annotator <名> [--scenes-dir <dir>] [--out-dir <repo 外の dir>]   → sheet-<名>-run2.md、sheet-key.json に run2Additions を足す
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileSha256 } from "./agg-pg.mjs";
import {
  SCENES_DIR,
  SHEET_DIR,
  assertOutsideRepo,
  byMixKey,
  loadPrompt,
  loadScenes,
  mixKey,
  readJson,
  sceneText,
} from "./pg-common.mjs";

const quote = (text) =>
  text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/** Scene の匿名 ID：種・作品・位置だけから決まる固定の 6 桁（由来・順位・query には依らない。IR／Raw で形も同じ）。 */
export const anonId = (seed, work, position) => mixKey(seed, "anon", work, position).slice(0, 6);

/**
 * sheet の順序と対応表（本文なし）。候補が 0 件の query は sheet に出さない（excluded に記録）。
 * Scene ごとに匿名 ID を付け、対応（作品・位置）は対応表（sheet-key.json）だけに置く。
 */
export function planSheet(selection, seed = selection.seed) {
  const withCandidates = selection.queries.filter((q) => q.candidates.length > 0);
  const queries = [...withCandidates]
    .sort((a, b) =>
      byMixKey(
        mixKey(seed, "sheet-query", a.work, a.queryPosition),
        mixKey(seed, "sheet-query", b.work, b.queryPosition),
      ),
    )
    .map((q, i) => ({
      id: `Q${String(i + 1).padStart(2, "0")}`,
      work: q.work,
      queryPosition: q.queryPosition,
      anonId: anonId(seed, q.work, q.queryPosition),
      candidates: [...q.candidates]
        .sort((a, b) =>
          byMixKey(
            mixKey(seed, "sheet-cand", q.work, q.queryPosition, a.position),
            mixKey(seed, "sheet-cand", q.work, q.queryPosition, b.position),
          ),
        )
        .map((c, j) => ({ id: `C${j + 1}`, position: c.position, anonId: anonId(seed, q.work, c.position) })),
    }));
  // 別の Scene が同じ ID になったら（確率は小さい）、種を変えずに止める
  const owner = new Map();
  for (const q of queries)
    for (const [work, position, id] of [[q.work, q.queryPosition, q.anonId], ...q.candidates.map((c) => [q.work, c.position, c.anonId])]) {
      const key = `${work}|${position}`;
      assert.ok(!owner.has(id) || owner.get(id) === key, `[precheck] 匿名 ID が衝突した: ${id}`);
      owner.set(id, key);
    }
  return queries;
}

/** sheet の順で、Scene（匿名 ID）が最初に出た見出しの名前（今の Scene → 候補の順。renderSheet の既出の判定と同じ順）。 */
export function firstSeenLabels(plan) {
  const seen = new Map();
  for (const q of plan) {
    if (!seen.has(q.anonId)) seen.set(q.anonId, q.id);
    for (const c of q.candidates) if (!seen.has(c.anonId)) seen.set(c.anonId, `${q.id}-${c.id}`);
  }
  return seen;
}

/**
 * run 2 の追加分の sheet の順序と対応表（本文なし）。run 2 の selection のうち、run 1 に無い組（newPair）だけを候補にし、
 * 新しい組が 1 件以上ある query だけを出す。ID は R01…（run 1 の sheet の Q01… と区別）。順序の鍵は run 1 と別の名前空間。
 * 匿名 ID は run 1 と同じ規則（種・作品・位置だけから決まる）なので、同じ Scene は run 1 の sheet と同じ ID になる。
 */
export function planSheetRun2(selection2, selection1, seed = selection2.seed) {
  const plan1 = planSheet(selection1);
  const withNew = selection2.queries
    .map((q) => ({ ...q, candidates: q.candidates.filter((c) => c.newPair === true) }))
    .filter((q) => q.candidates.length > 0);
  const queries = [...withNew]
    .sort((a, b) =>
      byMixKey(
        mixKey(seed, "sheet-query-run2", a.work, a.queryPosition),
        mixKey(seed, "sheet-query-run2", b.work, b.queryPosition),
      ),
    )
    .map((q, i) => ({
      id: `R${String(i + 1).padStart(2, "0")}`,
      work: q.work,
      queryPosition: q.queryPosition,
      anonId: anonId(seed, q.work, q.queryPosition),
      candidates: [...q.candidates]
        .sort((a, b) =>
          byMixKey(
            mixKey(seed, "sheet-cand-run2", q.work, q.queryPosition, a.position),
            mixKey(seed, "sheet-cand-run2", q.work, q.queryPosition, b.position),
          ),
        )
        .map((c, j) => ({ id: `C${j + 1}`, position: c.position, anonId: anonId(seed, q.work, c.position) })),
    }));
  // run 1 と run 2 を通して、別の Scene が同じ ID になったら止める
  const owner = new Map();
  for (const q of [...plan1, ...queries])
    for (const [work, position, id] of [[q.work, q.queryPosition, q.anonId], ...q.candidates.map((c) => [q.work, c.position, c.anonId])]) {
      const key = `${work}|${position}`;
      assert.ok(!owner.has(id) || owner.get(id) === key, `[precheck] 匿名 ID が衝突した: ${id}`);
      owner.set(id, key);
    }
  return queries;
}

/** 候補が 0 件で sheet に出さない query（対応表に記録する。本文なし）。 */
export const excludedQueries = (selection) =>
  selection.queries
    .filter((q) => q.candidates.length === 0)
    .map((q) => ({ work: q.work, queryPosition: q.queryPosition, reason: "no-candidates" }));

export function renderSheet({
  selection,
  scenes,
  annotator,
  plan = planSheet(selection),
  prompt,
  seenInit = new Map(),
  title = `注釈シート（${annotator}）`,
  idExample = "Q01",
  notes = [],
}) {
  const lines = [
    `# ${title}`,
    "",
    "## 読み方",
    "",
    ...notes,
    `- 各質問（${idExample}…）は「今の Scene」と複数の「候補」を並べます。候補ごとに、下の設問に従って**判定**を記入してください。`,
    "- 候補の順序は無作為です。他の注釈者の値は見えません。",
    "- **ID**（6 桁）は Scene を区別するだけの番号で、他の意味はありません。同じ ID は同じ Scene です。",
    "- 同じ Scene が前に出ているとき、本文は繰り返さず「→ ID xxxxxx（既出：Q03-C2）」のように参照だけを書きます。",
    "  本文は参照先の見出し（同じ ID）に戻って読んでください。判定はその Scene について、いまの質問の文脈で付けます。",
    "- 注釈の途中は、selection の file と sheet-key.json を開かないでください（候補の件数などから、候補の出どころを推測できてしまうため）。",
    "",
    "判定の記入：`判定:` の後に **s**（strict）／**p**（partial のみ）／**n**（none）のどれか 1 文字（`strict`／`partial`／`none`／`2`／`1`／`0` も可）。",
    "",
    prompt.criteria,
    "",
    "---",
  ];
  const seen = new Map(seenInit); // anonId → 初出の見出しの名前（sheet の順で最初に出た場所）
  const emit = (id, label, work, position) => {
    const scene = scenes[work].byPosition.get(position);
    assert.ok(scene, `${work}@${position} の Scene が無い`);
    if (seen.has(id)) lines.push(`ID: ${id}`, "", `→ ID ${id}（既出：${seen.get(id)}）`);
    else {
      seen.set(id, label);
      lines.push(`ID: ${id}`, "", quote(sceneText(scene)));
    }
  };
  for (const q of plan) {
    lines.push("", `## ${q.id}`, "", `### ${q.id} 今の Scene`, "");
    emit(q.anonId, q.id, q.work, q.queryPosition);
    for (const c of q.candidates) {
      lines.push("", `### ${q.id}-${c.id} 候補`, "");
      emit(c.anonId, `${q.id}-${c.id}`, q.work, c.position);
      lines.push("", "判定:");
    }
    lines.push("", "---");
  }
  return `${lines.join("\n")}\n`;
}

const LABEL_ALIASES = {
  s: "strict", strict: "strict", "2": "strict",
  p: "partial", partial: "partial", "1": "partial",
  n: "none", none: "none", "0": "none",
};

/** 記入済みの sheet から注釈を取り込む（`### Qxx-Cy 候補` の後の最初の `判定:` 行）。 */
export function ingestSheet(sheetText, key, { annotator, allowPartial = false }) {
  const index = new Map();
  for (const q of key.queries)
    for (const c of q.candidates) index.set(`${q.id}-${c.id}`, { q, c });
  const got = new Map();
  const lines = sheetText.split("\n");
  let current = null;
  const problems = [];
  for (const line of lines) {
    const head = /^### ([A-Z]+\d+-C\d+) 候補$/u.exec(line);
    if (head) {
      current = head[1];
      continue;
    }
    if (current && line.startsWith("判定:")) {
      const raw = line.slice("判定:".length).trim().toLowerCase();
      if (raw !== "") {
        const label = LABEL_ALIASES[raw];
        if (!label) problems.push(`${current}: 判定の値が不正`);
        else if (got.has(current)) problems.push(`${current}: 判定が重複`);
        else got.set(current, label);
      }
      current = null;
    }
  }
  for (const id of got.keys()) if (!index.has(id)) problems.push(`${id}: 対応表に無い`);
  const missing = [...index.keys()].filter((id) => !got.has(id));
  if (problems.length > 0) throw new Error(`取り込めない: ${problems.join("; ")}`);
  if (missing.length > 0 && !allowPartial)
    throw new Error(`未記入の候補が ${missing.length} 件（先頭 ${missing.slice(0, 5).join(", ")}）。途中なら --allow-partial`);
  const labels = [...got].map(([id, label]) => {
    const { q, c } = index.get(id);
    return { work: q.work, queryPosition: q.queryPosition, candidatePosition: c.position, label };
  });
  labels.sort(
    (a, b) =>
      a.work.localeCompare(b.work) ||
      a.queryPosition - b.queryPosition ||
      a.candidatePosition - b.candidatePosition,
  );
  return {
    schemaVersion: "fusion-slot-pg-annotations/1",
    annotator,
    selectionSha256: key.selectionSha256,
    meta: { source: "sheet", sheetKeySha256: key.selfSha256 ?? null, labeled: labels.length, missing: missing.length },
    labels,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; ) {
    const name = argv[i];
    assert.ok(name.startsWith("--"), `引数の形が不正: ${name}`);
    if (name === "--allow-partial") {
      opts.allowPartial = true;
      i += 1;
    } else {
      opts[name.slice(2)] = argv[i + 1];
      i += 2;
    }
  }
  return opts;
}

/** run 2 の追加分の sheet（run 1 に無い組だけ）。sheet-key.json に run2Additions を足す（v2 の schema と run 1 の部分は変えない）。 */
function mainRun2(opts) {
  const outDir = opts["out-dir"] ?? SHEET_DIR;
  assertOutsideRepo(outDir);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const selection2 = readJson(opts.selection);
  const selection1 = readJson(opts["additions-of"]);
  assert.equal(selection2.run, 2, "[precheck] --selection は run 2 の selection");
  assert.equal(selection1.run, 1, "[precheck] --additions-of は run 1 の selection");
  assert.equal(selection2.seed, selection1.seed, "[precheck] 種が違う");
  const selection1Sha256 = fileSha256(opts["additions-of"]);
  const selection2Sha256 = fileSha256(opts.selection);
  assert.equal(selection2.derivedFrom?.priorSha256, selection1Sha256, "[precheck] run 2 の selection の prior が run 1 の selection と一致しない");
  const scenesDir = opts["scenes-dir"] ?? SCENES_DIR;
  const scenes = {};
  for (const work of new Set(selection2.queries.map((q) => q.work)))
    scenes[work] = loadScenes(scenesDir, selection2, work);
  const prompt = loadPrompt();
  const keyFile = path.join(outDir, "sheet-key.json");
  assert.ok(fs.existsSync(keyFile), "[precheck] run 1 の sheet-key.json が無い");
  const existingKey = readJson(keyFile);
  const plan1 = planSheet(selection1);
  assert.equal(existingKey.selectionSha256, selection1Sha256, "[precheck] sheet-key.json は run 1 の selection のもの");
  assert.deepEqual(existingKey.queries, plan1, "[precheck] sheet-key.json の run 1 の部分が selection から作る plan と違う");
  const plan = planSheetRun2(selection2, selection1);
  const sheet = renderSheet({
    selection: selection2,
    scenes,
    annotator: opts.annotator,
    plan,
    prompt,
    title: `注釈シート（${opts.annotator}）追加分`,
    idExample: "R01",
    seenInit: new Map([...firstSeenLabels(plan1)].map(([id, label]) => [id, `前の sheet の ${label}`])),
    notes: [
      "- **これは追加分です**。前の sheet で判定した組は含まれず、前に無かった組だけを並べています。質問の番号は R01… で、前の sheet の Q01… とは別です。",
      "- 前の sheet に出ていた Scene は、本文を繰り返さず「→ ID xxxxxx（既出：前の sheet の Q03-C2）」のように参照だけを書きます。前の sheet の同じ ID の本文に戻って読んでください。",
    ],
  });
  const sheetFile = path.join(outDir, `sheet-${opts.annotator}-run2.md`);
  fs.writeFileSync(sheetFile, sheet, { flag: "wx", mode: 0o600 });
  const withoutNew = selection2.queries.filter((q) => !q.candidates.some((c) => c.newPair === true));
  const run2Additions = {
    selectionSha256: selection2Sha256,
    priorSelectionSha256: selection1Sha256,
    promptFileSha256: prompt.fileSha256,
    sheetFile: path.basename(sheetFile),
    queries: plan,
    queriesWithoutNewPair: withoutNew.map((q) => ({ work: q.work, queryPosition: q.queryPosition })),
  };
  if (existingKey.run2Additions) assert.deepEqual(existingKey.run2Additions, run2Additions, "[precheck] 既存の run2Additions と違う");
  else {
    // 更新の前に、元の対応表を別名で残す（上書きで失わない）
    const backup = path.join(outDir, "superseded-20261106", "sheet-key.pre-run2.json");
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(backup)) fs.copyFileSync(keyFile, backup);
    fs.writeFileSync(keyFile, `${JSON.stringify({ ...existingKey, run2Additions }, null, 2)}\n`, { mode: 0o600 });
  }
  const candidates = plan.reduce((a, q) => a + q.candidates.length, 0);
  const appearances = plan.reduce((a, q) => a + 1 + q.candidates.length, 0);
  const idsAll = plan.flatMap((q) => [q.anonId, ...q.candidates.map((c) => c.anonId)]);
  const seen1 = firstSeenLabels(plan1);
  const distinctInRun2 = new Set(idsAll);
  const newScenes = [...distinctInRun2].filter((id) => !seen1.has(id)).length;
  process.stdout.write(
    `${JSON.stringify({
      sheet: sheetFile,
      key: keyFile,
      sheetSha256: fileSha256(sheetFile),
      keySha256: fileSha256(keyFile),
      queries: plan.length,
      queriesWithoutNewPair: withoutNew.length,
      candidates,
      sceneAppearances: appearances,
      distinctScenesInSheet: distinctInRun2.size,
      scenesNotInPreviousSheet: newScenes,
      referencesToPreviousSheet: idsAll.filter((id) => seen1.has(id)).length,
      referencesWithinSheet: appearances - distinctInRun2.size,
      bodiesPrinted: newScenes,
      sheetChars: sheet.length,
    }, null, 2)}\n`,
  );
}

export function main(argv) {
  const opts = parseArgs(argv);
  assert.ok(opts.annotator, "--annotator が要る");
  assert.match(opts.annotator, /^[a-z0-9-]+$/u, "--annotator は英数字とハイフン");
  if (opts.ingest) {
    assert.ok(opts.key && opts.out, "--ingest には --key と --out が要る");
    const fullKey = readJson(opts.key);
    const section = opts["key-section"];
    if (section) assert.ok(fullKey[section]?.queries, `[precheck] sheet-key.json に ${section} が無い`);
    const key = section ? { ...fullKey[section] } : fullKey;
    key.selfSha256 = fileSha256(opts.key);
    const annotations = ingestSheet(fs.readFileSync(opts.ingest, "utf8"), key, {
      annotator: opts.annotator,
      allowPartial: Boolean(opts.allowPartial),
    });
    fs.writeFileSync(opts.out, `${JSON.stringify(annotations, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify(annotations.meta)}\n`);
    return;
  }
  assert.ok(opts.selection, "--selection が要る");
  if (opts["additions-of"]) return mainRun2(opts);
  const outDir = opts["out-dir"] ?? SHEET_DIR;
  assertOutsideRepo(outDir);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const selection = readJson(opts.selection);
  const selectionSha256 = fileSha256(opts.selection);
  const scenesDir = opts["scenes-dir"] ?? SCENES_DIR;
  const scenes = {};
  for (const work of new Set(selection.queries.map((q) => q.work)))
    scenes[work] = loadScenes(scenesDir, selection, work);
  const prompt = loadPrompt();
  const plan = planSheet(selection);
  const sheet = renderSheet({ selection, scenes, annotator: opts.annotator, plan, prompt });
  const sheetFile = path.join(outDir, `sheet-${opts.annotator}.md`);
  const keyFile = path.join(outDir, "sheet-key.json");
  fs.writeFileSync(sheetFile, sheet, { flag: "wx", mode: 0o600 });
  const key = {
    schemaVersion: "fusion-slot-pg-sheet-key/2",
    selectionSha256,
    seed: selection.seed,
    promptFileSha256: prompt.fileSha256,
    queries: plan,
    excludedQueries: excludedQueries(selection),
  };
  // 対応表は annotator によらず同じ順序（seed 固定）。既にあれば内容が同じことだけ確かめる。
  const keyText = `${JSON.stringify(key, null, 2)}\n`;
  if (fs.existsSync(keyFile)) {
    // run 2 の追加分（run2Additions）が足されていても、run 1 の部分が同じなら通す
    const { run2Additions: _ignored, ...existing } = readJson(keyFile);
    assert.equal(`${JSON.stringify(existing, null, 2)}\n`, keyText, "[precheck] sheet-key.json が既存と違う");
  }
  else fs.writeFileSync(keyFile, keyText, { mode: 0o600 });
  const candidates = plan.reduce((a, q) => a + q.candidates.length, 0);
  const appearances = plan.reduce((a, q) => a + 1 + q.candidates.length, 0);
  const distinctScenes = new Set(plan.flatMap((q) => [q.anonId, ...q.candidates.map((c) => c.anonId)])).size;
  process.stdout.write(
    `${JSON.stringify({
      sheet: sheetFile,
      key: keyFile,
      sheetSha256: fileSha256(sheetFile),
      keySha256: fileSha256(keyFile),
      queries: plan.length,
      excludedQueries: excludedQueries(selection).length,
      candidates,
      sceneAppearances: appearances,
      distinctScenes,
      references: appearances - distinctScenes,
      sheetChars: sheet.length,
    }, null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
