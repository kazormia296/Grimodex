/**
 * pseudoCommentPayloadBuilder.ts
 * pseudo_comment (読者ペルソナによる本文横コメント) のペイロードを組み立てる。
 *
 * scene 本文のみ (Codex 不要)。persona を input_hash に含めるため、同じシーンでも
 * persona が違えば別 run / 別キャッシュになる。
 *
 * v2.0: ペルソナは bare label ではなく「読者スタンス」の brief を持つ。genre は
 * 全ペルソナ共通の風味として、想定読者プロフィール (projects.targetReaders) は
 * 「ターゲット読者層」ペルソナの実体として brief に注入される。brief は genre /
 * プロフィールに依存するため input_hash にも畳み込む (設定変更でキャッシュが
 * 古くならないように)。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { computeInputHash, normalizeText } from "./canonicalize";
import { kouetsuScopeSuffix } from "./customInstruction";

export const PSEUDO_COMMENT_PROMPT_VERSION = "pseudo_comment_v2.1";

/** brief 解決に必要なプロジェクト文脈。 */
export interface PersonaBriefContext {
  /** projects.genre (英語 enum or null)。全ペルソナ共通の風味。 */
  genre?: string | null;
  /** projects.targetReaders (想定読者プロフィール)。ターゲット読者層の実体。 */
  targetReaders?: string | null;
}

/** 読者ペルソナの定義。label は UI 表示 & DB 保存 (annotation.persona) の安定キー。 */
export interface PseudoPersonaDef {
  label: string;
  /** 想定読者プロフィール必須か。true かつ profile 空のとき UI で選択不可。 */
  requiresTargetProfile?: boolean;
  /** genre / targetReaders を織り込んだ brief を返す。 */
  brief: (ctx: PersonaBriefContext) => string;
}

/** genre をプロンプト文に織り込む短句。未設定なら作品一般に丸める。 */
function genrePhrase(genre?: string | null): string {
  const g = genre?.trim();
  return g ? `「${g}」というジャンル` : "この作品";
}

/** English counterpart of genrePhrase. */
function genrePhraseEn(genre?: string | null): string {
  const g = genre?.trim();
  return g ? `the "${g}" genre` : "this work";
}

/**
 * 読者ペルソナ・レジストリ (読者スタンスに統一)。
 * 編集者は「作り手」視点でレビュー (reviewSystem) と重複・自己矛盾するため持たない。
 */
export const PSEUDO_PERSONA_DEFS: readonly PseudoPersonaDef[] = [
  {
    label: "一般読者",
    brief: ({ genre }) =>
      `${genrePhrase(genre)}を普通に読む、平均的な読者になりきってください。` +
      `専門知識や前提は薄く、難しければ素直に「分からない」、面白ければ素直に乗ります。` +
      `話についていけるか・続きが気になるかを率直に反応してください。`,
  },
  {
    label: "コア読者",
    brief: ({ genre }) =>
      `${genrePhrase(genre)}を数多く読み込んできた、目の肥えた読者になりきってください。` +
      `お約束・テンプレ・既視感に敏感で、ジャンルの「型」やお決まりの見せ場への期待値が高い。` +
      `新鮮さや、約束された盛り上がりが満たされているかに反応してください。`,
  },
  {
    label: "ライト/新規読者",
    brief: ({ genre }) =>
      `${genrePhrase(genre)}に不慣れ、あるいは軽い気持ちで読み始めた新規読者になりきってください。` +
      `情報量の多さ・専門用語・固有名詞の洪水で離脱しやすく、` +
      `とっつきにくさやつまずきポイントを率直に反応してください。`,
  },
  {
    label: "辛口の批評家",
    brief: () =>
      `文学的な水準で評価的に読む、辛口の批評家になりきってください。` +
      `安易な感動・ご都合主義・描写の弱さ・論理の穴を見つけにいきます。` +
      `簡単には感心せず、物足りない点を遠慮なく指摘してください。`,
  },
  {
    label: "ターゲット読者層",
    requiresTargetProfile: true,
    brief: ({ targetReaders }) => {
      const profile = targetReaders?.trim();
      if (!profile) {
        // UI で選択不可のため通常は到達しない。防御的に一般読者へ縮退。
        return (
          `この作品が想定する読者層になりきってください。` +
          `刺さるか・物足りないかを、その立場から率直に反応してください。`
        );
      }
      return (
        `この作品が想定する読者層になりきってください。想定読者の人物像は次の通りです:\n` +
        `${profile}\n\n` +
        `その読者にとって刺さるか・物足りないか・期待とズレていないかを、` +
        `その立場から率直に反応してください。`
      );
    },
  },
] as const;

/**
 * 英語ペルソナ・レジストリ。label は英語で、ja とは別の安定キー集合にする
 * (既存 ja プロジェクトの annotation.persona キーを温存しつつ、en プロジェクトは
 * 英語キーで新規開始する)。brief も英語で書き下す。
 */
