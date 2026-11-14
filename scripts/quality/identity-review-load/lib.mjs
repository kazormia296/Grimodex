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
 * - substringOfOther：他の（より長い）表記の部分文字列になる表記の数（2 文字以上）
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
  let substringOfOther = 0;
  const byLength = [...keys].sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if ([...key].length < 2) continue;
    for (const other of byLength) {
      if (other.length <= key.length) break;
      if (other.includes(key)) {
        substringOfOther++;
        break;
      }
    }
  }
  return {
    distinct: keys.length,
    honorificStrippable,
    honorificOverlap,
    substringOfOther,
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

/**
 * 出力の JSON を、(1) 文字列の欄の拒否、(2) 原稿との shingle 走査、の両方で検査する。
 * 失敗時は件数と JSON path だけを持つ Error を投げる（値は載せない）。
 */
export function assertOutputClean(output, scenesTexts) {
  const unsafe = findUnsafeStrings(output);
  if (unsafe.length > 0) {
    throw new Error(
      `[artifact] output has ${unsafe.length} unsafe string field(s)`,
    );
  }
  const hits = countShingleHits(
    JSON.stringify(output),
    buildShingleSet(scenesTexts),
  );
  if (hits > 0) {
    throw new Error(`[artifact] output has ${hits} manuscript shingle hit(s)`);
  }
}
