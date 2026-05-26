/**
 * typoPayloadBuilder.ts
 * typo_detection の AI 呼び出し用ペイロードを組み立てる。
 *
 * intra_scene_consistency と同形 (Codex 不要・single scene 入力)。
 * 設計責務: 「形態素単独では Precision が出ない領域 (送り仮名・助詞欠落・
 * 同音異義語・一字脱落)」を LLM に集約する経路 ([[grimodex-typo-detection]])。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { computeInputHash, normalizeText } from "./canonicalize";

export const TYPO_PROMPT_VERSION = "typo_detection_v1.0";

export interface TypoPayloadResult {
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

export async function buildTypoPayload(
  sceneId: string,
  model: string,
): Promise<TypoPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: TYPO_PROMPT_VERSION,
    model,
    effectType: "typo_detection",
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}`,
  });
  return { sceneText, inputHash };
}
