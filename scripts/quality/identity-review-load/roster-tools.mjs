// 同定の review の負荷の測定：名簿づくりの道具（純関数）。AI は呼ばない。
// 戻り値のうち「原稿の文字列を含むもの」（chunk の本文、packet の details、作者向けの表）は
// repo 外の 0600 の file にだけ書く。件数・ID・列名だけを返す関数は summary と名付ける。
import { createHash } from "node:crypto";
import {
  WORKS,
  REVIEW_VERDICTS,
  REVIEW_VERDICT_CODES,
  ALIAS_LEVELS,
  candidateKey,
  findCollisions,
  firstSceneOf,
  isHonorificForm,
  paragraphSegments,
  validateRoster,
  wilsonUpper,
} from "./lib.mjs";

const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const codePoints = (text) => [...text].length;

// ---- (a) chunk 分割 --------------------------------------------------------------

export const CHUNK_MAX_CHARS = 45000;

/**
 * 場面を chunk に分ける（場面をまたがない）。最初の chunk の上限が firstCap、以降は maxChars。
 * 上限を超える 1 場面は、それだけで 1 chunk（oversize）。字数は段落の文字数（code point）の和。
 * scenes: [{ index, paragraphs }]（scenesFromWork の戻り値）
 */
export function chunkScenes(
  scenes,
  { maxChars = CHUNK_MAX_CHARS, firstCap = maxChars } = {},
) {
  const chunks = [];
  let current = null;
  const capOf = (position) => (position === 0 ? firstCap : maxChars);
  for (const scene of scenes) {
    const chars = scene.paragraphs.reduce((acc, p) => acc + codePoints(p), 0);
    if (current && current.chars + chars > capOf(chunks.length)) {
      chunks.push(current);
      current = null;
    }
    if (!current)
      current = { sceneFrom: scene.index, sceneTo: scene.index, chars: 0 };
    current.sceneTo = scene.index;
    current.chars += chars;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk, i) => ({
    index: i + 1,
    ...chunk,
    // 1 場面だけで上限を超える chunk（場面をまたがないので、そのまま 1 chunk にする）。
    oversize: chunk.chars > capOf(i),
  }));
}

/** chunk の内側の切れ目（各 chunk の最後の場面。最後の chunk を除く）。 */
export function interiorBoundaries(chunks) {
  return chunks.slice(0, -1).map((chunk) => chunk.sceneTo);
}

export function sharedBoundaryCount(chunksA, chunksB) {
  const b = new Set(interiorBoundaries(chunksB));
  return interiorBoundaries(chunksA).filter((x) => b.has(x)).length;
}

/**
 * 系統 A の chunk と、切れ目を半分ずらした系統 B の chunk。B は最初の chunk の上限を
 * maxChars の半分にする。内側の切れ目が A と 1 つでも重なれば、重ならなくなるまで
 * 最初の上限を 1000 字ずつ下げる（最大 20 回。それでも重なれば Error）。
 */
export function chunkPair(scenes, { maxChars = CHUNK_MAX_CHARS } = {}) {
  const A = chunkScenes(scenes, { maxChars });
  let firstCap = Math.floor(maxChars / 2);
  for (let attempt = 0; attempt < 20; attempt++, firstCap -= 1000) {
    if (firstCap < 1000) break;
    const B = chunkScenes(scenes, { maxChars, firstCap });
    if (sharedBoundaryCount(A, B) === 0) return { A, B, firstCapB: firstCap };
  }
  throw new Error(
    "[precheck] CHUNK_BOUNDARIES_SHARED could not offset the B chunks",
  );
}

/**
 * chunk の本文（読む側の入力。原稿の本文を含むので repo 外だけに書く）。
 * 場面ごとに「=== 場面 N ===」、段落ごとに「[N:P] 本文」（N：場面、P：段落。1 始まり）。
 */
