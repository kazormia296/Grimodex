/**
 * impact-review オーケストレーション（手動トリガ）。
 * 現在スナップショット ↔ baseline 差分 → stage-a 候補シーン絞り → impact_review effect 実行
 * → 完了時に baseline を現在へ更新。注釈は post_effect_annotations に入り Kouetsu が表示する。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  runPostEffectMulti,
  type PostEffectRunCallbacks,
} from "@/features/post-effect/api";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import {
  computeInputHash,
  normalizeText,
} from "@/features/post-effect/canonicalize";
import { IMPACT_REVIEW_PROMPT_VERSION } from "@/features/post-effect/consistencyPayloadBuilder";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  computeCodexDiff,
  summarizeChanges,
  computeChangeId,
  type ImpactChange,
} from "./diff";
import { buildCodexSnapshot } from "./snapshot";
import { getBaseline, saveBaseline } from "./baseline";
import { narrowCandidateScenes } from "./narrowing";

/** Rust の process_impact_review_scene が読む per-scene 差分ペイロード（契約固定）。 */
interface ImpactDiffPayload {
  change_id: string;
  entry_id: string;
  entry_name: string;
  entry_type: string;
  change_summary: string;
  changes: ImpactChange[];
}

export type ImpactReviewStatus =
  | "no-change" // baseline と差分なし
  | "no-candidates" // 差分はあるが影響候補シーン 0
  | "started"; // 実行開始（注釈は完了後に Kouetsu へ）

export interface ImpactReviewResult {
  status: ImpactReviewStatus;
  changeCount: number;
  changeSummary: string;
  candidateSceneCount: number;
  runId?: string;
  cleanup?: () => void;
}

const CANDIDATE_LIMIT = 30;

async function getScenePlainText(sceneId: string): Promise<string> {
  const rows = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  if (!rows[0]) return "";
  return prosemirrorToText(rows[0].content ?? "{}");
}

/**
 * エントリの変更影響をレビューする。manual トリガ。
 * callbacks は runPostEffectMulti へ pass-through（onDone は baseline 更新でラップ）。
 */
export async function runImpactReview(
  entryId: string,
  callbacks: PostEffectRunCallbacks = {},
): Promise<ImpactReviewResult> {
  const built = await buildCodexSnapshot(entryId);
  if (!built) {
    return {
      status: "no-change",
      changeCount: 0,
      changeSummary: "",
      candidateSceneCount: 0,
    };
  }
  const { snapshot, projectId, entryType, entryName } = built;

  const baseline = await getBaseline(entryId);
  const changes = computeCodexDiff(baseline, snapshot);
  const changeSummary = summarizeChanges(changes);

  if (changes.length === 0) {
    return {
      status: "no-change",
      changeCount: 0,
      changeSummary: "",
      candidateSceneCount: 0,
    };
  }

  const changeId = computeChangeId(entryId, changes);

  // stage-a: dense クエリ（名前＋旧新値）＋ sparse 言及（名前＋別名）で候補シーン絞り
  const queryText = [entryName, ...changes.flatMap((c) => [c.old, c.new])]
    .filter((s) => s.trim() !== "")
    .join("。");
  const mentionTerms = [entryName, ...snapshot.aliases];
  const candidates = await narrowCandidateScenes(
    projectId,
    queryText,
    mentionTerms,
    { limit: CANDIDATE_LIMIT },
  );

  if (candidates.length === 0) {
    // 差分はあるが影響候補なし → レビュー済みとして baseline を進める
    await saveBaseline(projectId, entryId, snapshot);
    return {
      status: "no-candidates",
      changeCount: changes.length,
      changeSummary,
      candidateSceneCount: 0,
    };
  }

  const diffPayload: ImpactDiffPayload = {
    change_id: changeId,
    entry_id: entryId,
    entry_name: entryName,
    entry_type: entryType,
    change_summary: changeSummary,
    changes,
  };
  const codexPayloadJson = JSON.stringify(diffPayload);

  const scenes: Array<{
    scene_id: string;
    codex_payload_json: string;
    scene_text: string;
  }> = [];
  for (const c of candidates) {
    const sceneText = await getScenePlainText(c.sceneId);
    if (sceneText.trim() === "") continue;
    scenes.push({
      scene_id: c.sceneId,
      codex_payload_json: codexPayloadJson,
      scene_text: sceneText,
    });
  }

  if (scenes.length === 0) {
    await saveBaseline(projectId, entryId, snapshot);
    return {
      status: "no-candidates",
      changeCount: changes.length,
      changeSummary,
      candidateSceneCount: 0,
    };
  }

  const lang = getCurrentProjectLanguage();
  const ov = resolveRoleSendOverride("post_effect_impact_review");
  const model =
    ov.model ?? useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
  const systemPrompt = getPromptCatalog(lang).postEffect.impactReviewSystem;

  const inputHash = await computeInputHash({
    promptVersion: IMPACT_REVIEW_PROMPT_VERSION,
    model,
    effectType: "impact_review",
    codex: diffPayload,
    scene: scenes.map((s) => normalizeText(s.scene_text)).join("|"),
    scope: `impact:${entryId}:${changeId}`,
  });

  const { runId, cleanup } = await runPostEffectMulti(
    {
      project_id: projectId,
      effect_type: "impact_review",
      scope_type: "project",
      scope_target_id: null,
      model,
      model_override: ov.model,
      provider_override: ov.provider,
      api_variant_override: ov.apiVariant,
      endpoint_id_override: ov.endpointId,
      prompt_version: IMPACT_REVIEW_PROMPT_VERSION,
      input_hash: inputHash,
      scenes,
      system_prompt: systemPrompt,
    },
    {
      ...callbacks,
      onDone: async (e) => {
        // レビュー完了 → baseline を現在状態へ進める（次回は今回以降の差分を見る）
        try {
          await saveBaseline(projectId, entryId, snapshot);
        } catch {
          /* baseline 更新失敗は致命ではない */
        }
        await callbacks.onDone?.(e);
      },
    },
  );

  return {
    status: "started",
    changeCount: changes.length,
    changeSummary,
    candidateSceneCount: scenes.length,
    runId,
    cleanup,
  };
}
