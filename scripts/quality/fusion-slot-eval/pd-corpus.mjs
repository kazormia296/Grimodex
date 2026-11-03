// パブリックドメイン（PD）の小説を取得・整形し、Scene に分ける（融合の枠の評価・段階 1）。
//
// 作品の一覧（題名・URL）と取得物・整形後の Scene は repo の外だけに置く。この script は
// 作品名を持たず、repo の外の works.json を引数で受けて処理だけをする。
//
//   node scripts/quality/fusion-slot-eval/pd-corpus.mjs fetch   --works <works.json> --data <dir> [--only key,key]
//   node scripts/quality/fusion-slot-eval/pd-corpus.mjs prepare --works <works.json> --data <dir> [--only key,key]
//
// fetch：作品ごとに書誌の page（保護期間の確認）と公式のテキスト（青空文庫は zip の txt、
//   Gutenberg は plain text UTF-8）を、間隔を空けて取得する。User-Agent は `grimodex-eval`。
//   取得物の URL・sha256・取得日時を <data>/manifest.json に書く。取得済みの作品は取り直さない。
// prepare：取得物を整形し、分割規則（scene-split-rules.json）で Scene に分け、
//   <data>/scenes/<key>.json に書く。標準出力には件数だけを出す（本文・題名は出さない）。
/* global fetch, URL, TextDecoder */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { unzipSync } from "fflate";

export const USER_AGENT = "grimodex-eval";
export const REQUEST_INTERVAL_MS = 8000;
export const RULES_PATH = path.join(
  import.meta.dirname,
  "scene-split-rules.json",
);
/** 青空文庫の旧規定（没後 50 年）で PD とみなす没年の上限。 */
export const AOZORA_MAX_DEATH_YEAR = 1967;

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i += 2) {
    assert.ok(
      rest[i].startsWith("--") && rest[i + 1],
      "--name value の形で渡す",
    );
    options[rest[i].slice(2)] = rest[i + 1];
  }
  assert.ok(["fetch", "prepare"].includes(command), "fetch か prepare");
  assert.ok(
    options.works && path.isAbsolute(options.works),
    "--works は絶対 path",
  );
  assert.ok(
    options.data && path.isAbsolute(options.data),
    "--data は絶対 path",
  );
  return options;
}

/** repo の内側に本文を置かないための確認。 */
export function assertOutsideRepo(file) {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const relative = path.relative(repo, path.resolve(file));
  assert.ok(
    relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative),
    `[precheck] repo の外を指定する: ${file}`,
  );
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

