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
  // master の取り込み（2026-11-23）で DENIED_COMMANDS に増えたもの（chat の IR）。
  // Mastra の agent turn（mastra_agent_*）は ipcContract に無いので、下の AI_COMMAND の形で拾う。
  "chat_agent_ir_select",
  "get_ai_settings",
  "save_ai_settings",
  "semantic_download_model",
  "activate_license",
  "revalidate_license",
  "deactivate_license",
]);
const AI_COMMAND =
  /^(send_|codex_app_|mastra_agent_|start_post_effect_run|.*_cli_|.*_cli$|list_ai_models|test_ai_connection|get_mcp_config|nir1_local_generation|nir1_local_conversation|ai_(?!audit_read_snapshot$|audit_verify$)|.*judg|vivliostyle_)/u;
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

/**
 * seed の hash 集合と提案の hash 集合の突合（件数だけ返す）。
 * 製品は planner の前段で seed を落とす（codexStructureExtractionApi.ts）：関係の呼び名で名簿に当たらないもの
 * （projection.skippedRelationalTerms）と、候補画面で却下済みで名簿に当たらないもの
 * （projection.foldedDismissedSurfaces）。落とした表記は projection に残るので、期待は
 *   提案の集合 ＝ seed の集合 − 落とした表記
 * であり、planner が seed を飛ばさない（添字がずれない）ことは、この式が成り立つことで確かめる。
 * - seedOnlyUnexplained：落とした表記を引いても提案に無い seed（planner が飛ばした）
 * - proposalOnlyUnexplained：seed に無い提案、または落とした表記なのに提案になっているもの
 * - droppedNotInSeed：落とした表記が、道具が独立に読んだ seed に無い（prepass の読みが製品と食い違う）
 * - relationalAndDismissed：同じ表記が両方の落とし先に入った（製品は呼び名を先に落とすので 0 のはず）
 */
export function reconcileSeedsWithProposals({
  seedHashes,
  proposalHashes,
  droppedRelationalHashes = [],
  droppedDismissedHashes = [],
}) {
  const seeds = new Set(seedHashes);
  const proposals = new Set(proposalHashes);
  const relational = new Set(droppedRelationalHashes);
  const dismissed = new Set(droppedDismissedHashes);
  const dropped = new Set([...relational, ...dismissed]);
  let droppedNotInSeed = 0;
  let droppedAndProposed = 0;
  for (const hash of dropped) {
    if (!seeds.has(hash)) droppedNotInSeed++;
    if (proposals.has(hash)) droppedAndProposed++;
  }
  let relationalAndDismissed = 0;
  for (const hash of relational)
    if (dismissed.has(hash)) relationalAndDismissed++;
  let seedOnlyUnexplained = 0;
  let proposalOnlyUnexplained = 0;
  for (const hash of seeds)
    if (!dropped.has(hash) && !proposals.has(hash)) seedOnlyUnexplained++;
  for (const hash of proposals)
    if (!seeds.has(hash) || dropped.has(hash)) proposalOnlyUnexplained++;
  return {
    seed: seeds.size,
    proposal: proposals.size,
    droppedRelational: relational.size,
    droppedFoldedDismissed: dismissed.size,
    droppedNotInSeed,
    droppedAndProposed,
    relationalAndDismissed,
    seedOnlyUnexplained,
    proposalOnlyUnexplained,
    ok:
      droppedNotInSeed === 0 &&
      relationalAndDismissed === 0 &&
      seedOnlyUnexplained === 0 &&
      proposalOnlyUnexplained === 0,
  };
}

