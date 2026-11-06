// 注釈の表示（本文を含む）を repo の外に作る／注釈者が記入した表示を注釈 file に取り込む。
// この script 自体は本文を含まない。出力（sheet-<annotator>.md・sheet-key.json）は repo の外だけ。
// 候補は由来（IR／Raw）・順位・位置・作品を隠し、seed 固定で混ぜる。Scene には匿名 ID（seed 固定の hash の 6 桁）を付け、
// 同じ Scene の 2 回目以降は本文を繰り返さず参照だけにする。候補 0 件の query は出さない。対応表は sheet-key.json。
//
// 使い方：
//   node render-annotation-sheet.mjs --selection <selection-run1.json> --annotator <user|…> \
//        [--scenes-dir <dir>] [--out-dir <repo 外の dir>]
//   node render-annotation-sheet.mjs --ingest <記入済み sheet.md> --key <sheet-key.json> \
//        --annotator <名> --out <annotations.json> [--allow-partial]
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

/** 候補が 0 件で sheet に出さない query（対応表に記録する。本文なし）。 */
export const excludedQueries = (selection) =>
  selection.queries
    .filter((q) => q.candidates.length === 0)
    .map((q) => ({ work: q.work, queryPosition: q.queryPosition, reason: "no-candidates" }));

export function renderSheet({ selection, scenes, annotator, plan = planSheet(selection), prompt }) {
  const lines = [
    `# 注釈シート（${annotator}）`,
    "",
    "## 読み方",
    "",
    "- 各質問（Q01…）は「今の Scene」と複数の「候補」を並べます。候補ごとに、下の設問に従って**判定**を記入してください。",
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
  const seen = new Map(); // anonId → 初出の見出しの名前（sheet の順で最初に出た場所）
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
    const head = /^### (Q\d+-C\d+) 候補$/u.exec(line);
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

export function main(argv) {
  const opts = parseArgs(argv);
  assert.ok(opts.annotator, "--annotator が要る");
  assert.match(opts.annotator, /^[a-z0-9-]+$/u, "--annotator は英数字とハイフン");
  if (opts.ingest) {
    assert.ok(opts.key && opts.out, "--ingest には --key と --out が要る");
    const key = readJson(opts.key);
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
  if (fs.existsSync(keyFile)) assert.equal(fs.readFileSync(keyFile, "utf8"), keyText, "[precheck] sheet-key.json が既存と違う");
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
