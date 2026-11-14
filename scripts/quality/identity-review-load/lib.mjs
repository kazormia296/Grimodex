// 同定の review の負荷の測定（identity-review-load）の純関数。
// renderer（Vite）と Node の双方から読むので、DOM・Node 固有の API は使わない
// （hash は globalThis.crypto.subtle）。原稿の本文・表記は、この module の戻り値に
// 「件数」「hash」「ID」としてしか出さない。

/**
 * 作品 key → 場面数（事前登録 §2・§16。2026-11-14 に作品を変更：新しい 3 本は各 60 場面、
 * m-ja-2 は 117 場面。凍結前に scenes JSON から再測する）。
 * 旧 4 作（m-ja-1・m-ja-3・g-ja-1）は本測定の対象外。
 */
export const WORKS = Object.freeze({
  "g-ja-2": 60,
  "g-ja-3": 60,
  "g-ja-4": 60,
  "m-ja-2": 117,
});

/** 作者が名簿を確認する作品（§16：m-ja-2 は確認しない＝名簿は未確認のまま）。 */
export const REVIEWED_WORKS = Object.freeze(["g-ja-2", "g-ja-3", "g-ja-4"]);

/** 入れ子 folder の刻み（F25 ⊂ F50 ⊂ F75 ⊂ F100）。 */
export const FOLDER_PERCENTS = Object.freeze([25, 50, 75, 100]);

/**
 * 入れ子 folder の累積の場面数。ceil(N × k / 100) を整数のまま（浮動小数点を避けて）求める。
 * 110 は 28／55／83／110、117 は 30／59／88／117、34 は 9／17／26／34。
 */
export function nestedFolderSceneCounts(sceneCount) {
  if (!Number.isSafeInteger(sceneCount) || sceneCount < 1) {
    throw new RangeError("sceneCount must be a positive integer");
  }
  return FOLDER_PERCENTS.map((percent) =>
    Math.ceil((sceneCount * percent) / 100),
  );
}

/**
 * 入れ子 folder の構築計画。F(k) は F(k-1) を先頭の子にし、その後ろに追加の場面を置く。
 * 戻り値の folders は小さい方（F25）から並ぶ。parent は F(k+1) 側（F100 が root）。
 * 場面の index は 0 始まりで、scenes JSON の並びと同じ。
 */
export function planNestedFolders(sceneCount) {
  const counts = nestedFolderSceneCounts(sceneCount);
  const folders = FOLDER_PERCENTS.map((percent, i) => {
    const start = i === 0 ? 0 : counts[i - 1];
    const end = counts[i];
    const sceneIndexes = [];
    for (let index = start; index < end; index++) sceneIndexes.push(index);
    return {
      percent,
      cumulativeSceneCount: end,
      // F(k) の子は [F(k-1)（i>0 のとき）, ...追加の場面]。
      childFolderPercent: i === 0 ? null : FOLDER_PERCENTS[i - 1],
      addedSceneIndexes: sceneIndexes,
      parentPercent:
        i === FOLDER_PERCENTS.length - 1 ? null : FOLDER_PERCENTS[i + 1],
    };
  });
  return { counts, folders };
}

/** scenes JSON の 1 場面 → 保存後に prosemirrorToText が返すはずの text（各段落を \n で終える）。 */
export function expectedSceneText(paragraphs) {
  return paragraphs.map((paragraph) => `${paragraph}\n`).join("");
}

/**
 * 出力の混入検査（assertOutputClean・shingle 走査）の材料：記法つきの本文と、ルビ記法を親文字だけに
 * した本文の両方（ルビのある作品は、記法の有無で別の連続になる）。rubyBaseText は後方で定義される
 * 関数宣言なので、ここから呼べる。
 */
export function scenesTextsForScan(scenes) {
  return scenes.flatMap((scene) => [
    expectedSceneText(scene.paragraphs),
    expectedSceneText(scene.paragraphs.map(rubyBaseText)),
  ]);
}

/**
 * 抽出器が読む snapshot の canonical.text（proseMirrorSerializer の assembleCanonical）の期待値：
 * 段落を "\n" で区切り、末尾に改行を付けない（prosemirrorToText とは形が違う）。
 */
export function expectedCanonicalText(paragraphs) {
  return paragraphs.join("\n");
}

/** scenes JSON から場面（index 昇順）を取り出す。本文はそのまま持つ（出力には出さない）。 */
export function scenesFromWork(work) {
  if (!work || !Array.isArray(work.scenes)) {
    throw new TypeError("scenes JSON must have a scenes array");
  }
  const scenes = [...work.scenes].sort((a, b) => a.index - b.index);
  scenes.forEach((scene, position) => {
    if (scene.index !== position + 1) {
      throw new RangeError("scene index must be contiguous from 1");
    }
    if (
      !Array.isArray(scene.paragraphs) ||
      scene.paragraphs.some((p) => typeof p !== "string" || p.length === 0)
    ) {
      throw new TypeError("paragraphs must be non-empty strings");
    }
  });
  return scenes;
}

/** 保存した場面の text と期待の text の不一致を、件数だけで返す（本文は返さない）。 */
export function countTextMismatches(expectedTexts, actualTexts) {
  if (expectedTexts.length !== actualTexts.length) {
    return {
      expected: expectedTexts.length,
      actual: actualTexts.length,
      mismatched: Math.max(expectedTexts.length, actualTexts.length),
    };
  }
  let mismatched = 0;
  for (let i = 0; i < expectedTexts.length; i++) {
    if (expectedTexts[i] !== actualTexts[i]) mismatched++;
  }
  return {
    expected: expectedTexts.length,
    actual: actualTexts.length,
    mismatched,
  };
}