let lastRequestAt = 0;
async function politeFetch(url) {
  const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
  });
  assert.equal(response.status, 200, `HTTP ${response.status}: ${url}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    finalUrl: response.url,
    fetchedAt: new Date().toISOString(),
  };
}

/** 青空文庫の図書カードから、ルビ付き zip の link と著者の没年を読む。 */
export function parseAozoraCard(html, cardUrl) {
  const zips = [...html.matchAll(/<a href="(\.\/files\/[^"]+\.zip)">/g)].map(
    (m) => m[1],
  );
  assert.ok(zips.length >= 1, "zip の link が無い");
  const preferred = zips.find((z) => /_ruby_/.test(z)) ?? zips[0];
  const deaths = [
    ...html.matchAll(/没年：<\/td><td>(\d{4})-\d{2}-\d{2}<\/td>/g),
  ].map((m) => Number(m[1]));
  const protectedFlag = /著作権存続/.test(html);
  return {
    zipUrl: new URL(preferred, cardUrl).href,
    deathYears: deaths,
    copyrightProtectedFlag: protectedFlag,
  };
}

async function fetchWork(work, dataDir) {
  const rawDir = path.join(dataDir, "raw");
  await mkdir(rawDir, { recursive: true });
  if (work.source === "aozora") {
    const card = await politeFetch(work.metaUrl);
    const parsed = parseAozoraCard(card.bytes.toString("utf8"), work.metaUrl);
    assert.ok(parsed.deathYears.length >= 1, "没年が読めない");
    assert.ok(
      !parsed.copyrightProtectedFlag &&
        parsed.deathYears.every((y) => y <= AOZORA_MAX_DEATH_YEAR),
      `[precheck] 保護期間が切れていない可能性: ${work.key}`,
    );
    const zip = await politeFetch(parsed.zipUrl);
    const file = path.join(rawDir, `${work.key}.zip`);
    await writeFile(file, zip.bytes);
    return {
      key: work.key,
      role: work.role,
      language: work.language,
      source: work.source,
      metaUrl: work.metaUrl,
      metaFetchedAt: card.fetchedAt,
      metaSha256: sha256(card.bytes),
      textUrl: parsed.zipUrl,
      textFinalUrl: zip.finalUrl,
      fetchedAt: zip.fetchedAt,
      bytes: zip.bytes.length,
      sha256: sha256(zip.bytes),
      rawFile: path.relative(dataDir, file),
      publicDomainBasis: {
        rule: `著者の没年が ${AOZORA_MAX_DEATH_YEAR} 年以前（旧規定の没後 50 年）`,
        authorDeathYears: parsed.deathYears,
        cardShowsCopyrightProtected: parsed.copyrightProtectedFlag,
      },
    };
  }
  if (work.source === "gutenberg") {
    const meta = await politeFetch(work.metaUrl);
    const html = meta.bytes.toString("utf8");
    const pd = /Public domain in the USA/i.test(html);
    assert.ok(
      pd,
      `[precheck] "Public domain in the USA" の表示が無い: ${work.key}`,
    );
    const text = await politeFetch(work.textUrl);
    const file = path.join(rawDir, `${work.key}.txt`);
    await writeFile(file, text.bytes);
    return {
      key: work.key,
      role: work.role,
      language: work.language,
      source: work.source,
      metaUrl: work.metaUrl,
      metaFetchedAt: meta.fetchedAt,
      metaSha256: sha256(meta.bytes),
      textUrl: work.textUrl,
      textFinalUrl: text.finalUrl,
      fetchedAt: text.fetchedAt,
      bytes: text.bytes.length,
      sha256: sha256(text.bytes),
      rawFile: path.relative(dataDir, file),
      publicDomainBasis: {
        rule: 'Gutenberg の書誌の page に "Public domain in the USA" の表示がある',
        shown: pd,
      },
    };
  }
  throw new Error(`unknown source: ${work.source}`);
}

// ---------------------------------------------------------------- 整形

/** 青空文庫の txt（Shift_JIS）を、見出しで区切った節の列にする。 */
export function normalizeAozora(bytes) {
  const text = new TextDecoder("shift_jis", { fatal: true })
    .decode(bytes)
    .replace(/\r\n?/g, "\n");
  let lines = text.split("\n");
  // ヘッダ：題名・著者の後の「-----」で囲まれた記号の説明の block まで。
  const dashes = lines
    .map((line, i) => (/^-{20,}\s*$/.test(line) ? i : -1))
    .filter((i) => i >= 0);
  let start;
  if (dashes.length >= 2 && dashes[0] < 40) start = dashes[1] + 1;
  else start = lines.findIndex((line) => line.trim() === "") + 1;
  // フッタ：「底本：」以降。
  let end = lines.findIndex((line, i) => i >= start && /^底本：/.test(line));
  if (end < 0) end = lines.length;
  lines = lines.slice(start, end);

  const sections = [];
  let current = { heading: null, paragraphs: [] };
  const headingRe =
    /(［＃「[^」]*」は(大|中|小)見出し］|［＃(大|中|小)見出し］|［＃ここから(大|中|小)見出し］)/;
  let inBlockHeading = false;
  for (const line of lines) {
    const isHeading = headingRe.test(line) || inBlockHeading;
    if (/［＃ここから(大|中|小)見出し］/.test(line)) inBlockHeading = true;
    if (/［＃ここで(大|中|小)見出し終わり］/.test(line)) inBlockHeading = false;
    if (isHeading) {
      // 連続する見出し行（大見出しの直後の中見出しなど）は、それぞれ新しい節にする。
      // 本文の無い節は分割規則の「短すぎる節」で次と合わさる。
      sections.push(current);
      current = { heading: "h", paragraphs: [] };
      continue;
    }
    const cleaned = cleanAozoraLine(line);
    if (cleaned) current.paragraphs.push(cleaned);
  }
  sections.push(current);
  // 見出しの注記が無い入力（古い入力の作品）では、見出しの形の行だけで区切る。
  if (!sections.some((s) => s.heading)) return splitPlainHeadings(lines);
  // 最初の見出しより前（前書きなど）は、見出しがある作品では落とす。
  const hasHeadings = sections.some((s) => s.heading);
  return hasHeadings ? sections.filter((s) => s.heading) : sections;
}

/** 漢数字だけの「第…章」「（…）」「…」の行を見出しとみなす（注記の無い作品のための代替）。 */
export const PLAIN_HEADING_RE =
  /^(第[一二三四五六七八九十百〇壱弐参肆伍拾]+[章回節部篇編]|[（(][一二三四五六七八九十百〇壱弐参肆伍拾]+[）)]|[一二三四五六七八九十百〇壱弐参肆伍拾]+)$/;

function splitPlainHeadings(lines) {
  const sections = [{ heading: null, paragraphs: [] }];
  for (const line of lines) {
    const cleaned = cleanAozoraLine(line);
    if (PLAIN_HEADING_RE.test(cleaned)) {
      sections.push({ heading: "h", paragraphs: [] });
      continue;
    }
    if (cleaned) sections[sections.length - 1].paragraphs.push(cleaned);
  }
  return sections.some((s) => s.heading)
    ? sections.filter((s) => s.heading)
    : sections;
}

export function cleanAozoraLine(line) {
  return (
    line
      // 外字：※［＃…］ を除く（※ ごと）。
      .replace(/※［＃[^］]*］/g, "")
      // 注記：［＃…］ を除く。
      .replace(/［＃[^］]*］/g, "")
      // ルビ：｜親文字《ルビ》 → 親文字、親文字《ルビ》 → 親文字。
      .replace(/｜([^《｜]*)《[^》]*》/g, "$1")
      .replace(/《[^》]*》/g, "")
      .replace(/｜/g, "")
      .replace(/^[\s\u3000]+|[\s\u3000]+$/g, "")
  );
}

/** Gutenberg の plain text を、章見出しで区切った節の列にする。 */
export function normalizeGutenberg(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const startLine = lines.findIndex((l) =>
    /^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK/i.test(l),
  );
  const endLine = lines.findIndex((l) =>
    /^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK/i.test(l),
  );
  assert.ok(startLine >= 0 && endLine > startLine, "START／END が無い");
  let body = lines.slice(startLine + 1, endLine).join("\n");
  // 「THE END」（挿絵の注記の中にあるものを含む）から後ろは奥付・広告なので落とす。
  const ends = [
    ...body.matchAll(
      /(\[Illustration:\s*THE\s+END\s*\]|^[ \t]*THE END\.?[ \t]*$)/gm,
    ),
  ];
  if (ends.length) body = body.slice(0, ends[ends.length - 1].index);
  // 挿絵の注記（複数行・空行・入れ子の [] をまたぐものを含む）は本文ではない。
  body = removeIllustrations(body);
  // 段落：空行で区切り、段落内の改行をつなぐ。
  const paragraphs = body
    .split(/\n[ \t]*\n+/)
    .map((p) =>
      p
        .replace(/\s*\n\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const isHeading = (p) =>
    /^CHAPTER\s+([IVXLC]+|\d+)\b/i.test(p) && p.split(/\s+/).length <= 20;
  // 目次の行を本文の見出しと取り違えない：直後（次の見出し候補まで）に 40 語以上の
  // 段落がある見出しだけを採る。
  const candidates = paragraphs
    .map((p, i) => (isHeading(p) ? i : -1))
    .filter((i) => i >= 0);
  const accepted = candidates.filter((index, n) => {
    const next = candidates[n + 1] ?? paragraphs.length;
    return paragraphs
      .slice(index + 1, next)
      .some((p) => p.split(/\s+/).length >= 40);
  });
  assert.ok(accepted.length >= 1, "章見出しが無い");
  const sections = [];
  for (const [n, index] of accepted.entries()) {
    const next = accepted[n + 1] ?? paragraphs.length;
    // 本文の見出しの直後の短い副題（章題）は段落として残す。
    sections.push({
      heading: "h",
      paragraphs: paragraphs.slice(index + 1, next),
    });
  }
  return sections;
}

/**
 * `[Illustration …]` を括弧の対応を数えて取り除く。注記の末尾に章見出し
 * （例：挿絵の中の「Chapter I.」）があれば、見出しだけを段落として残す。
 */
export function removeIllustrations(body) {
  let out = "";
  let i = 0;
  for (;;) {
    const start = body.indexOf("[Illustration", i);
    if (start < 0) return out + body.slice(i);
    out += body.slice(i, start);
    let depth = 0;
    let end = start;
    for (; end < body.length; end++) {
      if (body[end] === "[") depth++;
      else if (body[end] === "]" && --depth === 0) break;
    }
    const inner = body.slice(start, end + 1);
    const heading = inner.match(/(CHAPTER\s+([IVXLC]+|\d+)\.?)\s*\]$/i);
    if (heading) out += `\n\n${heading[1]}\n\n`;
    i = end + 1;
  }
}

// ---------------------------------------------------------------- 分割

export function sizeOf(paragraphs, unit) {
  if (unit === "chars")
    return paragraphs.reduce(
      (n, p) => n + [...p.replace(/[\s\u3000]/g, "")].length,
      0,
    );
  if (unit === "words")
    return paragraphs.reduce(
      (n, p) => n + p.split(/\s+/).filter(Boolean).length,
      0,
    );
  throw new Error(`unknown unit: ${unit}`);
}

/** 段落の境目で k 個にほぼ等分する（各部分の目標は total/k の累積位置）。 */
export function splitEven(paragraphs, unit, k) {
  const sizes = paragraphs.map((p) => sizeOf([p], unit));
  const total = sizes.reduce((a, b) => a + b, 0);
  const parts = [];
  let current = [];
  let cumulative = 0;
  let cut = 1;
  for (const [i, p] of paragraphs.entries()) {
    const before = cumulative;
    cumulative += sizes[i];
    const target = (total * cut) / k;
    // 目標の位置に近い側の境目で切る（この段落の前か後か）。
    if (current.length > 0 && cut < k && cumulative > target) {
      if (target - before < cumulative - target) {
        parts.push(current);
        current = [];
        cut++;
      }
    }
    current.push(p);
    if (
      cut < k &&
      cumulative >= (total * cut) / k &&
      i < paragraphs.length - 1
    ) {
      parts.push(current);
      current = [];
      cut++;
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

/**
 * 節の列を Scene の列にする。順序：短すぎる節を次と合わせる → 長すぎる節を分ける。
 * 返り値の paragraphs は本文。size は規則の単位での大きさ。
 */
export function splitScenes(sections, rule) {
  const { unit, maxPerScene, minPerScene } = rule;
  const merged = [];
  let carry = [];
  for (const section of sections) {
    const paragraphs = [...carry, ...section.paragraphs];
    if (sizeOf(paragraphs, unit) < minPerScene) {
      carry = paragraphs;
      continue;
    }
    merged.push(paragraphs);
    carry = [];
  }
  if (carry.length) {
    if (merged.length) merged[merged.length - 1].push(...carry);
    else merged.push(carry);
  }
  const scenes = [];
  for (const paragraphs of merged) {
    const size = sizeOf(paragraphs, unit);
    if (size <= maxPerScene) {
      scenes.push(paragraphs);
      continue;
    }
    let k = Math.ceil(size / maxPerScene);
    let parts;
    for (;;) {
      parts = splitEven(paragraphs, unit, k);
      if (
        parts.every((part) => sizeOf(part, unit) <= maxPerScene) ||
        k >= paragraphs.length
      )
        break;
      k++;
    }
    scenes.push(...parts);
  }
  return scenes
    .filter((paragraphs) => paragraphs.length > 0)
    .map((paragraphs, i) => ({
      index: i + 1,
      size: sizeOf(paragraphs, unit),
      paragraphs,
    }));
}

async function prepareWork(work, entry, dataDir, rules, rulesSha256) {
  const bytes = await readFile(path.join(dataDir, entry.rawFile));
  assert.equal(
    sha256(bytes),
    entry.sha256,
    `取得物の sha256 が変わった: ${work.key}`,
  );
  let sections;
  if (work.source === "aozora") {
    const files = unzipSync(new Uint8Array(bytes));
    const txt = Object.keys(files).filter((name) => /\.txt$/i.test(name));
    assert.equal(txt.length, 1, "zip の txt は 1 つ");
    sections = normalizeAozora(Buffer.from(files[txt[0]]));
  } else {
    sections = normalizeGutenberg(bytes);
  }
  const rule = rules.languages[work.language];
  const scenes = splitScenes(sections, rule);
  const sizes = scenes.map((s) => s.size);
  const stats = {
    sections: sections.length,
    scenes: scenes.length,
    unit: rule.unit,
    minSize: Math.min(...sizes),
    maxSize: Math.max(...sizes),
    meanSize: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
    overMax: sizes.filter((s) => s > rule.maxPerScene).length,
    underMin: sizes.filter((s) => s < rule.minPerScene).length,
  };
  const out = {
    schemaVersion: "fusion-slot-pd-scenes/1",
    evidenceScope: "not-cp4-evidence",
    key: work.key,
    role: work.role,
    language: work.language,
    sourceSha256: entry.sha256,
    rulesSha256,
    stats,
    scenes,
  };
  const file = path.join(dataDir, "scenes", `${work.key}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  const serialized = JSON.stringify(out) + "\n";
  await writeFile(file, serialized);
  return {
    key: work.key,
    file: path.relative(dataDir, file),
    sha256: sha256(serialized),
    stats,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertOutsideRepo(options.works);
  assertOutsideRepo(options.data);
  const { works } = JSON.parse(await readFile(options.works, "utf8"));
  const only = options.only ? new Set(options.only.split(",")) : null;
  const selected = works.filter((w) => !only || only.has(w.key));
  assert.ok(selected.length > 0, "対象の作品が無い");
  const manifestPath = path.join(options.data, "manifest.json");
  const manifest = (await exists(manifestPath))
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : {
        schemaVersion: "fusion-slot-pd-manifest/1",
        evidenceScope: "not-cp4-evidence",
        userAgent: USER_AGENT,
        requestIntervalMs: REQUEST_INTERVAL_MS,
        works: {},
        prepared: {},
      };
  if (options.command === "fetch") {
    for (const work of selected) {
      if (manifest.works[work.key]) {
        process.stdout.write(`取得済み: ${work.key}\n`);
        continue;
      }
      manifest.works[work.key] = await fetchWork(work, options.data);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      process.stdout.write(
        `取得: ${work.key} ${manifest.works[work.key].bytes} bytes\n`,
      );
    }
    return;
  }
  const rulesBytes = await readFile(RULES_PATH);
  const rules = JSON.parse(rulesBytes.toString("utf8"));
  const rulesSha256 = sha256(rulesBytes);
  for (const work of selected) {
    const entry = manifest.works[work.key];
    assert.ok(entry, `未取得: ${work.key}`);
    const result = await prepareWork(
      work,
      entry,
      options.data,
      rules,
      rulesSha256,
    );
    manifest.prepared[work.key] = {
      ...result,
      rulesSha256,
      scriptSha256: sha256(await readFile(import.meta.filename)),
      preparedAt: new Date().toISOString(),
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    process.stdout.write(
      `整形: ${work.key} 節 ${result.stats.sections} → Scene ${result.stats.scenes}（${result.stats.unit} ${result.stats.minSize}〜${result.stats.maxSize}、上限超 ${result.stats.overMax}、下限未満 ${result.stats.underMin}）\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