export const PSEUDO_PERSONA_DEFS_EN: readonly PseudoPersonaDef[] = [
  {
    label: "General Reader",
    brief: ({ genre }) =>
      `Become an average reader of ${genrePhraseEn(genre)} reading at a normal pace. ` +
      `You have little specialist knowledge or prior context: if something is hard you simply say "I don't get it," and if it's fun you go along with it. ` +
      `React honestly to whether you can follow the story and whether you want to read on.`,
  },
  {
    label: "Core Reader",
    brief: ({ genre }) =>
      `Become a seasoned, discerning reader who has read a great deal of ${genrePhraseEn(genre)}. ` +
      `You are sensitive to conventions, tropes, and déjà vu, with high expectations for the genre's signature beats and set pieces. ` +
      `React to whether the scene feels fresh and whether its promised payoffs land.`,
  },
  {
    label: "Light/New Reader",
    brief: ({ genre }) =>
      `Become a newcomer who is unfamiliar with ${genrePhraseEn(genre)}, or who started reading on a whim. ` +
      `You drop off easily when overwhelmed by information density, jargon, or a flood of proper nouns. ` +
      `React honestly to anything that feels hard to get into or that trips you up.`,
  },
  {
    label: "Harsh Critic",
    brief: () =>
      `Become a harsh critic who reads evaluatively at a literary standard. ` +
      `You go looking for cheap sentiment, contrivance, weak description, and holes in the logic. ` +
      `You are not easily impressed; point out what falls short without holding back.`,
  },
  {
    label: "Target Audience",
    requiresTargetProfile: true,
    brief: ({ targetReaders }) => {
      const profile = targetReaders?.trim();
      if (!profile) {
        // Normally unreachable (disabled in the UI). Defensive fallback.
        return (
          `Become the reader this work is aimed at. ` +
          `React honestly, from that standpoint, to whether it lands or falls short.`
        );
      }
      return (
        `Become the reader this work is aimed at. The intended reader profile is:\n` +
        `${profile}\n\n` +
        `From that standpoint, react honestly to whether it lands, falls short, or misses the reader's expectations.`
      );
    },
  },
] as const;

/** project 言語に対応するペルソナ定義集合を返す (en 以外は ja)。 */
export function personaDefsForLang(
  lang?: string | null,
): readonly PseudoPersonaDef[] {
  return lang?.startsWith("en") ? PSEUDO_PERSONA_DEFS_EN : PSEUDO_PERSONA_DEFS;
}

/** project 言語に対応するペルソナ label 一覧 (UI のデフォルト/ドロップダウン用)。 */
export function personasForLang(lang?: string | null): string[] {
  return personaDefsForLang(lang).map((d) => d.label);
}

/** 既定の読者ペルソナ一覧 (ja label のみ。UI / 後方互換用)。 */
export const PSEUDO_PERSONAS = PSEUDO_PERSONA_DEFS.map((d) => d.label);

export type PseudoPersona = (typeof PSEUDO_PERSONAS)[number];

/** persona がプロフィール必須か (UI の disable 判定用)。lang で集合を切替。 */
export function personaRequiresTargetProfile(
  persona: string,
  lang?: string | null,
): boolean {
  return (
    personaDefsForLang(lang).find((d) => d.label === persona)
      ?.requiresTargetProfile ?? false
  );
}

/**
 * persona ラベルと文脈から、プロンプトへ注入する brief を解決する。
 * 未知 persona (旧データの再実行・手入力) はラベルだけ注入する後方互換経路。
 * lang で参照するペルソナ集合を切替える (ja/en)。
 */
export function resolvePersonaBrief(
  persona: string,
  ctx: PersonaBriefContext,
  lang?: string | null,
): string {
  const def = personaDefsForLang(lang).find((d) => d.label === persona);
  if (!def) {
    return lang?.startsWith("en")
      ? `Become "${persona}" and leave reader comments.`
      : `「${persona}」になりきってコメントしてください。`;
  }
  return def.brief(ctx);
}

export interface PseudoCommentPayloadResult {
  sceneText: string;
  inputHash: string;
}

async function getScenePlainText(sceneId: string): Promise<string> {
  const rows = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  if (!rows[0]) return "";
  return prosemirrorToText(rows[0].content ?? "{}");
}

export async function buildPseudoCommentPayload(
  sceneId: string,
  model: string,
  persona: string,
  brief: string,
  customInstruction: string = "",
): Promise<PseudoCommentPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: PSEUDO_COMMENT_PROMPT_VERSION,
    model,
    effectType: "pseudo_comment",
    scene: normalizeText(sceneText),
    // brief は genre / 想定読者プロフィールに依存するので scope に畳み込む。
    // これらが変われば別キャッシュになる (設定編集後に古い結果を返さない)。
    // custom (aiPrompt.custom.kouetsu) も同様に非空時のみ畳み込む。
    scope: `scene:${sceneId}|persona:${persona}|brief:${normalizeText(brief)}${kouetsuScopeSuffix(customInstruction)}`,
  });
  return { sceneText, inputHash };
}

/** brief を埋め込んだ system prompt を組み立てる。 */
export function buildPseudoCommentSystemPrompt(
  basePrompt: string,
  brief: string,
): string {
  return `${basePrompt}\n\nREADER PERSONA: ${brief}`;
}