/** 表記の hash（sha256 の先頭 16 桁。表記の文字列は出力に出さない）。 */
export async function hashSurface(surface) {
  const bytes = new globalThis.TextEncoder().encode(surface);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 製品の候補キー（codexCandidates.candidateKey と同じ規則：trim → NFC → ASCII 小文字化）。 */
export function candidateKey(surface) {
  return surface
    .trim()
    .normalize("NFC")
    .replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * 敬称（existingEntityMatcher.ts の HONORIFIC_SUFFIXES と同じ並び・同じ規則）。
 * 並びの一致は lib.test.mjs が製品の source から検査する。
 */
export const HONORIFIC_SUFFIXES = Object.freeze([
  "さん",
  "様",
  "君",
  "くん",
  "ちゃん",
  "殿",
  "氏",
  "先生",
  "隊長",
  "殿方",
]);

/** existingEntityMatcher.stripHonorific と同じ：最初に合った敬称 1 つだけを外す。 */
export function stripHonorific(surface) {
  let value = surface.trim();
  for (const suffix of HONORIFIC_SUFFIXES) {
    if (value.endsWith(suffix) && value.length > suffix.length) {
      value = value.slice(0, -suffix.length).trim();
      break;
    }
  }
  return value;
}

function distribution(values) {
  if (values.length === 0) {
    return { n: 0, min: 0, p50: 0, p90: 0, max: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
    mean: Math.round((sum / sorted.length) * 1000) / 1000,
  };
}

/**
 * 表記の集合の重なりを数える（件数だけ返す）。
 * - distinct：candidateKey で潰した表記の数
 * - honorificOverlap：敬称を外した形が、集合の別の表記として在る表記の数
 * - honorificStrippable：敬称を外せる表記の数（外した形が集合に在るかは問わない）
 * - substringWithinSet：同じ集合の別の（より長い）表記の部分文字列になる表記の数（2 文字以上）。
 *   製品の部分一致・前方一致（seed と名簿の間、score floor 80）とは別物の代理指標
 */
export function surfaceOverlapCounts(surfaces) {
  const keys = [
    ...new Set(surfaces.map(candidateKey).filter((k) => k.length > 0)),
  ];
  const keySet = new Set(keys);
  let honorificStrippable = 0;
  let honorificOverlap = 0;
  for (const key of keys) {
    const stripped = candidateKey(stripHonorific(key));
    if (stripped !== key && stripped.length > 0) {
      honorificStrippable++;
      if (keySet.has(stripped)) honorificOverlap++;
    }
  }
  let substringWithinSet = 0;
  const byLength = [...keys].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if ([...key].length < 2) continue;
    for (const other of byLength) {
      if (other.length <= key.length) break;
      if (other.includes(key)) {
        substringWithinSet++;
        break;
      }
    }
  }
  return {
    distinct: keys.length,
    honorificStrippable,
    honorificOverlap,
    substringWithinSet,
  };
}

/**
 * 構造抽出の seed の目録（件数だけ）。
 * seeds: [{ surface, occurrenceCount, sceneIds: string[]（出現ごと。重複あり）, appearsAsProperName }]
 */
export function summarizeSeedInventory(seeds) {
  const overlap = surfaceOverlapCounts(seeds.map((seed) => seed.surface));
  const perScene = new Map();
  let occurrences = 0;
  let properName = 0;
  for (const seed of seeds) {
    occurrences += seed.occurrenceCount;
    if (seed.appearsAsProperName) properName++;
    for (const sceneId of new Set(seed.sceneIds)) {
      perScene.set(sceneId, (perScene.get(sceneId) ?? 0) + 1);
    }
  }
  return {
    seedCount: seeds.length,
    // 全 seed が固有名詞形なら、敬称で終わる表記は構造上 0 になりうる（観測した不在ではない）。
    honorificStructurallyZero: properName === seeds.length,
    occurrenceCount: occurrences,
    properNameSeedCount: properName,
    aliasFormSeedCount: seeds.length - properName,
    scenesWithSeeds: perScene.size,
    distinctSeedsPerScene: distribution([...perScene.values()]),
    occurrencesPerSeed: distribution(seeds.map((seed) => seed.occurrenceCount)),
    ...overlap,
  };
}

/** 候補画面の候補の目録（件数だけ）。candidates: [{ surface, count }] */
export function summarizeCandidateInventory(candidates) {
  const overlap = surfaceOverlapCounts(candidates.map((c) => c.surface));
  return {
    candidateCount: candidates.length,
    occurrenceCount: candidates.reduce((acc, c) => acc + c.count, 0),
    countPerCandidate: distribution(candidates.map((c) => c.count)),
    ...overlap,
  };
}

/** seed と候補画面の候補の、表記（candidateKey）の共通部分の件数。 */
export function crossSetCounts(seedSurfaces, candidateSurfaces) {
  const seeds = new Set(seedSurfaces.map(candidateKey));
  const candidates = new Set(candidateSurfaces.map(candidateKey));
  let both = 0;
  for (const key of seeds) if (candidates.has(key)) both++;
  return {
    seedOnly: seeds.size - both,
    candidateOnly: candidates.size - both,
    both,
  };
}

// ---- 出力の混入検査 -------------------------------------------------------

/** 出力に許す文字列は ASCII の識別子・数値・日時・path の形だけ（日本語などは拒む）。 */
const SAFE_STRING = /^[A-Za-z0-9_.:/+=\- ]{0,400}$/u;
/** API key の形（Anthropic の sk-ant-…、一般の sk-…）。ASCII の識別子の形に収まるので、別に拒む。 */
const KEY_SHAPED = /sk-ant-|sk-[A-Za-z0-9_-]{20,}/u;

/**
 * 出力 JSON の「文字列の欄」を拒む。ASCII の識別子の形（hash・enum・日時・path）以外の
 * 文字列があれば、その JSON path のリストを返す（値は返さない）。
 */
export function findUnsafeStrings(value, trail = "$") {
  const found = [];
  if (typeof value === "string") {
    if (!SAFE_STRING.test(value) || KEY_SHAPED.test(value)) found.push(trail);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) =>
      found.push(...findUnsafeStrings(item, `${trail}[${i}]`)),
    );
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!SAFE_STRING.test(key) || KEY_SHAPED.test(key))
        found.push(`${trail}.<key>`);
      found.push(...findUnsafeStrings(item, `${trail}.${key}`));
    }
  }
  return found;
}

/** 原稿の連続 n 文字（既定 8）の集合。 */
export function buildShingleSet(texts, size = 8) {
  const set = new Set();
  for (const text of texts) {
    const chars = [...text];
    for (let i = 0; i + size <= chars.length; i++) {
      set.add(chars.slice(i, i + size).join(""));
    }
  }
  return set;
}

/** 文字列（出力の JSON など）に、原稿の連続 n 文字が現れる箇所の数。 */
export function countShingleHits(output, shingles, size = 8) {
  const chars = [...output];
  let hits = 0;
  for (let i = 0; i + size <= chars.length; i++) {
    if (shingles.has(chars.slice(i, i + size).join(""))) hits++;
  }
  return hits;
}

/** 原稿の ASCII の語（先頭が英字、4 文字以上。小文字化）。短いラテン字の人名・型番の検出用。 */
export function buildAsciiTokenSet(texts, minLength = 4) {
  const set = new Set();
  const pattern = new RegExp(`[A-Za-z][A-Za-z0-9]{${minLength - 1},}`, "gu");
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) set.add(match[0].toLowerCase());
  }
  return set;
}

/** 出力の文字列（値と key）に現れる、原稿の ASCII の語の数。 */
export function countAsciiTokenHits(output, tokens, minLength = 4) {
  const pattern = new RegExp(`[A-Za-z][A-Za-z0-9]{${minLength - 1},}`, "gu");
  let hits = 0;
  const visit = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(pattern)) {
        if (tokens.has(match[0].toLowerCase())) hits++;
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        visit(key);
        visit(item);
      }
    }
  };
  visit(output);
  return hits;
}

