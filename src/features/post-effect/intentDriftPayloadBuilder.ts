/**
 * intentDriftPayloadBuilder.ts
 * intent_drift (作者宣言の狙い vs 本文のズレ指摘) の AI 呼び出し用ペイロード。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { computeInputHash, normalizeText } from "./canonicalize";
import { intentScopeSuffix, kouetsuScopeSuffix } from "./customInstruction";

export const INTENT_DRIFT_PROMPT_VERSION = "intent_drift_v1.0";

export interface IntentDriftPayloadResult {
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

export async function buildIntentDriftPayload(
  sceneId: string,
  model: string,
  intent: string,
  customInstruction: string = "",
): Promise<IntentDriftPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: INTENT_DRIFT_PROMPT_VERSION,
    model,
    effectType: "intent_drift",
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}${kouetsuScopeSuffix(customInstruction)}${intentScopeSuffix(intent)}`,
  });
  return { sceneText, inputHash };
}
