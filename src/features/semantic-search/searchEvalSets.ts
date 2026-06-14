/**
 * セマンティック検索評価ハーネス用のクエリ集（dev 専用）。
 *
 * シーンタイトルは scripts/seed-sample-{en,ja}.py のサンプルと一致させること
 * （タイトルは安定キー。scene id は seed ごとに変わるため使えない）。
 * relevant は default / medium 双方に存在する手書き＋bonus シーンのみを対象にし、
 * bulk(--scale medium) は distractor として効かせる。
 */

import type { EvalSet } from "./searchEval";

/** 英語サンプル「The Iron Crown」(scripts/seed-sample-en.py) 用。 */
export const EN_EVAL_SET: EvalSet = {
  language: "en",
  label: "iron-crown",
  relevant: [
    {
      query:
        "returning to the burned family hall and finding the compass on the hearthstone",
      expect: ["Chapter One: The Hall"],
    },
    {
      query: "a memory that was not her own flooded in when she touched it",
      expect: ["Chapter One: The Hall"],
    },
    {
      query: "the lock had fallen off the keeping-room door",
      // setup in Ch.One, payoff in the interlude — either is a fair top hit.
      expect: ["Chapter One: The Hall", "Interlude: The Hearthstone"],
    },
    {
      query:
        "a sealed letter telling her to come back, with a final line she cannot read",
      expect: ["Chapter Two: The Writ"],
    },
    {
      query: "Wrenna arrives and holds out a wrapped parcel",
      expect: ["Chapter Two: The Writ"],
    },
    {
      query: "the night the great house caught fire and she ran",
      expect: ["Memory: The Night of the Fire"],
    },
    {
      query: "someone shouted a warning to get back that she cannot place",
      expect: ["Memory: The Night of the Fire"],
    },
    {
      query:
        "under the moon she finds a token of faded vermilion by the hearth",
      expect: ["Interlude: The Hearthstone"],
    },
    {
      query: "someone has secretly been visiting the ruin ever since the fire",
      expect: ["Interlude: The Hearthstone"],
    },
    {
      query: "he already knew she had travelled to Greymoor",
      expect: ["Chapter Three: Ironhaven by Night"],
    },
    {
      query: "where the compass came from and how it was bound to her blood",
      expect: ["Bonus: The Origin of the Compass (complete)"],
    },
    {
      query: "the sealed vault beneath the Citadel needs three keyholders",
      expect: ["Bonus: Beneath the Citadel (revision)"],
    },
    {
      query:
        "the litany of the bound names her mother spoke as the house burned",
      expect: ["Bonus: The Litany of the Burning Night (final)"],
    },
  ],
  junk: [
    "a recipe for sourdough bread",
    "quarterly tax accounting spreadsheet",
    "rules of association football",
    "how to change a flat car tyre",
    "today's stock market closing prices",
    "a beginner tutorial on watercolour painting",
  ],
};

/** 日本語サンプル「朱の記憶」(scripts/seed-sample-ja.py) 用。 */
export const JA_EVAL_SET: EvalSet = {
  language: "ja",
  label: "朱の記憶",
  relevant: [
    {
      query: "十年ぶりに廃社へ戻り祭壇の朱紐に触れる",
      expect: ["一章：廃社"],
    },
    {
      query: "朱紐に触れた瞬間に流れ込んでくる他人の記憶",
      expect: ["一章：廃社"],
    },
    {
      query: "拝殿の錠前が錠前ごと落ちていた",
      expect: ["一章：廃社", "間章：祭壇の傷"],
    },
    {
      query: "「帰れ」と書かれ最後の一行が読めない封じ文",
      expect: ["二章：封じ文"],
    },
    {
      query: "音羽が来て饅頭を差し出す",
      expect: ["二章：封じ文"],
    },
    {
      query: "十年前の夏の夜に社が燃えた",
      expect: ["回想：十年前の夜"],
    },
    {
      query: "誰の声か思い出せない叫び声",
      expect: ["回想：十年前の夜"],
    },
    {
      query: "月夜の拝殿で祭壇の札の残骸を見つける",
      expect: ["間章：祭壇の傷"],
    },
    {
      query: "都に戻った朱音のもとに陰陽師の冬弥が現れる",
      expect: ["三章：都の夜"],
    },
    {
      query: "朱紐の起源と北ではなく血を指す紐",
      expect: ["番外：朱紐の起源（complete）"],
    },
    {
      query: "陰陽寮の地下の封書庫と三人の鍵持ち",
      expect: ["番外：陰陽寮の地下（revision）"],
    },
    {
      query: "母が燃える夜に唱えた封じた者の名の祝詞",
      expect: ["番外：燃えた夜の祝詞（final）"],
    },
  ],
  junk: [
    "パンの焼き方のレシピ",
    "四半期の税務会計の表計算",
    "サッカーの試合のルール",
    "車のタイヤ交換の手順",
    "今日の株式市場の終値",
    "水彩画の初心者向けチュートリアル",
  ],
};