/**
 * 出力の JSON を、(1) 文字列の欄の拒否、(2) 原稿との shingle 走査（8 文字）、
 * (3) 原稿の ASCII の語の走査（4 文字以上）で検査する。(2)(3) は (1) より先に数えるので、
 * ASCII の短い表記が (1) を通る場合も別に検出する。失敗時は件数だけを持つ Error を投げる
 * （値は載せない）。
 */
export function assertOutputClean(output, scenesTexts) {
  const unsafe = findUnsafeStrings(output);
  const shingleHits = countShingleHits(
    JSON.stringify(output),
    buildShingleSet(scenesTexts),
  );
  const tokenHits = countAsciiTokenHits(
    output,
    buildAsciiTokenSet(scenesTexts),
  );
  if (unsafe.length > 0 || shingleHits > 0 || tokenHits > 0) {
    throw new Error(
      `[artifact] output unclean: unsafe=${unsafe.length} shingle=${shingleHits} asciiToken=${tokenHits}`,
    );
  }
}

// ---- AI／外部通信の command と、エラーの要約 ---------------------------------

/**
 * AI／外部通信の command の判定（electron/main/profileEgress.ts の DENIED_COMMANDS の全 key
 * ＝route 不問、LICENSE_CONTROL_COMMANDS、key の設定、semantic のモデル取得）。
 * 停止だけの abort_* は含めない。一覧と source の一致は lib.test.mjs が検査する。
 */
export const EXTERNAL_COMMANDS = Object.freeze([
  "narrative_extraction_claim_task",
  "nir1_pack_context",
  "get_ai_settings",
  "save_ai_settings",
  "semantic_download_model",
  "activate_license",
  "revalidate_license",
  "deactivate_license",
]);
const AI_COMMAND =
  /^(send_|codex_app_|start_post_effect_run|.*_cli_|.*_cli$|list_ai_models|test_ai_connection|get_mcp_config|nir1_local_generation|nir1_local_conversation|ai_(?!audit_read_snapshot$|audit_verify$)|.*judg|vivliostyle_)/u;
export function findAiCommands(commandNames) {
  return [...new Set(commandNames)]
    .filter((name) => AI_COMMAND.test(name) || EXTERNAL_COMMANDS.includes(name))
    .sort();
}

/** エラー文は ASCII の識別子の形だけ残して切る（本文・表記が混ざっても残らない）。 */
export function sanitizeError(text) {
  return String(text)
    .replace(/[^A-Za-z0-9_.:/+=\- ]/gu, "_")
    .slice(0, 400);
}

/**
 * エラーを出力に載せる形に要約する。自由文は載せず、名前（ASCII の識別子だけ）、
 * [precheck]／[artifact] の印、大文字の code（NEX_READ_SET_STALE など）、key=数値 の対だけ残す。
 */
export function safeErrorSummary(error) {
  const name =
    error && typeof error === "object" && typeof error.name === "string"
      ? error.name
      : "NonError";
  const message =
    error && typeof error === "object" && typeof error.message === "string"
      ? error.message
      : "";
  // Playwright は "page.evaluate: Error: [artifact] ..." のように包むので、先頭に限らず探す。
  const tag = /\[(precheck|artifact)\]/u.exec(message)?.[1] ?? "none";
  const pairs = [...message.matchAll(/\b([A-Za-z]{1,30})=(\d{1,9})\b/gu)]
    .slice(0, 6)
    .map((m) => `${m[1]}=${m[2]}`);
  const codes = [
    ...new Set(
      [...message.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu)].map((m) =>
        m[0].slice(0, 60),
      ),
    ),
  ].slice(0, 5);
  return {
    name: /^[A-Za-z0-9_]{1,60}$/u.test(name) ? name : "Error",
    tag,
    codes,
    pairs,
  };
}

// ---- 一括承認可・集合の突合 -------------------------------------------------

/** 製品の画面（safeCount）と bulkApproveSafeCodexStructureProposals の 3 条件。 */
export function isBulkApprovableRow(row) {
  return (
    row.applicability === "applicable" &&
    row.status === "unreviewed" &&
    row.safe === true
  );
}
export function countBulkApprovable(rows) {
  return rows.filter(isBulkApprovableRow).length;
}

/** 二つの hash の集合の差（件数だけ）。 */
export function compareHashSets(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  let both = 0;
  for (const hash of a) if (b.has(hash)) both++;
  return {
    left: a.size,
    right: b.size,
    both,
    leftOnly: a.size - both,
    rightOnly: b.size - both,
  };
}

// ---- ルビ（｜親文字《読み》）と ProseMirror 本文 -------------------------------

/**
 * 段落の「ルビ記法を親文字だけにした」文字列。製品の取り込み（kakuyomuBodyToProseMirror）が
 * 作る ruby node の base を、TS の canonical が本文として読む形（proseMirrorSerializer の
 * ruby 分岐）に合わせる。`《《強調》》` は強調の中身、`｜` は落とし、`《読み》` を除く。
 */
export function rubyBaseText(paragraph) {
  return paragraph
    .replace(/《《([^》]*)》》/gu, "$1")
    .replace(/｜/gu, "")
    .replace(/《[^》]*》/gu, "");
}

/** 段落の列に含まれるルビ記法（《読み》）の数。強調の《《》》は数えない。 */
export function countRubyNotations(paragraphs) {
  let count = 0;
  for (const paragraph of paragraphs) {
    const stripped = paragraph.replace(/《《([^》]*)》》/gu, "$1");
    count += (stripped.match(/《[^》]*》/gu) ?? []).length;
  }
  return count;
}

/**
 * 段落を [{ base, reading }] に分ける（reading は無ければ null）。作者向けの抜粋の表示用で、
 * 取り込みの変換とは別の簡易版：`｜親文字《読み》` と、直前の漢字の自動ルビ。強調の《《》》は
 * 中身だけにする。
 */
export function paragraphSegments(paragraph) {
  const text = paragraph.replace(/《《([^》]*)》》/gu, "$1");
  const segments = [];
  const kanji = /[一-鿿々〆〤ヶ]/u;
  let plain = "";
  const flush = () => {
    if (plain) segments.push({ base: plain, reading: null });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    if (text[i] === "｜") {
      const open = text.indexOf("《", i + 1);
      const close = open === -1 ? -1 : text.indexOf("》", open + 1);
      const base = open === -1 ? "" : text.slice(i + 1, open);
      const reading = close === -1 ? "" : text.slice(open + 1, close);
      if (base && reading) {
        flush();
        segments.push({ base, reading });
        i = close + 1;
        continue;
      }
      i++;
      continue;
    }
    if (text[i] === "《") {
      const close = text.indexOf("》", i + 1);
      const reading = close === -1 ? "" : text.slice(i + 1, close);
      let start = plain.length;
      while (start > 0 && kanji.test(plain[start - 1])) start--;
      const base = plain.slice(start);
      if (reading && base) {
        plain = plain.slice(0, start);
        flush();
        segments.push({ base, reading });
        i = close + 1;
        continue;
      }
      plain += "《";
      i++;
      continue;
    }
    plain += text[i];
    i++;
  }
  flush();
  return segments;
}