export function renderChunkText(scenes, chunk) {
  const lines = [`# 場面 ${chunk.sceneFrom} から ${chunk.sceneTo} まで`];
  for (const scene of scenes) {
    if (scene.index < chunk.sceneFrom || scene.index > chunk.sceneTo) continue;
    lines.push("", `=== 場面 ${scene.index} ===`);
    scene.paragraphs.forEach((paragraph, i) =>
      lines.push(`[${scene.index}:${i + 1}] ${paragraph}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---- (b) A と B の突合（調停の packet） ---------------------------------------------

function entityKeySets(entity) {
  const name = candidateKey(entity.name);
  const aliases = (entity.aliases ?? []).map((a) => candidateKey(a.surface));
  return { name, aliases, all: new Set([name, ...aliases]) };
}

/**
 * 系統 A と B の名簿を突き合わせ、実体の分割・併合・型・正式な名前・別名の違いだけを
 * 抜き出す。結びつけは (1) 名前が相手の名前か別名に一致 → 強い結び、(2) まだ結ばれない実体どうしの
 * 別名の一致 → 弱い結び。連結成分ごとに 1 つ判定する。
 * 戻り値 packets の details は表記の文字列を含む（repo 外だけ）。summary は件数だけ。
 */
export function diffRosters(rosterA, rosterB) {
  const work = rosterA.work;
  const nodes = [
    ...rosterA.entities.map((e) => ({
      side: "A",
      entity: e,
      keys: entityKeySets(e),
    })),
    ...rosterB.entities.map((e) => ({
      side: "B",
      entity: e,
      keys: entityKeySets(e),
    })),
  ];
  const parent = nodes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => {
    parent[find(i)] = find(j);
  };
  const degree = new Array(nodes.length).fill(0);
  const aNodes = nodes.map((n, i) => [n, i]).filter(([n]) => n.side === "A");
  const bNodes = nodes.map((n, i) => [n, i]).filter(([n]) => n.side === "B");
  for (const [a, i] of aNodes)
    for (const [b, j] of bNodes)
      if (b.keys.all.has(a.keys.name) || a.keys.all.has(b.keys.name)) {
        union(i, j);
        degree[i]++;
        degree[j]++;
      }
  for (const [a, i] of aNodes)
    for (const [b, j] of bNodes) {
      if (degree[i] > 0 || degree[j] > 0) continue;
      if (a.keys.aliases.some((k) => b.keys.all.has(k) && k !== ""))
        union(i, j);
    }
  const components = new Map();
  nodes.forEach((node, i) => {
    const root = find(i);
    if (!components.has(root)) components.set(root, { A: [], B: [] });
    components.get(root)[node.side].push(node);
  });
  const packets = [];
  let agree = 0;
  const kindCounts = {};
  const ordered = [...components.values()].sort(
    (x, y) =>
      Math.min(...[...x.A, ...x.B].map((n) => firstSceneOf(n.entity) ?? 1e9)) -
      Math.min(...[...y.A, ...y.B].map((n) => firstSceneOf(n.entity) ?? 1e9)),
  );
  for (const comp of ordered) {
    const kinds = [];
    const details = {};
    if (comp.A.length === 0) kinds.push("only-B");
    else if (comp.B.length === 0) kinds.push("only-A");
    else if (comp.A.length > 1 && comp.B.length === 1) kinds.push("split-in-A");
    else if (comp.A.length === 1 && comp.B.length > 1) kinds.push("split-in-B");
    else if (comp.A.length > 1 && comp.B.length > 1) kinds.push("split-both");
    else {
      const a = comp.A[0];
      const b = comp.B[0];
      if (a.entity.type !== b.entity.type) {
        kinds.push("type");
        details.type = { A: a.entity.type, B: b.entity.type };
      }
      if (a.keys.name !== b.keys.name) {
        kinds.push("name");
        details.name = { A: a.entity.name, B: b.entity.name };
      }
      const setA = new Map(
        (a.entity.aliases ?? []).map((x) => [candidateKey(x.surface), x]),
      );
      const setB = new Map(
        (b.entity.aliases ?? []).map((x) => [candidateKey(x.surface), x]),
      );
      // 名前の違いで、相手の名前が自分の別名にあるものは別名の差に数えない。
      const onlyA = [...setA]
        .filter(([k]) => !setB.has(k) && k !== b.keys.name)
        .map(([, x]) => x);
      const onlyB = [...setB]
        .filter(([k]) => !setA.has(k) && k !== a.keys.name)
        .map(([, x]) => x);
      if (onlyA.length || onlyB.length) {
        kinds.push("aliases");
        details.aliases = { onlyA, onlyB };
      }
    }
    if (kinds.length === 0) {
      agree++;
      continue;
    }
    for (const kind of kinds) kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
    const evidence = (list) =>
      list.flatMap((n) =>
        (n.entity.evidence ?? []).map((ev) => ({ id: n.entity.id, ...ev })),
      );
    const all = [...comp.A, ...comp.B];
    const evA = evidence(comp.A);
    const evB = evidence(comp.B);
    const sceneSet = new Set();
    for (const ev of [...evA, ...evB])
      for (const s of [ev.scene - 1, ev.scene, ev.scene + 1])
        if (s >= 1) sceneSet.add(s);
    packets.push({
      packetId: `pk-${work}-${String(packets.length + 1).padStart(3, "0")}`,
      kinds,
      aIds: comp.A.map((n) => n.entity.id),
      bIds: comp.B.map((n) => n.entity.id),
      entities: {
        A: comp.A.map((n) => n.entity),
        B: comp.B.map((n) => n.entity),
      },
      details,
      evidence: { A: evA, B: evB },
      scenesToRead: [...sceneSet].sort((x, y) => x - y),
      firstScene: Math.min(...all.map((n) => firstSceneOf(n.entity) ?? 1e9)),
    });
  }
  return {
    work,
    packets,
    summary: {
      work,
      entitiesA: rosterA.entities.length,
      entitiesB: rosterB.entities.length,
      agreed: agree,
      packetCount: packets.length,
      kindCounts,
    },
  };
}

// ---- (c) 作者の確認の表：層別の選択 -----------------------------------------------

export const FULL_REVIEW_THRESHOLD = 30;
export const RANDOM_ROWS = 10;
/** 層別の行（最大 14）。この順に、乱数の行と重ならない実体から引く。 */
export const STRATA = Object.freeze([
  { group: "alias-top", count: 3 },
  { group: "disagreement", count: 4 },
  { group: "ambiguous-surface", count: 3 },
  { group: "collision", count: 2 },
  { group: "location", count: 2 },
]);

const hashOrder = (seed, work, id) => sha256(`${seed}|${work}|${id}`);

/**
 * 作者の確認の行の選択（§4）。種・作品 key・実体 id の sha256 の昇順で決まり、同じ入力で同じ行。
 * 実体数が 30 以下の作品は全数（group "full"）。それ以外は乱数の行 10（先に）＋層別の行（最大 14）。
 * 層別：別名の多い上位 3／A と B の食い違い 4（entity.packets が空でない）／場面で変わる表記 3／
 * 衝突 2／場所 2。足りなければ少なくなる。
 * 戻り値の rows は表示順（種で混ぜた順）。group と agreement は作者の応答の後まで見せない。
 */
export function selectReviewRows(
  roster,
  { seed, fullThreshold = FULL_REVIEW_THRESHOLD },
) {
  if (typeof seed !== "string" || seed.length === 0)
    throw new TypeError("seed is required");
  const work = roster.work;
  const entities = roster.entities;
  const rank = (list) =>
    [...list].sort((a, b) =>
      hashOrder(seed, work, a.id).localeCompare(hashOrder(seed, work, b.id)),
    );
  const picked = new Map(); // id → group
  if (entities.length <= fullThreshold) {
    for (const e of entities) picked.set(e.id, "full");
  } else {
    for (const e of rank(entities).slice(0, RANDOM_ROWS))
      picked.set(e.id, "random");
    const free = (e) => !picked.has(e.id);
    const collided = new Set(
      findCollisions(roster).flatMap((c) => c.entityIds),
    );
    const pools = {
      "alias-top": [...entities.filter(free)].sort(
        (a, b) =>
          (b.aliases?.length ?? 0) - (a.aliases?.length ?? 0) ||
          hashOrder(seed, work, a.id).localeCompare(
            hashOrder(seed, work, b.id),
          ),
      ),
      disagreement: rank(
        entities.filter((e) => free(e) && (e.packets?.length ?? 0) > 0),
      ),
      "ambiguous-surface": rank(
        entities.filter(
          (e) => free(e) && (e.ambiguousSurfaces?.length ?? 0) > 0,
        ),
      ),
      collision: rank(entities.filter((e) => free(e) && collided.has(e.id))),
      location: rank(entities.filter((e) => free(e) && e.type === "location")),
    };
    for (const { group, count } of STRATA) {
      let taken = 0;
      for (const e of pools[group]) {
        if (taken >= count) break;
        if (picked.has(e.id)) continue;
        picked.set(e.id, group);
        taken++;
      }
    }
  }
  const byId = new Map(entities.map((e) => [e.id, e]));
  // 表示順は、選択の順位とは別の鍵で混ぜる（先頭が乱数の行だと分かってしまわないように）。
  const shuffled = [...picked.keys()]
    .map((id) => byId.get(id))
    .sort((a, b) =>
      sha256(`${seed}|${work}|order|${a.id}`).localeCompare(
        sha256(`${seed}|${work}|order|${b.id}`),
      ),
    );
  const rows = shuffled.map((entity, i) => ({
    rowId: `row-${String(i + 1).padStart(2, "0")}`,
    entityId: entity.id,
    group: picked.get(entity.id),
    agreement: (entity.packets?.length ?? 0) > 0 ? "disagreed" : "agreed",
  }));
  return {
    mode: entities.length <= fullThreshold ? "full" : "sample",
    rows,
    summary: {
      work,
      entityCount: entities.length,
      mode: entities.length <= fullThreshold ? "full" : "sample",
      rowCount: rows.length,
      groupCounts: rows.reduce(
        (acc, r) => ({ ...acc, [r.group]: (acc[r.group] ?? 0) + 1 }),
        {},
      ),
    },
  };
}

// ---- (c) 作者の確認の表：自己完結の HTML ----------------------------------------------

const esc = (text) =>
  String(text).replace(/[&<>"']/gu, (ch) => `&#${ch.charCodeAt(0)};`);

/** 段落（ルビ記法つき）から、表記の前後 radius 字の抜粋を HTML で返す。見つからなければ null。 */
export function excerptHtml(paragraph, surfaces, radius = 40) {
  const segments = paragraphSegments(paragraph);
  const base = segments.map((s) => s.base).join("");
  const chars = [...base];
  // 位置を保つため trim しない（段落の先頭は全角空白のことが多い）。NFC・ASCII 小文字化だけ。
  const fold = (text) =>
    text.normalize("NFC").replace(/[A-Z]/gu, (ch) => ch.toLowerCase());
  const baseKey = fold(base);
  let hit = null;
  for (const surface of surfaces) {
    const key = fold(surface.trim());
    if (!key) continue;
    const at = baseKey.indexOf(key);
    if (at !== -1) {
      const start = [...baseKey.slice(0, at)].length;
      hit = { start, end: start + [...key].length };
      break;
    }
  }
  const from = hit ? Math.max(0, hit.start - radius) : 0;
  const to = hit
    ? Math.min(chars.length, hit.end + radius)
    : Math.min(chars.length, radius * 2);
  // 窓に入る部分だけ、segment を切って並べる（ruby は全体が窓に入るときだけ ruby）。
  const pieces = [];
  let offset = 0;
  for (const seg of segments) {
    const segChars = [...seg.base];
    const s = offset;
    const e = offset + segChars.length;
    offset = e;
    if (e <= from || s >= to) continue;
    if (seg.reading !== null && s >= from && e <= to) {
      pieces.push({ s, e, text: seg.base, reading: seg.reading });
    } else {
      const lo = Math.max(s, from);
      const hi = Math.min(e, to);
      const cuts = [lo];
      if (hit && hit.start > lo && hit.start < hi) cuts.push(hit.start);
      if (hit && hit.end > lo && hit.end < hi) cuts.push(hit.end);
      cuts.push(hi);
      cuts.sort((x, y) => x - y);
      for (let k = 0; k + 1 < cuts.length; k++)
        pieces.push({
          s: cuts[k],
          e: cuts[k + 1],
          text: segChars.slice(cuts[k] - s, cuts[k + 1] - s).join(""),
          reading: null,
        });
    }
  }
  let html = "";
  let open = false;
  for (const piece of pieces) {
    const marked = hit !== null && piece.s < hit.end && piece.e > hit.start;
    if (marked && !open) html += "<mark>";
    if (!marked && open) html += "</mark>";
    open = marked;
    html +=
      piece.reading === null
        ? esc(piece.text)
        : `<ruby>${esc(piece.text)}<rt>${esc(piece.reading)}</rt></ruby>`;
  }
  if (open) html += "</mark>";
  return {
    html: `${from > 0 ? "…" : ""}${html}${to < chars.length ? "…" : ""}`,
    found: hit !== null,
  };
}

const TYPE_LABEL = { character: "人物", location: "場所", other: "その他" };
const MAX_EXCERPTS = 3;

/** <script> に埋め込む JSON（< を \\u003c にして、</script> や <!-- で閉じられないようにする）。 */
function scriptJson(value) {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

/**
 * 作者向けの確認の表（自己完結の HTML。外部の資源を読まない）。表に出すのは、実体の行（名前・型・
 * 別名・敬称付きの形・場面で変わる表記）・根拠の場面と段落の番号・短い抜粋・応答の固定語彙の
 * 選択欄。実体 ID・層・A と B の一致の印・packet は出さない（key file にだけ書く）。
 * 戻り値は文字列。原稿の抜粋を含むので repo 外の 0600 の file にだけ書く。
 */
export function renderReviewHtml({ roster, scenes, rows, sheetId }) {
  if (!(typeof roster.work === "string" && roster.work in WORKS))
    throw new Error("[precheck] UNKNOWN_WORK");
  const byId = new Map(roster.entities.map((e) => [e.id, e]));
  const sceneByIndex = new Map(scenes.map((s) => [s.index, s]));
  const sections = rows.map((row, position) => {
    const entity = byId.get(row.entityId);
    const surfaces = [
      entity.name,
      ...(entity.aliases ?? []).map((a) => a.surface),
    ];
    const evidence = (entity.evidence ?? [])
      .slice(0, MAX_EXCERPTS)
      .map((ev) => {
        const paragraph =
          sceneByIndex.get(ev.scene)?.paragraphs[ev.paragraph - 1] ?? "";
        const ex = excerptHtml(paragraph, surfaces);
        return `<li><span class="loc">場面 ${ev.scene}・段落 ${ev.paragraph}</span> <span class="ex">${ex.html}</span>${
          ex.found
            ? ""
            : ' <span class="warn">（この段落に表記が見つかりません）</span>'
        }</li>`;
      });
    const more = (entity.evidence ?? []).length - MAX_EXCERPTS;
    const list = (title, items) =>
      items.length
        ? `<div><span class="lab">${title}</span> ${items.join("、")}</div>`
        : "";
    const aliasItems = (entity.aliases ?? []).map((a) => esc(a.surface));
    const removeBoxes = (entity.aliases ?? [])
      .map(
        (a, i) =>
          `<label class="chk"><input type="checkbox" name="${row.rowId}-remove" value="${esc(a.surface)}" data-i="${i}"> ${esc(a.surface)}</label>`,
      )
      .join(" ");
    const verdicts = REVIEW_VERDICTS.map(
      (v) =>
        `<label class="opt"><input type="radio" name="${row.rowId}-verdict" value="${esc(v)}"> ${esc(v)}</label>`,
    ).join("");
    return `<section class="row" id="${row.rowId}" data-row="${row.rowId}">
<h2>行 ${position + 1}（全 ${rows.length} 行）</h2>
<div class="entity"><span class="type">${TYPE_LABEL[entity.type] ?? esc(entity.type)}</span> <span class="name">${esc(entity.name)}</span>${
      entity.nameIsRole
        ? ' <span class="note">（役職の呼称を名前にしています）</span>'
        : ""
    }</div>
${list("別名", aliasItems)}
${list("敬称付きの形", (entity.honorificSurfaces ?? []).map(esc))}
${list(
  "場面で指す人が変わる表記",
  (entity.ambiguousSurfaces ?? []).map(
    (a) =>
      `${esc(a.surface)}（この人を指す場面：${a.sceneRanges.map(([f, t]) => (f === t ? `${f}` : `${f}〜${t}`)).join("、")}）`,
  ),
)}
<ul class="evidence">${evidence.join("")}</ul>${more > 0 ? `<div class="note">ほか ${more} 件の根拠があります。</div>` : ""}
<fieldset><legend>この行の判定</legend>${verdicts}</fieldset>
<div class="extra" data-for="名前を直す" hidden><label>正しい名前 <input type="text" name="${row.rowId}-newName"></label></div>
<div class="extra" data-for="別名を足す" hidden><label>足す別名（1 行に 1 つ） <textarea name="${row.rowId}-addAliases" rows="2"></textarea></label>
<label>段 <select name="${row.rowId}-addLevel"><option>L1</option><option selected>L2</option><option>L3</option></select></label></div>
<div class="extra" data-for="別名を外す" hidden><span class="lab">外す別名</span> ${removeBoxes || "（別名がありません）"}</div>
<label class="memo">メモ（任意） <textarea name="${row.rowId}-note" rows="2"></textarea></label>
</section>`;
  });
  const rowIds = rows.map((r) => r.rowId);
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>名簿の確認 ${esc(roster.work)}</title>
<style>
:root{--bg:#fafaf7;--fg:#222;--muted:#666;--line:#d8d6cf;--accent:#1f5f8b;--mark:#fff1a8}
@media (prefers-color-scheme:dark){:root{--bg:#1c1d1f;--fg:#e6e6e6;--muted:#a0a0a0;--line:#3a3c3f;--accent:#7db7e0;--mark:#5a4d10}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:46rem;margin:0 auto;padding:1rem 16px 6rem}
h1{font-size:1.3rem} h2{font-size:1.05rem;margin:0 0 .4rem;color:var(--accent)}
.row{border:1px solid var(--line);border-radius:8px;padding:.8rem 1rem;margin:1rem 0}
.name{font-size:1.2rem;font-weight:bold}.type{border:1px solid var(--line);border-radius:4px;padding:0 .4rem;font-size:.85rem}
.lab{color:var(--muted);font-size:.85rem}.note,.warn{color:var(--muted);font-size:.85rem}.warn{color:#b3261e}
.evidence{padding-left:1.2rem;margin:.5rem 0}.loc{color:var(--muted);font-size:.85rem}
mark{background:var(--mark);color:inherit}
fieldset{border:1px solid var(--line);border-radius:6px;margin:.6rem 0}
.opt{display:inline-block;margin:.15rem .8rem .15rem 0}.chk{display:inline-block;margin-right:.8rem}
textarea,input[type=text]{width:100%;box-sizing:border-box;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px}
.memo{display:block;margin-top:.5rem;font-size:.9rem}
.bar{position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:.6rem 16px;display:flex;gap:1rem;align-items:center;justify-content:center}
button{font:inherit;padding:.4rem 1rem;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--bg)}
</style></head><body><main>
<h1>名簿の確認（${esc(roster.work)}）</h1>
<p>各行の実体（人物・場所など）が、原稿の中でその名前・別名で正しく扱われているかを見てください。抜粋は原稿から取った短い部分です。判定は固定の選択肢から選び、必要なら直しとメモを書いてください。1 回 60 分を目安に、ページを開いたまま回答し、終わったら下の保存ボタンで応答を file に保存してください（ブラウザには下書きを残しません）。</p>
${sections.join("\n")}
</main>
<div class="bar"><span id="progress"></span><button type="button" id="save">応答をファイルに保存</button></div>
<script>
(function(){
var SHEET=${scriptJson(sheetId)},WORK=${scriptJson(roster.work)},ROWS=${scriptJson(rowIds)};
var answeredAt={};
function el(n){return document.getElementsByName(n);}
function verdictOf(r){var v=el(r+"-verdict");for(var i=0;i<v.length;i++)if(v[i].checked)return v[i].value;return null;}
function refresh(){var done=0;ROWS.forEach(function(r){var v=verdictOf(r);if(v)done++;
 var sec=document.getElementById(r);var ex=sec.querySelectorAll(".extra");
 for(var i=0;i<ex.length;i++)ex[i].hidden=ex[i].getAttribute("data-for")!==v;});
 document.getElementById("progress").textContent=done+" / "+ROWS.length+" 行に回答";}
function collect(){var out=[];ROWS.forEach(function(r){var v=verdictOf(r);if(!v)return;
 var rem=[];var c=el(r+"-remove");for(var i=0;i<c.length;i++)if(c[i].checked)rem.push(c[i].value);
 out.push({rowId:r,verdict:v,newName:(el(r+"-newName")[0].value||"").trim(),
  aliasesToAdd:(el(r+"-addAliases")[0].value||"").split("\\n").map(function(x){return x.trim();}).filter(Boolean),
  addLevel:el(r+"-addLevel")[0].value,aliasesToRemove:rem,note:(el(r+"-note")[0].value||"").trim(),answeredAt:answeredAt[r]||null});});
 return {schemaVersion:"identity-review-responses/1",sheetId:SHEET,work:WORK,savedAt:new Date().toISOString(),responses:out};}
document.addEventListener("change",function(e){var n=e.target.name||"";var r=n.split("-").slice(0,2).join("-");
 if(ROWS.indexOf(r)>=0&&!answeredAt[r]&&n===r+"-verdict")answeredAt[r]=new Date().toISOString();refresh();});
document.getElementById("save").addEventListener("click",function(){var blob=new Blob([JSON.stringify(collect(),null,2)],{type:"application/json"});
 var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="review-responses-"+WORK+".json";document.body.appendChild(a);a.click();a.remove();});
refresh();
})();
</script></body></html>
`;
}

/**
 * 表の HTML に、実体 ID・層・A と B の一致の印・packet・系統が出ていないことを検査する
 * （出ていれば Error。値は載せない）。
 */
export function assertSheetHidesMarks(html, { roster, rows }) {
  const hidden = [];
  for (const e of roster.entities) hidden.push(e.id, ...(e.packets ?? []));
  for (const row of rows) hidden.push(row.group, row.agreement);
  hidden.push(
    "disagreed",
    "agreed",
    "adjudicated",
    "lineage",
    "packets",
    "origin",
    "alias-top",
  );
  let leaked = 0;
  for (const token of new Set(hidden))
    if (token && html.includes(token)) leaked++;
  if (leaked > 0)
    throw new Error(`[artifact] SHEET_LEAKS_HIDDEN_MARKS count=${leaked}`);
}

// ---- (d) 作者の応答の取り込みと、名簿の確定 -----------------------------------------------

/** 名簿の誤りを見つけた判定（わからない・そのままは含まない）。 */
const ERROR_VERDICTS = new Set([
  "名前を直す",
  "別名を足す",
  "別名を外す",
  "別人が混ざる",
  "分けるべき",
]);
/** 名簿を自動では直さず、人の手に回す判定。 */
const MANUAL_VERDICTS = new Set(["別人が混ざる", "分けるべき", "わからない"]);

/**
 * 作者の応答を名簿に反映して確定する（凍結前）。確認しなかった行（key に無い実体・応答の無い行）は
 * review.status "unconfirmed"。
 * - そのまま：confirmed
 * - 名前を直す：name を newName に（古い名前は別名にしない。newName が別名にあれば外す）。edited
 * - 別名を足す：aliasesToAdd を addLevel で別名に（敬称付きの形は honorificSurfaces へ）。edited
 * - 別名を外す：aliasesToRemove を別名から外す。edited
 * - 別人が混ざる・分けるべき・わからない：名簿を変えず flagged（人の手で直す）
 * 戻り値：{ roster, summary }。summary は件数だけ（本文・表記は含まない）。
 */
export function ingestReview({ roster, key, responses }) {
  if (responses?.schemaVersion !== "identity-review-responses/1")
    throw new Error("[precheck] RESPONSES_SCHEMA");
  if (responses.work !== roster.work || key.work !== roster.work)
    throw new Error("[precheck] RESPONSES_WORK_MISMATCH");
  const keyByRow = new Map(key.rows.map((r) => [r.rowId, r]));
  const seen = new Set();
  for (const response of responses.responses) {
    if (!keyByRow.has(response.rowId))
      throw new Error("[precheck] RESPONSE_ROW_UNKNOWN");
    if (seen.has(response.rowId))
      throw new Error("[precheck] RESPONSE_ROW_DUPLICATE");
    seen.add(response.rowId);
    if (!REVIEW_VERDICTS.includes(response.verdict))
      throw new Error("[precheck] RESPONSE_VERDICT");
  }
  const next = JSON.parse(JSON.stringify(roster));
  const byId = new Map(next.entities.map((e) => [e.id, e]));
  const stats = {
    verdictCounts: Object.fromEntries(
      REVIEW_VERDICTS.map((v) => [REVIEW_VERDICT_CODES[v], 0]),
    ),
    edits: {
      rename: 0,
      aliasAdded: 0,
      aliasAddedAsHonorific: 0,
      aliasAddSkipped: 0,
      aliasRemoved: 0,
      aliasRemoveMissing: 0,
      renameMissingName: 0,
    },
    flagged: 0,
    unconfirmed: 0,
  };
  const answeredIds = new Set();
  for (const response of responses.responses) {
    const row = keyByRow.get(response.rowId);
    const entity = byId.get(row.entityId);
    answeredIds.add(entity.id);
    stats.verdictCounts[REVIEW_VERDICT_CODES[response.verdict]]++;
    const note =
      typeof response.note === "string" && response.note
        ? { note: response.note }
        : {};
    if (response.verdict === "そのまま") {
      entity.review = {
        status: "confirmed",
        verdict: response.verdict,
        ...note,
      };
      continue;
    }
    if (MANUAL_VERDICTS.has(response.verdict)) {
      entity.review = { status: "flagged", verdict: response.verdict, ...note };
      stats.flagged++;
      continue;
    }
    let edited = false;
    if (response.verdict === "名前を直す") {
      const newName = (response.newName ?? "").trim();
      if (!newName) {
        stats.edits.renameMissingName++;
        entity.review = {
          status: "flagged",
          verdict: response.verdict,
          ...note,
        };
        stats.flagged++;
        continue;
      }
      entity.aliases = (entity.aliases ?? []).filter(
        (a) => candidateKey(a.surface) !== candidateKey(newName),
      );
      entity.name = newName;
      stats.edits.rename++;
      edited = true;
    }
    if (response.verdict === "別名を足す") {
      const level = ALIAS_LEVELS.includes(response.addLevel)
        ? response.addLevel
        : "L2";
      for (const surface of response.aliasesToAdd ?? []) {
        const k = candidateKey(surface);
        const exists =
          k === candidateKey(entity.name) ||
          (entity.aliases ?? []).some((a) => candidateKey(a.surface) === k) ||
          (entity.honorificSurfaces ?? []).some((h) => candidateKey(h) === k);
        if (!surface.trim() || exists) {
          stats.edits.aliasAddSkipped++;
          continue;
        }
        if (isHonorificForm(surface)) {
          entity.honorificSurfaces = [
            ...(entity.honorificSurfaces ?? []),
            surface.trim(),
          ];
          stats.edits.aliasAddedAsHonorific++;
        } else {
          entity.aliases = [
            ...(entity.aliases ?? []),
            { surface: surface.trim(), level },
          ];
          stats.edits.aliasAdded++;
        }
        edited = true;
      }
    }
    if (response.verdict === "別名を外す") {
      for (const surface of response.aliasesToRemove ?? []) {
        const before = (entity.aliases ?? []).length;
        entity.aliases = (entity.aliases ?? []).filter(
          (a) => a.surface !== surface,
        );
        if (entity.aliases.length < before) {
          stats.edits.aliasRemoved++;
          edited = true;
        } else stats.edits.aliasRemoveMissing++;
      }
    }
    entity.review = {
      status: edited ? "edited" : "flagged",
      verdict: response.verdict,
      ...note,
    };
    if (!edited) stats.flagged++;
  }
  for (const entity of next.entities)
    if (!answeredIds.has(entity.id)) {
      entity.review = { status: "unconfirmed" };
      stats.unconfirmed++;
    }
  // 確認した行の結果の要約（層・一致は応答の後なので、ここで初めて出す）。
  const groupOf = new Map(key.rows.map((r) => [r.entityId, r]));
  const tally = (filter) => {
    let n = 0;
    let errors = 0;
    let unknown = 0;
    for (const response of responses.responses) {
      const row = keyByRow.get(response.rowId);
      if (!filter(row)) continue;
      n++;
      if (ERROR_VERDICTS.has(response.verdict)) errors++;
      else if (response.verdict === "わからない") unknown++;
    }
    return { rows: n, errors, unknown };
  };
  const random = tally((r) => r.group === "random");
  const summary = {
    work: roster.work,
    mode: key.mode,
    rowsInSheet: key.rows.length,
    answered: responses.responses.length,
    ...stats,
    random: {
      ...random,
      // 表に出した乱数の行の数と、応答の無い行の数（未回答は分母から落ちるので併記する）。
      keyRows: key.rows.filter((r) => r.group === "random").length,
      unanswered:
        key.rows.filter((r) => r.group === "random").length - random.rows,
      // 応答のあった全行を分母にした上限（わからない行を含むので、強すぎる値になりうる）。
      wilsonUpper95:
        random.rows > 0
          ? Math.round(wilsonUpper(random.errors, random.rows) * 1000) / 1000
          : null,
      // 判定できた行（応答のあった行 − わからない）を分母にした上限（こちらを §4 の主指標に使う）。
      determinateRows: random.rows - random.unknown,
      wilsonUpper95Determinate:
        random.rows - random.unknown > 0
          ? Math.round(
              wilsonUpper(random.errors, random.rows - random.unknown) * 1000,
            ) / 1000
          : null,
      unknownPresent: random.unknown > 0,
    },
    full: tally((r) => r.group === "full"),
    stratified: tally((r) => !["random", "full"].includes(r.group)),
    byAgreement: {
      agreed: tally((r) => r.agreement === "agreed"),
      disagreed: tally((r) => r.agreement === "disagreed"),
    },
    groupOfKnown: groupOf.size,
  };
  next.reviewSummary = summary;
  const validation = validateRoster(next);
  return { roster: next, summary, validation };
}

/** 確認しない作品（m-ja-2）：全行を未確認にして確定する。 */
export function finalizeUnreviewed(roster) {
  const next = JSON.parse(JSON.stringify(roster));
  for (const entity of next.entities) entity.review = { status: "unconfirmed" };
  next.reviewSummary = {
    work: roster.work,
    mode: "unreviewed",
    entityCount: roster.entities.length,
    unconfirmed: roster.entities.length,
  };
  return { roster: next, validation: validateRoster(next) };
}
