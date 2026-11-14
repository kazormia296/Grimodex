// 同定の review の負荷の測定（identity-review-load）の純関数。
// renderer（Vite）と Node の双方から読むので、DOM・Node 固有の API は使わない
// （hash は globalThis.crypto.subtle）。原稿の本文・表記は、この module の戻り値に
// 「件数」「hash」「ID」としてしか出さない。

/** 作品 key → 場面数（事前登録 §2。凍結前に scenes JSON から再測する）。 */
export const WORKS = Object.freeze({
  "m-ja-1": 110,
  "m-ja-2": 117,
  "m-ja-3": 34,
  "g-ja-1": 117,
});

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

/**
 * 出力 JSON の「文字列の欄」を拒む。ASCII の識別子の形（hash・enum・日時・path）以外の
 * 文字列があれば、その JSON path のリストを返す（値は返さない）。
 */
export function findUnsafeStrings(value, trail = "$") {
  const found = [];
  if (typeof value === "string") {
    if (!SAFE_STRING.test(value)) found.push(trail);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) =>
      found.push(...findUnsafeStrings(item, `${trail}[${i}]`)),
    );
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!SAFE_STRING.test(key)) found.push(`${trail}.<key>`);
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
