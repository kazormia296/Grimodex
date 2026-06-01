/**
 * reviewPayloadBuilder.ts
 * review (編集者視点の診断レポート) の AI 呼び出し用ペイロードを組み立てる。
 *
 * typoPayloadBuilder / intra_scene_consistency と同形 (Codex 不要・single scene 入力)。
 * 本文スコープは対象シーン 1 件の全文のみ (チャンク分割・前後文脈の付与はしない)。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { computeInputHash, normalizeText } from "./canonicalize";

export const REVIEW_PROMPT_VERSION = "review_v1.0";

export interface ReviewPayloadResult {
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

export async function buildReviewPayload(
  sceneId: string,
  model: string,
): Promise<ReviewPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: REVIEW_PROMPT_VERSION,
    model,
    effectType: "review",
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}`,
  });
  return { sceneText, inputHash };
}