/**
 * 保存した場面の ProseMirror JSON から、段落ごとの本文（ruby は親文字を読む）と、
 * ruby node の数・親文字（重複あり）を取り出す。prosemirrorToText は ruby を落とす
 * （text も content も無い node）ので、ルビのある作品の本文一致はこちらで行う。
 */
export function proseMirrorParagraphTexts(content) {
  const doc = typeof content === "string" ? JSON.parse(content) : content;
  const paragraphs = [];
  const rubyBases = [];
  const rubyPairs = [];
  let nonParagraphBlocks = 0;
  const inline = (node) => {
    if (!node || typeof node !== "object") return "";
    if (node.type === "text")
      return typeof node.text === "string" ? node.text : "";
    if (node.type === "ruby") {
      const base = node.attrs?.base;
      if (typeof base === "string") rubyBases.push(base);
      rubyPairs.push({
        base: typeof base === "string" ? base : "",
        annotation:
          typeof node.attrs?.annotation === "string"
            ? node.attrs.annotation
            : "",
      });
      return typeof base === "string" ? base : "";
    }
    if (node.type === "hardBreak") return "\n";
    return Array.isArray(node.content) ? node.content.map(inline).join("") : "";
  };
  for (const block of Array.isArray(doc?.content) ? doc.content : []) {
    if (block?.type === "paragraph") {
      paragraphs.push(
        Array.isArray(block.content) ? block.content.map(inline).join("") : "",
      );
    } else nonParagraphBlocks++;
  }
  return {
    paragraphs,
    rubyCount: rubyBases.length,
    rubyBases,
    rubyPairs,
    nonParagraphBlocks,
  };
}

/**
 * 保存した本文と scenes JSON の段落の突合（件数だけ）。段落数・本文・ruby node 数の
 * 3 つを場面ごとに比べる。expectedParagraphs は記法つきの段落（scenes JSON のまま）。
 */
export function comparePersistedScene(expectedParagraphs, content) {
  const actual = proseMirrorParagraphTexts(content);
  const expectedTexts = expectedParagraphs.map(rubyBaseText);
  const paragraphCountOk =
    actual.paragraphs.length === expectedParagraphs.length &&
    actual.nonParagraphBlocks === 0;
  const textOk =
    paragraphCountOk &&
    expectedTexts.every((t, i) => t === actual.paragraphs[i]);
  const rubyOk = actual.rubyCount === countRubyNotations(expectedParagraphs);
  // 親文字と読み（annotation）の並びの一致。期待側は製品と別実装の簡易分割（paragraphSegments）。
  // 読みは抽出に使われないので致命にせず、不一致の ruby の数だけを返す。
  const expectedPairs = expectedParagraphs.flatMap((paragraph) =>
    paragraphSegments(paragraph)
      .filter((segment) => segment.reading !== null)
      .map((segment) => ({
        base: segment.base,
        annotation: segment.reading,
      })),
  );
  let rubyPairMismatchCount = Math.abs(
    expectedPairs.length - actual.rubyPairs.length,
  );
  const common = Math.min(expectedPairs.length, actual.rubyPairs.length);
  for (let i = 0; i < common; i++) {
    if (
      expectedPairs[i].base !== actual.rubyPairs[i].base ||
      expectedPairs[i].annotation !== actual.rubyPairs[i].annotation
    )
      rubyPairMismatchCount++;
  }
  return {
    paragraphCountOk,
    textOk,
    rubyOk,
    rubyPairMismatchCount,
    rubyCount: actual.rubyCount,
    rubyBases: actual.rubyBases,
  };
}

/**
 * ルビの親文字の集合（candidateKey で潰す）と、表記の集合の関係（件数と、一致した表記の
 * hash を作るための表記の列）。
 * - exact：candidateKey が親文字のどれかに等しい表記
 * - containing：親文字（1 字以上）のどれかを含み、等しくない表記
 *   （1 字の親文字の偽陽性は、「seed のうち min1 の候補に無い表記」に限る seedMissingFromCandidates で抑える）
 */
export function rubySurfaceRelation(rubyBaseKeys, surfaces) {
  const bases = new Set(rubyBaseKeys.filter((k) => k.length > 0));
  const exactSurfaces = [];
  let containing = 0;
  for (const surface of new Set(surfaces.map(candidateKey))) {
    if (bases.has(surface)) exactSurfaces.push(surface);
    else if ([...bases].some((base) => surface.includes(base))) containing++;
  }
  return { exact: exactSurfaces.length, containing, exactSurfaces };
}

/**
 * 「seed のうち候補（min1 の raw）に無い表記」を直接数え、ルビの親文字との関係で 3 分類する
 * （主指標。閾値の影響を混ぜないため、候補は minCount=1 の集合を渡す）。
 * - exact：candidateKey が親文字に等しい
 * - containing：親文字（1 字以上）を含み、等しくない。そのうち 1 字の親文字だけで該当する数を
 *   containingShortOnly に分ける（偽陽性の余地）
 * - other：どちらでもない（ルビ以外の理由）
 * 出現数は seedOccurrence（表記 → seed の出現数）と candidateOccurrence（表記 → 候補の count）の
 * 差（seed − 候補）を、表記の分類ごと（欠落した表記は candidate 0）に合計する。両方にある表記の
 * 出現数の食い違いは presentOccurrenceDiff に分ける。
 */
export function seedMissingFromCandidates(
  rubyBaseKeys,
  seedOccurrence,
  candidateOccurrence,
) {
  const bases = new Set(rubyBaseKeys.filter((k) => k.length > 0));
  const seedMap = new Map();
  for (const [surface, count] of seedOccurrence) {
    const key = candidateKey(surface);
    seedMap.set(key, (seedMap.get(key) ?? 0) + count);
  }
  const candMap = new Map();
  for (const [surface, count] of candidateOccurrence) {
    const key = candidateKey(surface);
    candMap.set(key, (candMap.get(key) ?? 0) + count);
  }
  const classes = {
    exact: { surfaces: 0, occurrences: 0, keys: [] },
    containing: { surfaces: 0, occurrences: 0, keys: [], shortOnly: 0 },
    other: { surfaces: 0, occurrences: 0, keys: [] },
  };
  let presentOccurrenceDiff = 0;
  let missing = 0;
  for (const [key, seedCount] of seedMap) {
    if (candMap.has(key)) {
      presentOccurrenceDiff += seedCount - candMap.get(key);
      continue;
    }
    missing++;
    let cls = "other";
    let shortOnly = false;
    if (bases.has(key)) cls = "exact";
    else {
      const hit = [...bases].filter((base) => key.includes(base));
      if (hit.length > 0) {
        cls = "containing";
        shortOnly = hit.every((base) => [...base].length < 2);
      }
    }
    classes[cls].surfaces++;
    classes[cls].occurrences += seedCount;
    classes[cls].keys.push(key);
    if (cls === "containing" && shortOnly) classes.containing.shortOnly++;
  }
  return {
    seedDistinct: seedMap.size,
    candidateDistinct: candMap.size,
    missing,
    presentOccurrenceDiff,
    classes,
  };
}

