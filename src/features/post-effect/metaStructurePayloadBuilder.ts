/**
 * metaStructurePayloadBuilder.ts
 * meta_structure (プロット構造・ペーシングの俯瞰診断) のペイロードを組み立てる。
 *
 * scene 本文のみ (Codex 不要)。結果は annotation ではなく scene_lens_data に入る。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { computeInputHash, normalizeText } from "./canonicalize";
import { kouetsuScopeSuffix } from "./customInstruction";

export const META_STRUCTURE_PROMPT_VERSION = "meta_structure_v1.0";

export interface MetaStructurePayloadResult {
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

export async function buildMetaStructurePayload(
  sceneId: string,
  model: string,
  customInstruction: string = "",
): Promise<MetaStructurePayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: META_STRUCTURE_PROMPT_VERSION,
    model,
    effectType: "meta_structure",
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}${kouetsuScopeSuffix(customInstruction)}`,
  });
  return { sceneText, inputHash };
}
