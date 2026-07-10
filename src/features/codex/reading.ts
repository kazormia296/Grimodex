/**
 * reading.ts — Codex エントリの「読み(yomi)」正規化・自動導出ユーティリティ。
 *
 * 読みは `readings` 列 (JSON `Record<表記, string[]>`) に保持し、IME 変換辞書注入・
 * ルビ・五十音ソートに転用する汎用データ (docs/Grimodex_IME連携設計書.md §3)。
 * ここは副作用の無い純関数のみ。文字種判定は charClassBoundary.getCharClass を再利用する。
 *
 * 正規化キー (candidateKey / normalizeSurface) は照合用で NFC・別レイヤ。読み正規化は
 * IME 辞書のキー生成が主目的なので NFKC + カタカナ→ひらがなで畳む。両者を統一しない。
 */
import { getCharClass } from "./charClassBoundary";

/** 表記→読みの配列。空表記・空読みは serializeReadings で剪定される。 */
export type ReadingMap = Record<string, string[]>;

/** 印字可能 ASCII のみか (NFKC 済み前提で呼ぶ)。'Mr. X' 等の空白・記号を許す。 */
function isAsciiOnly(s: string): boolean {
  return /^[\x20-\x7e]+$/.test(s);
}

/** ひらがな/カタカナ (長音符ー・中黒・を含む) のみか (NFKC 済み前提で呼ぶ)。 */
function isKanaOnly(s: string): boolean {
  return [...s].every((ch) => {
    const cls = getCharClass(ch);
    return cls === "hiragana" || cls === "katakana";
  });
}

/**
 * 読みをひらがなに正規化する: trim → NFKC → カタカナ→ひらがな。
 * - NFKC が半角カナ→全角カナ・全角英数→半角・濁点合成を畳む。
 * - カタカナ→ひらがなは 0x30a1(ァ)〜0x30f6(ヶ) に **限定** して −0x60。長音符ー(0x30fc)・
 *   中黒・(0x30fb)・ヷヸヹヺ(0x30f7-0x30fa)・ヽヾ(0x30fd-0x30fe) は範囲外＝そのまま残す
 *   (『ラーメン』→『らーめん』が正、長音符を『ー』のまま保つ)。
 */
export function normalizeReading(s: string): string {
  const nfkc = s.trim().normalize("NFKC");
  return nfkc.replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCodePoint(ch.codePointAt(0)! - 0x60),
  );
}

/** 表記が漢字を含むか (自動導出できず AI 推定が要るかの目安)。 */
export function hasKanji(surface: string): boolean {
  return [...surface].some((ch) => getCharClass(ch) === "kanji");
}

/**
 * 文字列が「きれいなひらがな読み」か。ひらがな本体(0x3041-0x3096)・繰返し記号
 * ゝゞ(0x309d-0x309e)・長音符ー(0x30fc)・中黒・(0x30fb) のみを許す。空は false。
 * カタカナ残渣・ローマ字・数字・記号・空白を含む「読み」を弾くための述語。
 */
export function isHiraganaReading(s: string): boolean {
  if (s.length === 0) return false;
  return [...s].every((ch) => {
    const c = ch.codePointAt(0)!;
    return (
      (c >= 0x3041 && c <= 0x3096) ||
      c === 0x309d ||
      c === 0x309e ||
      c === 0x30fc ||
      c === 0x30fb
    );
  });
}

/**
 * 表記から読みを自動導出する (docs §3.2 手順2)。
 * - ASCII のみの表記は正規化してそのまま読みにする。
 * - ひらがな/カタカナのみの表記はカタカナ→ひらがな正規化する。ただし単一
 *   コードポイントの平仮名を持たないカタカナ (ヷヸヹヺ・゠・ヽヾ 等) が残る場合は
 *   機械導出せず null を返し AI 推定に回す (needsAiReading が true になる)。
 * - 漢字・混在表記・空文字は導出せず null。
 */
export function deriveReading(surface: string): string | null {
  const trimmed = surface.trim();
  if (!trimmed) return null;
  const nfkc = trimmed.normalize("NFKC");
  if (isAsciiOnly(nfkc)) return normalizeReading(surface);
  if (isKanaOnly(nfkc)) {
    const derived = normalizeReading(surface);
    return isHiraganaReading(derived) ? derived : null;
  }
  return null;
}