// ---- 名簿（roster）の形式（事前登録 §3） ---------------------------------------

export const ROSTER_SCHEMA = "identity-roster/1";
export const ENTITY_TYPES = Object.freeze(["character", "location", "other"]);
export const ALIAS_LEVELS = Object.freeze(["L1", "L2", "L3"]);
/** 作った系統：A（実体系）・B（表記系）・adjudicated（調停）。 */
export const LINEAGES = Object.freeze(["A", "B", "adjudicated"]);
export const REVIEW_STATUSES = Object.freeze([
  "unconfirmed",
  "confirmed",
  "edited",
  "flagged",
]);
/** 作者の応答の固定語彙（§4）。 */
export const REVIEW_VERDICTS = Object.freeze([
  "そのまま",
  "名前を直す",
  "別名を足す",
  "別名を外す",
  "別人が混ざる",
  "分けるべき",
  "わからない",
]);
/** 応答の語彙の ASCII の印（標準出力・集計用。語彙の順と対応）。 */
export const REVIEW_VERDICT_CODES = Object.freeze({
  そのまま: "keep",
  名前を直す: "rename",
  別名を足す: "add-alias",
  別名を外す: "remove-alias",
  別人が混ざる: "mixed",
  分けるべき: "split",
  わからない: "unknown",
});

/**
 * 名簿の 1 行（実体）の形：
 * {
 *   id: "rt-<作品>-NNN", type: "character"|"location"|"other",
 *   name: 正式な名前（役職でしか呼ばれない人物は最も確定的な呼称。nameIsRole を付ける）,
 *   nameIsRole?: boolean, frequentSurface?: string（最頻形。別列）,
 *   aliases: [{ surface, level: "L1"|"L2"|"L3" }]（L0 は name だけ。敬称付きの形は入れない）,
 *   honorificSurfaces: [string]（敬称の対応表。表記→この実体。別名としては登録しない）,
 *   ambiguousSurfaces: [{ surface, sceneRanges: [[from, to], ...] }]（場面で指す実体が変わる表記。
 *     この実体を指す場面の範囲。別名に入れない）,
 *   firstScene: 初出場面（1 始まり。必須。evidence に含まれ、evidence のどの場面より後でない。
 *     name・別名のうち最も早く本文に現れる場面と一致することを checkRosterAgainstScenes が検査する）,
 *   evidence: [{ scene, paragraph }]（根拠。1 始まり。1 件以上）,
 *   lineage: "A"|"B"|"adjudicated", origin?: { A?: [id], B?: [id] }, packets?: [packet id]（調停した packet）,
 *   review?: { status, verdict?, note? }（作者の確認の結果。確認前は無い）
 * }
 * 名簿：{ schemaVersion, work, lineage, entities, reviewSummary? }
 */
const ID_PATTERN = (work) => new RegExp(`^rt-${work}-\\d{3,}$`, "u");
const PACKET_PATTERN = (work) => new RegExp(`^pk-${work}-\\d{3,}$`, "u");

function isPlainString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\n")
  );
}
function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/** 敬称付きの形（X＋接尾辞。接尾辞だけの単独の表記は含まない）。 */
export function isHonorificForm(surface) {
  const key = candidateKey(surface);
  const stripped = candidateKey(stripHonorific(key));
  return stripped !== key && stripped.length > 0;
}

/** 実体の名前と別名の candidateKey の集合（name も含む）。 */
export function entityKeys(entity) {
  return [entity.name, ...(entity.aliases ?? []).map((a) => a.surface)]
    .filter((s) => typeof s === "string")
    .map(candidateKey);
}

/**
 * 名簿の検査。違反は { code, entityId, path } の列（表記の文字列は載せない）。
 * options: { sceneCount?, paragraphCounts?: 場面ごとの段落数（index 0 が場面 1） }
 */