/**
 * 名簿の「場面で指す人が変わる表記」（S5-roster。重複を除いた hash 集合）を、集合の所属から 1 つずつ分類して件数だけ返す
 * （事前登録 DR-ILM-38 の (iv)(v)。表記の文字列は持たない）。hash は 4 つの集合とも hashSurface（表記そのまま。candidateKey で
 * 正規化しない）。S5 の各表記は次の 3 区分のどれか 1 つに入る（重ならない。件数の引き算で作らない）：
 * - notSeed：seed に無く、提案にも無い（抽出が拾わない）
 * - seedNotProposed：seed にあるが、提案に無い（製品が落とした表記など）
 * - proposed：提案に出る（S5_seen）。seed に無いのに提案にあれば proposedOutsideSeed に数える（0 のはず。道具の読みの検査）
 * candidateHashes（候補画面の候補の hash。null なら未計測）は重なってよい別の数：inCandidate（候補に出る）、
 * notSeedInCandidate（seed にならないが候補に出る）、neitherSeedNorCandidate（seed にも候補にもならない）。
 */
export function classifyS5Surfaces({
  s5Hashes,
  seedHashes,
  proposalHashes,
  candidateHashes = null,
}) {
  const s5 = new Set(s5Hashes);
  const seeds = new Set(seedHashes);
  const proposals = new Set(proposalHashes);
  const candidates = candidateHashes === null ? null : new Set(candidateHashes);
  let notSeed = 0;
  let seedNotProposed = 0;
  let proposed = 0;
  let proposedOutsideSeed = 0;
  let inCandidate = 0;
  let notSeedInCandidate = 0;
  let neitherSeedNorCandidate = 0;
  for (const hash of s5) {
    const inSeed = seeds.has(hash);
    if (proposals.has(hash)) {
      proposed++;
      if (!inSeed) proposedOutsideSeed++;
    } else if (inSeed) seedNotProposed++;
    else notSeed++;
    if (candidates) {
      const inCand = candidates.has(hash);
      if (inCand) inCandidate++;
      if (!inSeed && inCand) notSeedInCandidate++;
      if (!inSeed && !inCand) neitherSeedNorCandidate++;
    }
  }
  return {
    rosterSurfaces: s5.size,
    notSeed,
    seedNotProposed,
    proposed,
    proposedOutsideSeed,
    candidate: candidates
      ? { inCandidate, notSeedInCandidate, neitherSeedNorCandidate }
      : null,
  };
}

// ---- 保存済みの未 review の提案の件数（事前登録の問い 4。DB から件数だけ）------------------

/**
 * Codex の構造抽出が保存する提案の kind（製品の名前。codexStructureExtractionApi.ts の saveProposalSet）と、
 * その件数に当たる projection の欄。product-parity.test.mjs が製品の source と照合する。
 */