/**
 * その表記が AI 読み推定の対象か。自動導出できない非空表記 (漢字/漢字かな混在等) が対象。
 * deriveReading が null を返す表記 = 機械導出できない = AI に読ませる、で判定を一元化する。
 */
export function needsAiReading(surface: string): boolean {
  return surface.trim().length > 0 && deriveReading(surface) === null;
}

/**
 * エントリの読み対象表記一覧 = [name, ...aliases]。trim・空除去・重複排除 (順序保持)。
 * readings マップのキー集合はこの表記集合に一致させる (reconcileReadingKeys で維持)。
 */
export function surfacesForEntry(
  name: string | null | undefined,
  aliases: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [name ?? "", ...aliases]) {
    const s = raw.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** `readings` 列の生 JSON を安全に ReadingMap へ。破損/非オブジェクトは空。 */
export function parseReadings(
  raw: string[] | string | null | undefined,
): ReadingMap {
  if (!raw || typeof raw !== "string") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  // null-proto アキュムレータ: 表記が "__proto__" 等でも bracket 代入が
  // prototype setter を叩かず own プロパティになる (汚染・読み欠落を防ぐ)。
  const out: ReadingMap = Object.create(null);
  for (const [surface, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!Array.isArray(value)) continue;
    const readings = value.filter(
      (r): r is string => typeof r === "string" && r.trim().length > 0,
    );
    if (readings.length > 0) out[surface] = readings;
  }
  return out;
}

/**
 * ReadingMap を `readings` 列用の JSON へ。各読みを trim、空表記/空読みを剪定、
 * 表記ごとに読みを重複排除。読みが 1 件も無い表記はキーごと落とす (`{"foo":[]}` を残さない)。
 */
export function serializeReadings(map: ReadingMap): string {
  // null-proto: 表記 "__proto__" 等の bracket 代入で prototype を汚さない。
  const clean: ReadingMap = Object.create(null);
  for (const [surfaceRaw, listRaw] of Object.entries(map)) {
    const surface = surfaceRaw.trim();
    if (!surface || !Array.isArray(listRaw)) continue;
    const seen = new Set<string>();
    const list: string[] = [];
    for (const r of listRaw) {
      if (typeof r !== "string") continue;
      const t = r.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      list.push(t);
    }
    if (list.length > 0) clean[surface] = list;
  }
  return JSON.stringify(clean);
}

/**
 * 改名・別名変更で表記集合が変わったとき readings のキーを追随させる (docs §3.1)。
 * - 消えた表記のエントリを剪定 (孤児キー掃除)。
 * - ちょうど 1 表記が消え 1 表記が増えた = 単一リネームとみなし、旧キーの読みを新キーへ移送
 *   (新キーにまだ読みが無い場合のみ)。多重変更は曖昧なので移送せず剪定だけ行う。
 * readings は **エントリ単位** のマップなので他エントリとの表記衝突は起きない (衝突は
 * IME エクスポート時=Phase2 の関心事)。純関数、入力は変更しない。
 */
export function reconcileReadingKeys(
  readings: ReadingMap,
  oldSurfaces: string[],
  newSurfaces: string[],
): ReadingMap {
  const oldSet = new Set(oldSurfaces);
  const newSet = new Set(newSurfaces);
  const next: ReadingMap = {};
  // 存続する表記の読みをそのまま持ち越す。
  for (const s of newSurfaces) {
    if (readings[s] && readings[s].length > 0) next[s] = readings[s];
  }
  // 単一リネーム: 旧→新へ読みを移送 (新キーが空のときだけ)。
  const removed = oldSurfaces.filter((s) => !newSet.has(s));
  const added = newSurfaces.filter((s) => !oldSet.has(s));
  if (
    removed.length === 1 &&
    added.length === 1 &&
    readings[removed[0]]?.length &&
    !next[added[0]]
  ) {
    next[added[0]] = readings[removed[0]];
  }
  return next;
}
