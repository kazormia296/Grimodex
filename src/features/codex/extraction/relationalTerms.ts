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
  "旦那",
  "親父",
  "兄貴",
  "姉貴",
  "兄者",
  "姉者",
  "お袋",
  "奥さん",
  "奥さま",
  "奥様",
  // 平仮名
  "ちち",
  "はは",
  "あに",
  "あね",
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
  "だんな",
  "おやじ",
  "おふくろ",
  "あにき",
  "あねき",
  "むすこ",
  "むすめ",
  "ちちうえ",
  "ははうえ",
  "おっかさん",
  "おっかあ",
  // 片仮名の呼び名（平仮名からは自動で作らない：「トウ」「ジジ」などの名前を巻き込むため）
  "パパ",
  "ママ",
  "ダンナ",
  "オヤジ",
] as const;

/**
 * 語尾（さん・ちゃん・様 など）が付いたときだけ続柄になる語幹。
 * 語尾なしの「とう」「にい」「ねえ」は続柄の語として確かでないので当てない。
 */
const KINSHIP_SUFFIX_ONLY_STEMS = [
  "とう",
  "かあ",
  "にい",
  "にぃ",
  "ねえ",
  "ねぇ",
  "にー",
  "ねー",
] as const;

/** 語尾が必須の語幹に付けてよい語尾（丁寧・親愛の語尾だけ）。 */
const SUFFIX_ONLY_SUFFIXES = [
  "さん",
  "さま",
  "様",
  "ちゃん",
  "ちゃま",
] as const;

const SECOND_PERSON_STEMS = [
  "あなた",
  "貴方",
  "貴女",
  "あなた様",
  "あなたさま",
  "あんた",
  "おまえ",
  "お前",
  "おぬし",
  "貴様",
  "きさま",
  "てめえ",
  "てめぇ",
  // 「君」「きみ」は名前にもなるが、二人称としての頻度が高く、作者の確認（設計 Q2）で
  // 二人称を入れると決めている。名簿（名前・別名）に結んだ語はここで落とさず、落とした語は
  // 抽出の診断に表記が残るので許容する。片仮名の「キミ」は名前と衝突しやすいので入れない。
  "君",
  "きみ",
  "アンタ",
  "オマエ",
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
  "カレ",
  "カノジョ",
  "アイツ",
  "コイツ",
  "ソイツ",
  "ヤツ",
] as const;

/**
 * 接頭。語幹の前に付く丁寧の「お」「ご」「御」。続柄の語幹にだけ効かせる
 * （「お君」「おきみ」「おやつ」「お彼」のような名前・普通名詞を呼び名にしない）。
 * 二人称・三人称の「お前」「おまえ」「おぬし」は、接頭付きの形を語幹の一覧に持つ。
 */
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
const PLURAL_SUFFIXES = ["たち", "ら", "達", "等"] as const;

interface StemInfo {
  readonly kind: RelationalTermKind;
  /** true: 語尾が付いたときだけ呼び名。 */
  readonly suffixOnly: boolean;
}

function buildStemMap(): ReadonlyMap<string, StemInfo> {
  const map = new Map<string, StemInfo>();
  const add = (
    stems: readonly string[],
    kind: RelationalTermKind,
    suffixOnly = false,
  ): void => {
    for (const stem of stems) map.set(candidateKey(stem), { kind, suffixOnly });
  };
  add(KINSHIP_STEMS, "kinship");
  add(KINSHIP_SUFFIX_ONLY_STEMS, "kinship", true);
  add(SECOND_PERSON_STEMS, "second-person");
  add(THIRD_PERSON_STEMS, "third-person");
  return map;
}

const STEM_INFO = buildStemMap();

/**
 * 表記が関係の呼び名なら、その kind を返す。そうでなければ null。
 *
 * 「（お／ご／御）＋語幹＋（語尾）」の組み合わせ（接頭あり・なし × 語尾あり・なし。接頭は続柄の語幹だけ）を試し、
 * 語幹と完全一致するものだけを採る。「おじさん」は「おじ＋さん」で当たる。
 */
export function relationalTermKind(surface: string): RelationalTermKind | null {
  const key = candidateKey(surface);
  if (!key) return null;

  // 接頭を取った形は続柄にだけ当てる。接頭なしの形は全 kind を試す。
  const heads: { head: string; prefixed: boolean }[] = [
    { head: key, prefixed: false },
  ];
  for (const prefix of PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      heads.push({ head: key.slice(prefix.length), prefixed: true });
    }
  }

  for (const { head, prefixed } of heads) {
    const direct = STEM_INFO.get(head);
    if (
      direct &&
      !direct.suffixOnly &&
      (!prefixed || direct.kind === "kinship")
    ) {
      return direct.kind;
    }
    for (const suffix of KINSHIP_SUFFIXES) {
      if (head.endsWith(suffix) && head.length > suffix.length) {
        const info = STEM_INFO.get(head.slice(0, -suffix.length));
        if (info?.kind !== "kinship") continue;
        if (
          info.suffixOnly &&
          !(SUFFIX_ONLY_SUFFIXES as readonly string[]).includes(suffix)
        ) {
          continue;
        }
        return "kinship";
      }
    }
    if (prefixed) continue;
    for (const suffix of PLURAL_SUFFIXES) {
      if (head.endsWith(suffix) && head.length > suffix.length) {
        const info = STEM_INFO.get(head.slice(0, -suffix.length));
        if (
          !info?.suffixOnly &&
          (info?.kind === "second-person" || info?.kind === "third-person")
        ) {
          return info.kind;
        }
      }
    }
  }
  return null;
}

export function isRelationalTerm(surface: string): boolean {
  return relationalTermKind(surface) !== null;
}
