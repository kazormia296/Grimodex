import { candidateKey } from "../codexCandidates";

/**
 * 関係の呼び名（続柄・二人称・三人称）の一覧と判定。
 *
 * 呼び名は話し手によって指す人が変わる語（「姉ちゃん」「あなた」「あいつ」）で、
 * 固有の名前として Codex の Entry に結ぶと誤りになりやすい。構造抽出（matcher・新規の人物の提案）と
 * 候補画面（別名ボタン）が同じ一覧を読む。
 *
 * - 置き場はこの 1 か所だけ。コードの定数で、保存しない・作者が足し引きしない。
 * - 判定は語幹との**完全一致**。部分一致は使わない（「姉小路」は呼び名ではない）。
 * - 役職の呼称（先生・隊長）と一人称（私・僕）は入れない。
 * - `candidateKey`（NFC・ASCII 小文字化）は全角・半角・かなの揺れを吸収しないので、
 *   一覧が漢字・平仮名・片仮名の形を持つ。
 */
export type RelationalTermKind = "kinship" | "second-person" | "third-person";

const KINSHIP_STEMS = [
  // 漢字
  "父",
  "母",
  "兄",
  "姉",
  "弟",
  "妹",
  "祖父",
  "祖母",
  "叔父",
  "叔母",
  "伯父",
  "伯母",
  "夫",
  "妻",
  "嫁",
  "息子",
  "娘",
  "孫",
  "旦那",
  "奥",
  "親父",
  "兄貴",
  "姉貴",
  // 平仮名（片仮名は自動で足す）
  "ちち",
  "はは",
  "とう",
  "かあ",
  "あに",
  "あね",
  "にい",
  "にぃ",
  "ねえ",
  "ねぇ",
  "いもうと",
  "おとうと",
  "おじ",
  "おば",
  "じい",
  "ばあ",
  "じじ",
  "ばば",
  "おじい",
  "おばあ",
  "ぱぱ",
  "まま",
  "だんな",
  "おやじ",
  "おふくろ",
  "あにき",
  "あねき",
  "むすこ",
  "むすめ",
] as const;

const SECOND_PERSON_STEMS = [
  "あなた",
  "貴方",
  "貴女",
  "あんた",
  "おまえ",
  "お前",
  "おぬし",
  "貴様",
  "きさま",
  "てめえ",
  "てめぇ",
  "君",
  "きみ",
] as const;

const THIRD_PERSON_STEMS = [
  "彼",
  "彼女",
  "彼氏",
  "かれ",
  "かのじょ",
  "かれし",
  "あいつ",
  "こいつ",
  "そいつ",
  "やつ",
  "奴",
  "あの人",
  "あのひと",
  "あの子",
  "あのこ",
  "あの方",
  "あのかた",
  "この人",
  "このひと",
  "その人",
  "そのひと",
] as const;

/** 接頭。語幹の前に付く丁寧の「お」「ご」「御」。 */
const PREFIXES = ["お", "ご", "御"] as const;

/** 続柄にだけ付く語尾。二人称・三人称は素の形だけ（「きみちゃん」は名前でありうる）。 */
const KINSHIP_SUFFIXES = [
  "さん",
  "さま",
  "様",
  "ちゃん",
  "ちゃま",
  "くん",
  "君",
  "殿",
  "上",
  "貴",
  "たち",
] as const;

/** 二人称・三人称にだけ付く複数の語尾（「彼ら」「あなたたち」）。 */
const PLURAL_SUFFIXES = ["たち", "ら", "達"] as const;

/** 平仮名だけの語を片仮名にする（ぱぱ → パパ）。 */
function toKatakana(value: string): string {
  return value.replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60),
  );
}

function isAllHiragana(value: string): boolean {
  return /^[ぁ-ゖー]+$/.test(value);
}

function buildStemMap(): ReadonlyMap<string, RelationalTermKind> {
  const map = new Map<string, RelationalTermKind>();
  const add = (stems: readonly string[], kind: RelationalTermKind): void => {
    for (const stem of stems) {
      const key = candidateKey(stem);
      map.set(key, kind);
      if (isAllHiragana(stem)) map.set(candidateKey(toKatakana(stem)), kind);
    }
  };
  add(KINSHIP_STEMS, "kinship");
  add(SECOND_PERSON_STEMS, "second-person");
  add(THIRD_PERSON_STEMS, "third-person");
  return map;
}

const STEM_KIND = buildStemMap();

/**
 * 表記が関係の呼び名なら、その kind を返す。そうでなければ null。
 *
 * 「（お／ご／御）＋語幹＋（語尾）」の全組み合わせ（接頭あり・なし × 語尾あり・なし）を試し、
 * 語幹と完全一致するものだけを採る。「おじさん」は「おじ＋さん」で当たる。
 */
export function relationalTermKind(surface: string): RelationalTermKind | null {
  const key = candidateKey(surface);
  if (!key) return null;

  const heads = [key];
  for (const prefix of PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      heads.push(key.slice(prefix.length));
    }
  }

  for (const head of heads) {
    const direct = STEM_KIND.get(head);
    if (direct) return direct;
    for (const suffix of KINSHIP_SUFFIXES) {
      if (head.endsWith(suffix) && head.length > suffix.length) {
        const stem = head.slice(0, -suffix.length);
        if (STEM_KIND.get(stem) === "kinship") return "kinship";
      }
    }
    for (const suffix of PLURAL_SUFFIXES) {
      if (head.endsWith(suffix) && head.length > suffix.length) {
        const kind = STEM_KIND.get(head.slice(0, -suffix.length));
        if (kind === "second-person" || kind === "third-person") return kind;
      }
    }
  }
  return null;
}

export function isRelationalTerm(surface: string): boolean {
  return relationalTermKind(surface) !== null;
}
