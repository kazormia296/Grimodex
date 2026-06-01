/**
 * pseudoCommentPayloadBuilder.ts
 * pseudo_comment (読者ペルソナによる本文横コメント) のペイロードを組み立てる。
 *
 * scene 本文のみ (Codex 不要)。persona を input_hash に含めるため、同じシーンでも
 * persona が違えば別 run / 別キャッシュになる。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { computeInputHash, normalizeText } from "./canonicalize";

export const PSEUDO_COMMENT_PROMPT_VERSION = "pseudo_comment_v1.0";

/** 既定の読者ペルソナ一覧 (将来カスタム追加の余地を残す)。 */
export const PSEUDO_PERSONAS = [
  "一般読者",
  "批評家",
  "編集者",
  "ターゲット層",
] as const;

export type PseudoPersona = (typeof PSEUDO_PERSONAS)[number];

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
): Promise<PseudoCommentPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: PSEUDO_COMMENT_PROMPT_VERSION,
    model,
    effectType: "pseudo_comment",
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}|persona:${persona}`,
  });
  return { sceneText, inputHash };
}

/** persona を埋め込んだ system prompt を組み立てる。 */
export function buildPseudoCommentSystemPrompt(
  basePrompt: string,
  persona: string,
): string {
  return `${basePrompt}\n\nREADER PERSONA: 「${persona}」になりきってコメントしてください。`;
}