export function validateRoster(roster, options = {}) {
  const errors = [];
  const add = (code, entityId, path) => errors.push({ code, entityId, path });
  if (!roster || typeof roster !== "object") {
    return {
      ok: false,
      errors: [{ code: "ROSTER_NOT_OBJECT", entityId: null, path: "$" }],
    };
  }
  if (roster.schemaVersion !== ROSTER_SCHEMA)
    add("SCHEMA_VERSION", null, "$.schemaVersion");
  const work = roster.work;
  if (!(typeof work === "string" && work in WORKS))
    add("UNKNOWN_WORK", null, "$.work");
  if (!LINEAGES.includes(roster.lineage))
    add("ROSTER_LINEAGE", null, "$.lineage");
  if (!Array.isArray(roster.entities)) {
    add("ENTITIES_NOT_ARRAY", null, "$.entities");
    return { ok: false, errors };
  }
  const sceneCount =
    options.sceneCount ?? (work in WORKS ? WORKS[work] : undefined);
  const idPattern = typeof work === "string" ? ID_PATTERN(work) : /^$/u;
  const packetPattern = typeof work === "string" ? PACKET_PATTERN(work) : /^$/u;
  const ids = new Set();
  const nameKeys = new Map(); // candidateKey → entity id（名前）
  const aliasKeys = new Set();
  roster.entities.forEach((entity, index) => {
    const id = typeof entity?.id === "string" ? entity.id : `#${index}`;
    const at = (field) => `$.entities[${index}].${field}`;
    if (!entity || typeof entity !== "object") {
      add("ENTITY_NOT_OBJECT", id, `$.entities[${index}]`);
      return;
    }
    if (!idPattern.test(id)) add("ENTITY_ID_FORMAT", id, at("id"));
    if (ids.has(id)) add("ENTITY_ID_DUPLICATE", id, at("id"));
    ids.add(id);
    if (!ENTITY_TYPES.includes(entity.type)) add("ENTITY_TYPE", id, at("type"));
    if (!isPlainString(entity.name)) add("NAME_INVALID", id, at("name"));
    else {
      nameKeys.set(candidateKey(entity.name), id);
      if (isHonorificForm(entity.name))
        add("NAME_IS_HONORIFIC_FORM", id, at("name"));
    }
    if (
      entity.nameIsRole !== undefined &&
      typeof entity.nameIsRole !== "boolean"
    )
      add("NAME_IS_ROLE_TYPE", id, at("nameIsRole"));
    if (
      entity.frequentSurface !== undefined &&
      !isPlainString(entity.frequentSurface)
    )
      add("FREQUENT_SURFACE_INVALID", id, at("frequentSurface"));
    if (!LINEAGES.includes(entity.lineage))
      add("ENTITY_LINEAGE", id, at("lineage"));
    if (entity.packets !== undefined) {
      if (
        !Array.isArray(entity.packets) ||
        entity.packets.some((p) => !packetPattern.test(p))
      )
        add("PACKET_ID_FORMAT", id, at("packets"));
    }
    // 別名
    const ownKeys = new Set(
      isPlainString(entity.name) ? [candidateKey(entity.name)] : [],
    );
    if (!Array.isArray(entity.aliases))
      add("ALIASES_NOT_ARRAY", id, at("aliases"));
    else
      entity.aliases.forEach((alias, i) => {
        const where = `${at("aliases")}[${i}]`;
        if (!alias || !isPlainString(alias.surface)) {
          add("ALIAS_SURFACE_INVALID", id, where);
          return;
        }
        if (!ALIAS_LEVELS.includes(alias.level)) add("ALIAS_LEVEL", id, where);
        const key = candidateKey(alias.surface);
        if (ownKeys.has(key)) add("ALIAS_DUPLICATE_IN_ENTITY", id, where);
        ownKeys.add(key);
        aliasKeys.add(key);
        if (isHonorificForm(alias.surface))
          add("ALIAS_IS_HONORIFIC_FORM", id, where);
      });
    // 敬称の対応表
    const honorifics = entity.honorificSurfaces ?? [];
    if (!Array.isArray(honorifics))
      add("HONORIFICS_NOT_ARRAY", id, at("honorificSurfaces"));
    else {
      const seen = new Set();
      honorifics.forEach((surface, i) => {
        const where = `${at("honorificSurfaces")}[${i}]`;
        if (!isPlainString(surface))
          add("HONORIFIC_SURFACE_INVALID", id, where);
        else {
          if (!isHonorificForm(surface))
            add("HONORIFIC_NOT_HONORIFIC_FORM", id, where);
          const key = candidateKey(surface);
          if (seen.has(key)) add("HONORIFIC_DUPLICATE_IN_ENTITY", id, where);
          seen.add(key);
        }
      });
    }
    // 場面で指す実体が変わる表記
    const ambiguous = entity.ambiguousSurfaces ?? [];
    if (!Array.isArray(ambiguous))
      add("AMBIGUOUS_NOT_ARRAY", id, at("ambiguousSurfaces"));
    else
      ambiguous.forEach((item, i) => {
        const where = `${at("ambiguousSurfaces")}[${i}]`;
        if (!item || !isPlainString(item.surface)) {
          add("AMBIGUOUS_SURFACE_INVALID", id, where);
          return;
        }
        if (ownKeys.has(candidateKey(item.surface)))
          add("AMBIGUOUS_IN_ALIAS", id, where);
        const ranges = item.sceneRanges;
        if (
          !Array.isArray(ranges) ||
          ranges.length === 0 ||
          ranges.some(
            (r) =>
              !Array.isArray(r) ||
              r.length !== 2 ||
              !isPositiveInt(r[0]) ||
              !isPositiveInt(r[1]) ||
              r[0] > r[1] ||
              (sceneCount !== undefined && r[1] > sceneCount),
          )
        )
          add("AMBIGUOUS_RANGE_INVALID", id, `${where}.sceneRanges`);
      });
    // 初出場面（必須）
    const hasFirstScene = isPositiveInt(entity.firstScene);
    if (!hasFirstScene) add("FIRST_SCENE_INVALID", id, at("firstScene"));
    else if (sceneCount !== undefined && entity.firstScene > sceneCount)
      add("FIRST_SCENE_RANGE", id, at("firstScene"));
    // 根拠
    if (!Array.isArray(entity.evidence) || entity.evidence.length === 0)
      add("EVIDENCE_MISSING", id, at("evidence"));
    else
      entity.evidence.forEach((ev, i) => {
        const where = `${at("evidence")}[${i}]`;
        if (!ev || !isPositiveInt(ev.scene) || !isPositiveInt(ev.paragraph)) {
          add("EVIDENCE_INVALID", id, where);
          return;
        }
        if (sceneCount !== undefined && ev.scene > sceneCount)
          add("EVIDENCE_SCENE_RANGE", id, where);
        else if (
          options.paragraphCounts &&
          ev.paragraph > (options.paragraphCounts[ev.scene - 1] ?? 0)
        )
          add("EVIDENCE_PARAGRAPH_RANGE", id, where);
      });
    if (hasFirstScene && Array.isArray(entity.evidence)) {
      const evidenceScenes = entity.evidence
        .map((ev) => ev?.scene)
        .filter(isPositiveInt);
      if (
        evidenceScenes.length > 0 &&
        !evidenceScenes.includes(entity.firstScene)
      )
        add("FIRST_SCENE_NOT_IN_EVIDENCE", id, at("firstScene"));
      if (evidenceScenes.some((scene) => scene < entity.firstScene))
        add("FIRST_SCENE_AFTER_EVIDENCE", id, at("firstScene"));
    }
    if (
      entity.review !== undefined &&
      !REVIEW_STATUSES.includes(entity.review?.status)
    )
      add("REVIEW_STATUS", id, at("review"));
  });
  // 語り手（任意の最上位の欄）：実体 ID か null。
  if (roster.narrator !== undefined && roster.narrator !== null) {
    if (typeof roster.narrator !== "string")
      add("NARRATOR_INVALID", null, "$.narrator");
    else if (!ids.has(roster.narrator))
      add("NARRATOR_UNKNOWN", null, "$.narrator");
  }
  // 敬称の対応表と、名前・別名の重なり（機械検査。作者の確認には回さない）
  const owners = new Set([...nameKeys.keys(), ...aliasKeys]);
  roster.entities.forEach((entity, index) => {
    for (const [i, surface] of (Array.isArray(entity?.honorificSurfaces)
      ? entity.honorificSurfaces
      : []
    ).entries()) {
      if (typeof surface === "string" && owners.has(candidateKey(surface)))
        add(
          "HONORIFIC_OVERLAPS_ALIAS",
          String(entity.id),
          `$.entities[${index}].honorificSurfaces[${i}]`,
        );
    }
  });
  // 同じ表記の「場面で変わる」宣言が、別の実体と場面の範囲で重なる
  const rangesByKey = new Map();
  roster.entities.forEach((entity) => {
    for (const item of Array.isArray(entity?.ambiguousSurfaces)
      ? entity.ambiguousSurfaces
      : []) {
      if (
        !item ||
        typeof item.surface !== "string" ||
        !Array.isArray(item.sceneRanges)
      )
        continue;
      const key = candidateKey(item.surface);
      if (!rangesByKey.has(key)) rangesByKey.set(key, []);
      for (const range of item.sceneRanges)
        if (Array.isArray(range) && range.length === 2)
          rangesByKey
            .get(key)
            .push({ id: String(entity.id), from: range[0], to: range[1] });
    }
  });
  for (const list of rangesByKey.values()) {
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++)
        if (
          list[a].id !== list[b].id &&
          list[a].from <= list[b].to &&
          list[b].from <= list[a].to
        )
          add(
            "AMBIGUOUS_RANGE_OVERLAP",
            list[a].id,
            "$.entities.ambiguousSurfaces",
          );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 名前・別名の衝突（§3）。key は表記の candidateKey（原稿由来なので、報告には出さない）。
 * - kind "ambiguous"（i）：同じ表記が 2 つ以上の実体の別名、または 2 つ以上の実体の名前になる。
 *   構造抽出は ambiguous を出す。
 * - kind "name-over-alias"（ii）：ある実体の名前（1 件だけ）が別の実体の別名と同じ。名前が 1 件だけ
 *   一致すれば、その実体へ即 resolved になり、別名側は見られない。resolvesTo は名前の側。
 * entityIds は関わる実体（名前の側が先）。declared は、関わる全実体が同じ表記を
 * ambiguousSurfaces に宣言しているか。
 */
export function findCollisions(roster) {
  const byKey = new Map();
  const touch = (key) => {
    if (!byKey.has(key)) byKey.set(key, { nameOwners: [], aliasOwners: [] });
    return byKey.get(key);
  };
  for (const entity of roster.entities) {
    if (typeof entity.name === "string") {
      const slot = touch(candidateKey(entity.name));
      if (!slot.nameOwners.includes(entity.id)) slot.nameOwners.push(entity.id);
    }
    for (const alias of entity.aliases ?? []) {
      if (typeof alias.surface !== "string") continue;
      const slot = touch(candidateKey(alias.surface));
      if (
        !slot.nameOwners.includes(entity.id) &&
        !slot.aliasOwners.includes(entity.id)
      )
        slot.aliasOwners.push(entity.id);
    }
  }
  const declaredBy = new Map();
  for (const entity of roster.entities)
    for (const item of entity.ambiguousSurfaces ?? [])
      if (typeof item.surface === "string") {
        const key = candidateKey(item.surface);
        if (!declaredBy.has(key)) declaredBy.set(key, new Set());
        declaredBy.get(key).add(entity.id);
      }
  const collisions = [];
  for (const [key, slot] of byKey) {
    const involved = [...slot.nameOwners, ...slot.aliasOwners];
    if (involved.length < 2) continue;
    const declared = involved.every((id) => declaredBy.get(key)?.has(id));
    if (slot.nameOwners.length === 1)
      collisions.push({
        kind: "name-over-alias",
        key,
        entityIds: involved,
        resolvesTo: slot.nameOwners[0],
        declared,
      });
    else
      collisions.push({
        kind: "ambiguous",
        key,
        entityIds: involved,
        declared,
      });
  }
  return collisions.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 名簿から、段ごとの登録用の実体を作る（registerRoster に渡す形）。
 * L0：name だけ／L1／L2／L3／"L2-1char"：L2 から 1 字の別名を除く。
 */
export const ROSTER_LEVELS = Object.freeze([
  "L0",
  "L1",
  "L2",
  "L3",
  "L2-1char",
]);
export function rosterAtLevel(roster, level) {
  if (!ROSTER_LEVELS.includes(level))
    throw new RangeError("unknown roster level");
  const max = level === "L2-1char" ? 2 : Number(level.slice(1));
  return roster.entities.map((entity) => ({
    id: entity.id,
    type: entity.type,
    name: entity.name,
    aliases: (entity.aliases ?? [])
      .filter((alias) => Number(alias.level.slice(1)) <= max)
      .filter((alias) => level !== "L2-1char" || [...alias.surface].length > 1)
      .map((alias) => alias.surface),
  }));
}

/**
 * 名簿の初出場面を、本文（ルビ記法を親文字だけにした形）で機械検査する（原稿の文字列は返さない）。
 * 実体ごとに name と全別名（L1〜L3）を調べ、
 * - FIRST_SCENE_SURFACE_ABSENT：どの表記も firstScene の本文に無い
 * - FIRST_SCENE_SURFACE_EARLIER：いずれかの表記が firstScene より前の場面に現れる（件数は実体ごとの前の場面の数）
 * を { code, entityId, count } で返す。表記は candidateKey ではなく本文への単純な部分一致で数える。
 */
export function checkRosterAgainstScenes(roster, scenes) {
  const texts = scenes.map((scene) =>
    scene.paragraphs.map(rubyBaseText).join("\n"),
  );
  const errors = [];
  for (const entity of Array.isArray(roster?.entities) ? roster.entities : []) {
    if (!isPositiveInt(entity?.firstScene) || entity.firstScene > texts.length)
      continue;
    const surfaces = [
      entity.name,
      ...(Array.isArray(entity.aliases)
        ? entity.aliases.map((alias) => alias?.surface)
        : []),
    ].filter((surface) => typeof surface === "string" && surface.length > 0);
    const inScene = (index) =>
      surfaces.some((surface) => texts[index].includes(surface));
    if (!inScene(entity.firstScene - 1))
      errors.push({
        code: "FIRST_SCENE_SURFACE_ABSENT",
        entityId: String(entity.id),
        count: 1,
      });
    let earlier = 0;
    for (let i = 0; i < entity.firstScene - 1; i++) if (inScene(i)) earlier++;
    if (earlier > 0)
      errors.push({
        code: "FIRST_SCENE_SURFACE_EARLIER",
        entityId: String(entity.id),
        count: earlier,
      });
  }
  return [...errors, ...checkSurfacesAgainstScenes(roster, scenes)];
}

/**
 * 名簿の表記が本文に出ることの機械検査（原稿の文字列は返さない。ルビは親文字だけにした本文を使う）。
 * - SURFACE_NOT_IN_TEXT：実体の name・別名（alias）・敬称（honorific）・ambiguous の表記が、
 *   全場面の本文のどこにも出ない。{ code, entityId, field, count }（count は出ない表記の数）
 * - EVIDENCE_SURFACE_ABSENT：evidence の段落に、その実体のどの表記（name・別名・敬称・ambiguous）も無い。
 *   count は該当する evidence の数。範囲外の evidence は形式の検査（validateRoster）に任せて飛ばす
 * - AMBIGUOUS_RANGE_SURFACE_ABSENT：ambiguousSurfaces の sceneRanges の場面のどれにも、その表記が出ない。
 *   count は該当する surface の数
 * 表記は candidateKey ではなく本文への単純な部分一致。
 */
export function checkSurfacesAgainstScenes(roster, scenes) {
  const paragraphTexts = scenes.map((scene) =>
    scene.paragraphs.map(rubyBaseText),
  );
  const texts = paragraphTexts.map((paragraphs) => paragraphs.join("\n"));
  const strings = (list) =>
    list.filter((surface) => typeof surface === "string" && surface.length > 0);
  const errors = [];
  for (const entity of Array.isArray(roster?.entities) ? roster.entities : []) {
    if (!entity || typeof entity !== "object") continue;
    const entityId = String(entity.id);
    const fields = {
      // 作者が確認の表で直した名前（review.verdict が「名前を直す」）は、本文にそのまま出なくてよい（作者の Codex の名前）。
      name: entity?.review?.verdict === "名前を直す" ? [] : strings([entity.name]),
      alias: strings(
        Array.isArray(entity.aliases)
          ? entity.aliases.map((alias) => alias?.surface)
          : [],
      ),
      honorific: strings(
        Array.isArray(entity.honorificSurfaces) ? entity.honorificSurfaces : [],
      ),
      ambiguous: strings(
        Array.isArray(entity.ambiguousSurfaces)
          ? entity.ambiguousSurfaces.map((item) => item?.surface)
          : [],
      ),
    };
    for (const [field, surfaces] of Object.entries(fields)) {
      const absent = surfaces.filter(
        (surface) => !texts.some((text) => text.includes(surface)),
      ).length;
      if (absent > 0)
        errors.push({
          code: "SURFACE_NOT_IN_TEXT",
          entityId,
          field,
          count: absent,
        });
    }
    const all = Object.values(fields).flat();
    if (Array.isArray(entity.evidence)) {
      let absent = 0;
      for (const ev of entity.evidence) {
        const text = isPositiveInt(ev?.scene)
          ? paragraphTexts[ev.scene - 1]?.[ev.paragraph - 1]
          : undefined;
        if (text === undefined) continue;
        if (!all.some((surface) => text.includes(surface))) absent++;
      }
      if (absent > 0)
        errors.push({
          code: "EVIDENCE_SURFACE_ABSENT",
          entityId,
          count: absent,
        });
    }
    if (Array.isArray(entity.ambiguousSurfaces)) {
      let absent = 0;
      for (const item of entity.ambiguousSurfaces) {
        if (
          typeof item?.surface !== "string" ||
          item.surface.length === 0 ||
          !Array.isArray(item.sceneRanges)
        )
          continue;
        const found = item.sceneRanges.some(
          (range) =>
            Array.isArray(range) &&
            isPositiveInt(range[0]) &&
            isPositiveInt(range[1]) &&
            texts
              .slice(range[0] - 1, Math.min(range[1], texts.length))
              .some((text) => text.includes(item.surface)),
        );
        if (!found) absent++;
      }
      if (absent > 0)
        errors.push({
          code: "AMBIGUOUS_RANGE_SURFACE_ABSENT",
          entityId,
          count: absent,
        });
    }
  }
  return errors;
}

/** 実体の初出場面（firstScene。古い形の名簿は根拠の最小の場面。無ければ null）。 */
export function firstSceneOf(entity) {
  if (isPositiveInt(entity.firstScene)) return entity.firstScene;
  const scenes = (entity.evidence ?? [])
    .map((ev) => ev.scene)
    .filter(isPositiveInt);
  return scenes.length ? Math.min(...scenes) : null;
}

/** Wilson 95％の上側限界（k：検出した誤り、n：行数）。0/10 は約 0.278。 */
export function wilsonUpper(k, n, z = 1.96) {
  if (!Number.isSafeInteger(n) || n < 1 || k < 0 || k > n)
    throw new RangeError("invalid k or n");
  const p = k / n;
  const z2 = z * z;
  return (
    (p + z2 / (2 * n) + z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) /
    (1 + z2 / n)
  );
}

// ---- 測定 B：AI 判定の失敗の分類 ---------------------------------------------

/** 再送してよい失敗の種類（通信の失敗＝429／5xx／接続）。判定の中身の失敗は再送しない。 */
export const RETRYABLE_FAILURE_KINDS = Object.freeze([
  "rate-limit",
  "server",
  "network",
]);

/**
 * judgeCandidates が投げた例外を、失敗の種類（と HTTP status があれば数値）に分類する。
 * メッセージの本文は返さない（返り値は enum と数値だけ）。
 * - auth：401／403
 * - rate-limit：429
 * - server：5xx（529 を含む）
 * - network：接続・名前解決・timeout
 * - no-valid-result：判定の中身が有効でない（CODEX_JUDGMENT_NO_VALID_RESULT）
 * - license：ライセンス制限
 * - other：上のどれでもない
 */
export function classifyJudgmentFailure(error) {
  const text = [
    error && typeof error === "object" ? error.name : "",
    error && typeof error === "object" ? error.code : "",
    error && typeof error === "object" ? error.message : String(error ?? ""),
    error && typeof error === "object" && error.cause
      ? (error.cause.message ?? "")
      : "",
  ]
    .map((part) => String(part ?? ""))
    .join(" ");
  const status = /\b(?:status|http|error|code)\D{0,6}([45]\d\d)\b/iu.exec(
    text,
  )?.[1];
  const bare = /\b(401|403|429|5\d\d)\b/u.exec(text)?.[1];
  const code = Number(status ?? bare ?? 0) || null;
  if (/CODEX_JUDGMENT_NO_VALID_RESULT/u.test(text))
    return { kind: "no-valid-result", httpStatus: null };
  if (/LICENSE|license.?restrict/iu.test(text) && !code)
    return { kind: "license", httpStatus: null };
  if (
    code === 401 ||
    code === 403 ||
    /unauthori[sz]ed|forbidden|invalid.{0,10}api.?key|authentication/iu.test(
      text,
    )
  )
    return { kind: "auth", httpStatus: code === 403 ? 403 : 401 };
  if (code === 429 || /rate.?limit|too many requests/iu.test(text))
    return { kind: "rate-limit", httpStatus: 429 };
  if (code !== null && code >= 500) return { kind: "server", httpStatus: code };
  if (/overloaded/iu.test(text)) return { kind: "server", httpStatus: 529 };
  if (
    /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|fetch failed|network|IPC_TIMEOUT|socket hang up/iu.test(
      text,
    )
  )
    return { kind: "network", httpStatus: null };
  return { kind: "other", httpStatus: code };
}