export const STORED_PROPOSAL_KIND_FIELDS = Object.freeze({
  "codex.entity.bind": "entityProposalCount",
  "codex.relation.create": "relationProposalCount",
  "codex.detail.base.set": "baseDetailProposalCount",
  "codex.phase.bind": "phaseProposalCount",
});
export const STORED_PROPOSAL_KINDS = Object.freeze(
  Object.keys(STORED_PROPOSAL_KIND_FIELDS),
);
/** 製品の NarrativeProposalStatus（runtime/types.ts）。未 review ＝ "unreviewed"。 */
export const STORED_PROPOSAL_STATUSES = Object.freeze([
  "unreviewed",
  "approved",
  "rejected",
  "deferred",
  "held",
]);
/** 製品の NarrativeExtractionRunStatus（runtime/types.ts）。 */
export const STORED_RUN_STATUSES = Object.freeze([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);
/** 製品の ProposalSet の status（runtime/types.ts）。 */
export const STORED_SET_STATUSES = Object.freeze([
  "draft",
  "published",
  "superseded",
]);
/** 製品の「再開できる run」の列挙の上限（Native の list_resumable_runs は 1〜100 に収める）。 */
export const STORED_RUN_LIST_LIMIT = 100;
/**
 * 製品の restore（restoreCodexStructureExtractionReview）が列挙する run の数（limit: 8）と、再開できる run の状態
 * （runRepository.ts の RESUMABLE_RUN_STATUSES）。product-parity.test.mjs が製品の source と照合する。
 */
export const STORED_RESTORE_LIST_LIMIT = 8;
export const STORED_RESUMABLE_RUN_STATUSES = Object.freeze([
  "pending",
  "running",
  "completed",
]);
/** 保存済みの run の役割（summarizeStoredProposals が付ける）。current／prior だけが「採用した段の run」。 */
export const STORED_RUN_ROLES = Object.freeze([
  "current",
  "prior",
  "failed-stage",
  "untracked",
]);
/** 保存済みの提案の読みの定義の版（measure-a-metrics.mjs の METRIC_DEFINITION_VERSION と同じ版の中の定義）。 */
export const STORED_DEFINITION = "status-unreviewed";
/** 未計測の理由。0 件とは別のものとして記録する。 */
export const STORED_NOT_MEASURED_REASONS = Object.freeze([
  "persist-skipped",
  "persist-failed",
  "read-failed",
]);

/** 既知の語だけを key にして数える（未知の語は other。0 件の key も残して形を固定する）。 */
function tallyKnown(values, known) {
  const counts = Object.fromEntries(known.map((k) => [k, 0]));
  counts.other = 0;
  for (const value of values) {
    if (known.includes(value)) counts[value]++;
    else counts.other++;
  }
  return counts;
}
const knownOrOther = (value, known) =>
  known.includes(value) ? value : "other";

/**
 * 保存済みの提案（DB）から数えた件数。本文・名簿・表記は入らない（kind・status の語と件数だけ）。
 * runs：製品の read-only の読み（list_resumable_runs と get_run_review_bundle）を行に落としたもの。
 *   { role: "current"|"prior", listedByProduct, tracked, failedStage, visibleToAuthor, runStatus, setStatus,
 *     proposals: [{ kind, status, applied }] }
 *   current ＝ この段の保存の run（道具が控える）。prior ＝ 前の段の run のうち、採用した（道具が控えた）run。
 *   failed-stage ＝ 道具が保存したが、その段が失敗して採用されなかった run。untracked ＝ 道具が控えていない run
 *   （保存の失敗の残りなど。製品の列挙にだけある）。採用しなかった 2 つは「前の回」に数えず、別に数える。
 *   current は高々 1 つ。visibleToAuthor ＝ 製品の restore が作者に出す run（planProductVisibleRuns）。
 * listedCount：製品の列挙（list_resumable_runs）が返した run の数（limit に達したら打ち切りの旗を立てる）。
 * 未 review ＝ 提案の status が "unreviewed"（製品の NarrativeProposalStatus。製品の画面の提案ごとの status と同じ。
 * 違うのは restore が書き換える関係の提案〔根拠が未解決の承認済み・適用不要の保留→未 review〕で、道具は再導出しない）。
 */
export function summarizeStoredProposals({ runs, listedCount }) {
  const roleOf = (run) => {
    if (run.role === "current") return "current";
    if (run.failedStage === true) return "failed-stage";
    if (run.tracked === false) return "untracked";
    return "prior";
  };
  const withRole = runs.map((run) => ({ run, adoption: roleOf(run) }));
  const ofRole = (...roles) =>
    withRole
      .filter((entry) => roles.includes(entry.adoption))
      .map((entry) => entry.run);
  const currentRuns = ofRole("current");
  if (currentRuns.length > 1)
    throw new Error("[artifact] STORED_CURRENT_RUN_NOT_UNIQUE");
  const priorRuns = ofRole("prior");
  const notAdoptedRuns = ofRole("failed-stage", "untracked");
  const visibleRuns = runs.filter((run) => run.visibleToAuthor === true);
  const unreviewedOf = (list) =>
    list.filter((proposal) => proposal.status === "unreviewed");
  const kindsOf = (list) =>
    tallyKnown(
      list.map((proposal) => proposal.kind),
      STORED_PROPOSAL_KINDS,
    );
  const proposalsOfRuns = (list) => list.flatMap((run) => run.proposals);
  const all = proposalsOfRuns(runs);
  const current = proposalsOfRuns(currentRuns);
  const prior = proposalsOfRuns(priorRuns);
  const notAdopted = proposalsOfRuns(notAdoptedRuns);
  const visible = proposalsOfRuns(visibleRuns);
  return {
    status: "measured",
    definition: STORED_DEFINITION,
    listLimit: STORED_RUN_LIST_LIMIT,
    restoreListLimit: STORED_RESTORE_LIST_LIMIT,
    listedByProductCount: listedCount,
    listTruncated: listedCount >= STORED_RUN_LIST_LIMIT,
    runCount: runs.length,
    currentRunCount: currentRuns.length,
    priorRunCount: priorRuns.length,
    // 採用しなかった run（失敗した段の run と、道具が控えていない run）。「前の回」に数えない。
    notAdoptedRunCount: notAdoptedRuns.length,
    failedStageRunCount: ofRole("failed-stage").length,
    // 製品の列挙にあるが道具が保存していない run（保存の失敗の残りなど）。
    untrackedRunCount: ofRole("untracked").length,
    // 製品の restore が作者に出す run の数（folder ごとの最新。それ以外の run の未 review は作者の画面に出ない）。
    visibleToAuthorRunCount: visibleRuns.length,
    // scope の folder の識別子が読めなかった run の数（0 のはず。0 でなければ「作者に見える run」が製品とずれる。製品の restore は folder 不明の run をどの folder にも当てるが、planProductVisibleRuns は独立の folder として数えるので、多く出る側にずれる）。
    folderUnknownRunCount: runs.filter((run) => run.folderKnown !== true)
      .length,
    // 道具が保存した run のうち、製品の列挙（再開できる run）に載らなかったもの（前の段の run も含む）。
    trackedNotListedByProductCount: runs.filter(
      (run) => run.tracked === true && !run.listedByProduct,
    ).length,
    unreviewed: {
      total: unreviewedOf(all).length,
      currentRun: unreviewedOf(current).length,
      priorRuns: unreviewedOf(prior).length,
      notAdoptedRuns: unreviewedOf(notAdopted).length,
      // 作者に見える run の分と、それ以外（total = visibleToAuthor + notVisibleToAuthor）。
      visibleToAuthor: unreviewedOf(visible).length,
      notVisibleToAuthor:
        unreviewedOf(all).length - unreviewedOf(visible).length,
      byKind: kindsOf(unreviewedOf(all)),
      currentRunByKind: kindsOf(unreviewedOf(current)),
      priorRunsByKind: kindsOf(unreviewedOf(prior)),
      visibleToAuthorByKind: kindsOf(unreviewedOf(visible)),
    },
    stored: {
      total: all.length,
      currentRun: current.length,
      priorRuns: prior.length,
      notAdoptedRuns: notAdopted.length,
      byStatus: tallyKnown(
        all.map((proposal) => proposal.status),
        STORED_PROPOSAL_STATUSES,
      ),
      byKind: kindsOf(all),
      currentRunByKind: kindsOf(current),
      applied: all.filter((proposal) => proposal.applied === true).length,
    },
    perRun: [
      ...currentRuns,
      ...priorRuns,
      ...ofRole("failed-stage"),
      ...ofRole("untracked"),
    ].map((run) => ({
      role: roleOf(run),
      listedByProduct: run.listedByProduct === true,
      tracked: run.tracked === true,
      visibleToAuthor: run.visibleToAuthor === true,
      folderKnown: run.folderKnown === true,
      runStatus: knownOrOther(run.runStatus, STORED_RUN_STATUSES),
      setStatus:
        run.setStatus === null || run.setStatus === undefined
          ? "none"
          : knownOrOther(run.setStatus, STORED_SET_STATUSES),
      total: run.proposals.length,
      unreviewed: unreviewedOf(run.proposals).length,
      unreviewedByKind: kindsOf(unreviewedOf(run.proposals)),
    })),
  };
}

/**
 * 読む run の一覧と役割（純関数）。製品の列挙（listedIds。新しい順）と、道具が保存した run（trackedIds。古い順。
 * 採用した段の run）と、保存したが段が失敗した run（failedIds）の和集合。製品の列挙は run の状態で絞られる
 * （pending／running／completed）ので、控えた run を必ず足す（前の段の run が一覧から落ちても、DB に残る
 * 未 review を 0 と読まない）。今回の run ＝ 最後に採用した保存の run。
 * failedStage：その段が失敗した run（前の回に数えない）。tracked：採用した段の run として控えたか。
 */
export function planStoredRuns({ listedIds, trackedIds, failedIds = [] }) {
  const currentId = trackedIds.at(-1) ?? null;
  const listed = new Set(listedIds);
  const tracked = new Set(trackedIds);
  const failed = new Set(failedIds);
  return [...new Set([...listedIds, ...trackedIds, ...failedIds])].map(
    (runId) => ({
      runId,
      role: runId === currentId ? "current" : "prior",
      listedByProduct: listed.has(runId),
      tracked: tracked.has(runId),
      failedStage: failed.has(runId) && !tracked.has(runId),
    }),
  );
}

/**
 * 製品の restore が作者に出す run の id の集合（純関数）。製品の restore は run の列挙（新しい順、先頭
 * STORED_RESTORE_LIST_LIMIT 件）のうち、開いた folder の run で最初に復元できたもの 1 つを出す。
 * ここでは folder ごとに、先頭 8 件のうち再開できる状態の最初の run を「作者に見える run」とする。
 * listed：製品の列挙（新しい順）の { runId, runStatus, folderKey }。folderKey は run の scope の folder の識別子で、
 * page の外へ出さない（比べるだけ）。復元の失敗（その run だけ読めない）は再現しない。
 */
export function planProductVisibleRuns({ listed }) {
  const visible = new Set();
  const seenFolders = new Set();
  for (const run of listed.slice(0, STORED_RESTORE_LIST_LIMIT)) {
    if (!STORED_RESUMABLE_RUN_STATUSES.includes(run.runStatus)) continue;
    const key = run.folderKey ?? null;
    if (seenFolders.has(key)) continue;
    seenFolders.add(key);
    visible.add(run.runId);
  }
  return visible;
}

/** 未計測（0 件ではない）。reason は STORED_NOT_MEASURED_REASONS のどれか。 */
export function storedNotMeasured(reason, error = null) {
  if (!STORED_NOT_MEASURED_REASONS.includes(reason))
    throw new Error(`[precheck] unknown not-measured reason ${reason}`);
  return {
    status: "not-measured",
    reason,
    ...(error ? { error } : {}),
  };
}

/**
 * 保存つきの段（persistAttempt が ok）だけ DB を読む。保存しない段・保存に失敗した段は未計測
 * （0 件と区別する。失敗した保存は途中の run を残しうるので、その段の件数は読まない）。
 */
export function planStoredRead(persistAttempt) {
  const status = persistAttempt?.status;
  if (status === "ok") return { read: true };
  if (status === "failed")
    return { read: false, result: storedNotMeasured("persist-failed") };
  return { read: false, result: storedNotMeasured("persist-skipped") };
}

/**
 * この段の run の保存済みの件数が、同じ段の projection の件数（提案の種類ごと）と一致するか。
 * 保存の経路が提案を落とす・増やすなら食い違う（道具の読みの検査）。件数と kind の名前だけ返す。
 */
export function compareStoredWithProjection(stored, extract) {
  if (stored?.status !== "measured" || stored.currentRunCount !== 1)
    return { compared: false, ok: null, differingKinds: [] };
  const differingKinds = STORED_PROPOSAL_KINDS.filter(
    (kind) =>
      (stored.stored.currentRunByKind[kind] ?? 0) !==
      (extract?.[STORED_PROPOSAL_KIND_FIELDS[kind]] ?? 0),
  );
  return {
    compared: true,
    ok:
      differingKinds.length === 0 && stored.stored.currentRunByKind.other === 0,
    differingKinds,
  };
}

// ---- 名簿の型が catalog に入ったか（F3b の m2）-------------------------------------------

/**
 * 登録した Entry の型が、製品の catalog（buildCodexStructureCatalogs の戻り）で同じ型として載ったかを確かめる（純関数）。
 * 製品は、project の型の一覧に無い型の Entry を先頭の型に落とす（existingCatalog の typeRef が typeCatalog の先頭になる）。
 * その場合、静的な旗は人物の型と判定しても、実行時の再検査は外す（bulkBind が過大になりうる）。
 * entries：[{ id, type }]（DB から読んだもの）。existingCatalog：[{ sourceKey, typeRef }]。typeCatalog：[{ ref, slug }]。
 * 返り値は件数だけ（id・型の文字列は返さない）。missingFromCatalog：catalog に載らなかった Entry。
 * typeMismatch：catalog の型の slug が、登録した型と違う Entry（先頭の型への落ち）。
 */
export function checkEntryTypesInCatalog({
  entries,
  existingCatalog,
  typeCatalog,
}) {
  if (
    !Array.isArray(entries) ||
    !Array.isArray(existingCatalog) ||
    !Array.isArray(typeCatalog)
  )
    return {
      determinable: false,
      checked: 0,
      missingFromCatalog: 0,
      typeMismatch: 0,
    };
  const slugByRef = new Map(typeCatalog.map((type) => [type?.ref, type?.slug]));
  const catalogBySource = new Map(
    existingCatalog.map((item) => [item?.sourceKey, item]),
  );
  let missingFromCatalog = 0;
  let typeMismatch = 0;
  for (const entry of entries) {
    const item = catalogBySource.get(entry?.id);
    if (!item) {
      missingFromCatalog++;
      continue;
    }
    const slug = slugByRef.get(item.typeRef);
    if (typeof slug !== "string" || slug !== entry.type) typeMismatch++;
  }
  // 型の一覧が空で Entry がある・Entry の型が文字列でない、は判定できない。
  const determinable =
    entries.every((entry) => typeof entry?.type === "string") &&
    (entries.length === 0 || typeCatalog.length > 0);
  return {
    determinable,
    checked: entries.length,
    missingFromCatalog,
    typeMismatch,
  };
}

/** checkEntryTypesInCatalog が不一致か判定不能なら止める（測定は始めない。件数だけの tag）。 */
export function assertEntryTypesInCatalog(input) {
  const result = checkEntryTypesInCatalog(input);
  if (!result.determinable)
    throw new Error(
      `[precheck] ENTRY_TYPE_CATALOG_UNDETERMINABLE checked=${result.checked}`,
    );
  if (result.missingFromCatalog > 0 || result.typeMismatch > 0)
    throw new Error(
      `[precheck] ENTRY_TYPE_NOT_IN_CATALOG checked=${result.checked} missing=${result.missingFromCatalog} typeMismatch=${result.typeMismatch}`,
    );
  return result;
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
 *   relationalSurfaces?: [string]（関係の呼び名。続柄・二人称・三人称の呼び方で、誰が言うか・どの場面かで指す人が決まる。
 *     別名・敬称の形・場面依存の表記のどれにも入れず、別の種類として持つ。Codex には登録しない。
 *     同じ表記が複数の実体にあってよい）,
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
    // 関係の呼び名（任意）。同じ実体の name・別名・敬称の形・場面依存の表記と重ならない。
    // 同じ表記が別の実体の relationalSurfaces にあるのは許す。
    if (entity.relationalSurfaces !== undefined) {
      if (!Array.isArray(entity.relationalSurfaces))
        add("RELATIONAL_NOT_ARRAY", id, at("relationalSurfaces"));
      else {
        const otherKeys = new Set(ownKeys);
        for (const surface of Array.isArray(honorifics) ? honorifics : [])
          if (typeof surface === "string") otherKeys.add(candidateKey(surface));
        for (const item of Array.isArray(ambiguous) ? ambiguous : [])
          if (typeof item?.surface === "string")
            otherKeys.add(candidateKey(item.surface));
        const seenRelational = new Set();
        entity.relationalSurfaces.forEach((surface, i) => {
          const where = `${at("relationalSurfaces")}[${i}]`;
          if (!isPlainString(surface)) {
            add("RELATIONAL_SURFACE_INVALID", id, where);
            return;
          }
          const key = candidateKey(surface);
          if (seenRelational.has(key))
            add("RELATIONAL_DUPLICATE_IN_ENTITY", id, where);
          seenRelational.add(key);
          if (otherKeys.has(key)) add("RELATIONAL_OVERLAP", id, where);
        });
      }
    }
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
 * 登録するのは name と別名だけ。敬称の形・場面依存の表記・関係の呼び名（relationalSurfaces）は含めない。
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
 * - SURFACE_NOT_IN_TEXT：実体の name・別名（alias）・敬称（honorific）・ambiguous・関係の呼び名（relational）の表記が、
 *   全場面の本文のどこにも出ない。{ code, entityId, field, count }（count は出ない表記の数）
 * - EVIDENCE_SURFACE_ABSENT：evidence の段落に、その実体のどの表記（name・別名・敬称・ambiguous・relational）も無い。
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
      relational: strings(
        Array.isArray(entity.relationalSurfaces)
          ? entity.relationalSurfaces
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

/**
 * 再送してよい失敗の種類。再送してよいのは、同じ body の要求が別に続いていないと確かめられる失敗だけ：
 * 429／5xx（応答が返った。要求は終わっている）と、接続が張れる前に終わった失敗（network-unsent：名前解決の失敗・接続拒否）。
 * 次は再送しない（F2 の R7）：
 * - ipc-timeout：IPC が 300 s で諦めても native の送信は続きうる。再送すると同じ body がもう 1 回出る。
 * - network：timeout・reset・hang up など。要求が相手に届いたかは不明。
 * 判定の中身の失敗も再送しない。
 */
export const RETRYABLE_FAILURE_KINDS = Object.freeze([
  "rate-limit",
  "server",
  "network-unsent",
]);

/**
 * 送信の直前の guard の順序（renderer の bJudge。page で動く）。どれかが通らなければ judge を呼ばずに、理由の分類だけを返す。
 *   key の導入前（not-armed）→ policy・ライセンス → 候補が 0 → 役割の上書き（role-override）→ 送る窓の名簿の hidden（hidden-roster）
 * 役割・hidden の確認が例外を投げる（設定・DB が読めない）のも、判定できないので送らない。judge は全部通った後に 1 回だけ呼ぶ。
 * 副作用（IPC・設定の読み）は deps で渡すので、fake で振る舞いを試験できる。
 */
export async function runGuardedJudge({
  sendArmed,
  blockedByPolicyOrLicense,
  visibleCount,
  assertRoleDefaults,
  countHiddenInSentWindow,
  judge,
}) {
  const refuse = (kind) => ({ ok: false, kind, durationMs: 0 });
  if (!sendArmed) return refuse("not-armed");
  if (blockedByPolicyOrLicense()) return refuse("policy-or-license");
  if (visibleCount === 0) return refuse("no-candidates");
  try {
    const role = await assertRoleDefaults();
    if (
      role.nonDefaultRoleKeys !== 0 ||
      role.roleProvidersNonDefault ||
      !role.sendOverrideClear
    )
      return refuse("role-override");
  } catch {
    return refuse("role-override");
  }
  try {
    if ((await countHiddenInSentWindow()) !== 0) return refuse("hidden-roster");
  } catch {
    return refuse("hidden-roster");
  }
  return judge();
}

/**
 * judgeCandidates が投げた例外を、失敗の種類（と HTTP status があれば数値）に分類する。
 * メッセージの本文は返さない（返り値は enum と数値だけ）。
 * - auth：401／403
 * - rate-limit：429
 * - server：5xx（529 を含む）
 * - ipc-timeout：IPC の timeout（native の送信は続いていて、要求が出たか・出続けているか分からない）
 * - network-unsent：接続が張れる前の失敗（名前解決・接続拒否・到達不能）。要求は出ていない
 * - network：上以外の接続・timeout・reset（要求が出たか分からない）
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
  if (/CODEX_JUDGMENT_NO_VALID_RESULT/u.test(text))
    return { kind: "no-valid-result", httpStatus: null };
  // IPC の timeout は最初に分ける（native の送信は続きうる。HTTP status や timed out の語より優先）。
  if (/IPC_TIMEOUT|IPC timeout after/u.test(text))
    return { kind: "ipc-timeout", httpStatus: null };
  // Rust の応答の失敗の文面 "AI request failed (NNN): …"／"AI request failed (HTTP NNN): …"（grimodex-ai）。応答が返った
  // 証拠で、括弧の status が正本。本文（detail）に何が書かれていても（512・rate limit など）status を優先して読む（F3a の m1）。
  const explicit = Number(
    /AI request failed\s*\((?:HTTP\s*)?(\d{3})\)/iu.exec(text)?.[1] ?? 0,
  );
  if (explicit >= 400 && explicit < 600) {
    if (explicit === 401 || explicit === 403)
      return { kind: "auth", httpStatus: explicit };
    if (explicit === 429) return { kind: "rate-limit", httpStatus: 429 };
    if (explicit >= 500) return { kind: "server", httpStatus: explicit };
    return { kind: "other", httpStatus: explicit };
  }
  // 届いたか分からない語（timeout・reset・broken pipe・hang up など）は、数字・rate limit の語より先に見て、再送しない側に倒す
  // （"timed out after 500 ms"・"connection reset (status 502)" を 5xx として再送しない）。
  if (
    /ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|timed?[ _-]?out|time-?out|\breset\b|broken pipe|hang ?up|connection (?:closed|aborted)|unexpected eof|incomplete message/iu.test(
      text,
    )
  )
    return { kind: "network", httpStatus: null };
  // status は、status・http・error・code の語に続く数字だけ読む（文中の 512 などの数字を status にしない）。
  const labeled = Number(
    /\b(?:status|http|error|code)\D{0,6}([45]\d\d)\b/iu.exec(text)?.[1] ?? 0,
  );
  const code = labeled || null;
  if (/LICENSE|license.?restrict/iu.test(text) && !code)
    return { kind: "license", httpStatus: null };
  if (
    code === 401 ||
    code === 403 ||
    /\b(401|403)\b/u.test(text) ||
    /unauthori[sz]ed|forbidden|invalid.{0,10}api.?key|authentication/iu.test(
      text,
    )
  )
    return {
      kind: "auth",
      httpStatus: code === 403 || /\b403\b/u.test(text) ? 403 : 401,
    };
  if (code === 429 || /rate.?limit|too many requests/iu.test(text))
    return { kind: "rate-limit", httpStatus: 429 };
  if (code !== null && code >= 500) return { kind: "server", httpStatus: code };
  if (/overloaded/iu.test(text)) return { kind: "server", httpStatus: 529 };
  // 接続が張れる前に終わったと言える語だけ（「error sending request」だけは含めない）。
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|dns error|failed to lookup address|connection refused/iu.test(
      text,
    )
  )
    return { kind: "network-unsent", httpStatus: null };
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network/iu.test(text))
    return { kind: "network", httpStatus: null };
  return { kind: "other", httpStatus: code };
}
