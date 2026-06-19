import { loadSceneContent } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  semanticSearch,
  type SemanticSearchHit,
} from "@/features/semantic-search/api";
import {
  buildSemanticRecallQuery,
  fetchSparseSceneIds,
  recallParamsForLang,
  SEMANTIC_RECALL_RESCUE_MARGIN,
} from "@/features/chat/semanticRecall";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  getCurrentProjectId,
  getCurrentProjectLanguage,
} from "@/features/project/projectStore";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  selectRelatedPastScenes,
  type RelatedScene,
} from "./selectRelatedScenes";

/** パネルに表示する関連過去シーンの最大件数。 */
export const RELATED_SCENES_MAX = 8;
/** dense 検索の取得件数。床/集約で間引く前提で広めに取る。 */
export const RELATED_SCENES_FETCH_LIMIT = 30;

/**
 * 現在編集中シーンに意味的に関連する「読書順で前の (既読) シーン」を取得する。
 *
 * クエリ seed = 現在シーン本文の末尾 (chat の semanticRecall と同じ DB 保存値ベース)。
 * 検索は **hybrid** (dense=semanticSearch + sparse=FTS5/bm25)。dense と sparse の順位を
 * RRF 融合し、固有名詞 (人名・地名) のように密ベクトルが過小評価しがちな語彙一致を
 * sparse で補う。床は言語別 gate 値 (recallParamsForLang().gateScore) を per-scene floor
 * として使い団子混入を避ける。読書順フィルタ・集約・件数 cap・融合は
 * selectRelatedPastScenes (純関数) が担う。
 *
 * 失敗 (未 index / feature 無効ビルド / IPC) は全て空配列フォールバック — パネルは
 * 静かに「該当なし」を出す。sparse だけ失敗した場合は dense 単独へグレースフルに退避
 * する (= 従来挙動)。chat の semanticRecall と同じ契約。
 */
export async function fetchRelatedPastScenes(
  sceneId: string,
): Promise<RelatedScene[]> {
  const projectId = getCurrentProjectId();
  if (!projectId || !sceneId) return [];

  const json = await loadSceneContent(sceneId).catch(() => "");
  const body = prosemirrorToText(json ?? "");
  const query = buildSemanticRecallQuery({ userMessage: "", sceneBody: body });
  if (!query.trim()) return [];

  const params = recallParamsForLang(getCurrentProjectLanguage());
  // dense と sparse を並列取得。dense 失敗→空、sparse 失敗→dense 単独へ退避。
  const [hits, sparseSceneIds] = await Promise.all([
    semanticSearch({
      projectId,
      query,
      limit: RELATED_SCENES_FETCH_LIMIT,
    }).catch((e) => {
      debugLog.warn(
        "RelatedScenes",
        "semantic search failed (empty fallback)",
        errorDetail(e),
      );
      return [] as SemanticSearchHit[];
    }),
    fetchSparseSceneIds({ projectId, query }).catch((e) => {
      debugLog.warn(
        "RelatedScenes",
        "sparse search failed (dense-only fallback)",
        errorDetail(e),
      );
      return [] as string[];
    }),
  ]);

  const sceneOrder = computeGlobalSceneOrder(useTreeStore.getState().nodes);
  return selectRelatedPastScenes(hits, {
    currentSceneId: sceneId,
    sceneOrder,
    // per-scene 床 = 言語別 gate。chat 注入の top-1 ゲートは使わず、各シーンが
    // 単独で「明確に関連」のバーを越えるものだけ出す (人間が判断するパネル向け)。
    minScore: params.gateScore,
    maxScenes: RELATED_SCENES_MAX,
    // hybrid: sparse 上位の語彙一致シーンを RRF 融合 + 床ぎりぎり下を救済。
    sparseSceneIds,
    rescueMargin: SEMANTIC_RECALL_RESCUE_MARGIN,
  });
}
