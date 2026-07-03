import i18next from "i18next";
import {
  semanticSearch,
  type SemanticSearchHit,
} from "@/features/semantic-search/api";
import { requestSceneChunkJump } from "@/features/semantic-search/sceneChunkJump";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type {
  CommandCenterItem,
  CommandCenterProvider,
  CommandCenterSection,
  ProviderSearchContext,
} from "./types";

/**
 * 本文セマンティック検索 Provider。
 * - `semanticSearch` を呼んで chunk ヒットを取得
 * - `descriptionMode` は `commandCenterStore` から読む (FilterBar で切替可)
 * - onSelect は **requestJump → setActiveScene → showPanel** の順を守る
 *   (EditorPane の switchScene 経路が同一 microtask で consumeJump するため)。
 *   順序契約は `requestSceneChunkJump` に集約 (関連シーンパネルと共有)。
 */

const PROVIDER_ID = "semantic";
const PROVIDER_ORDER = 2;
/** embedding 計算回避: 1 文字での検索は無意味なので skip */
const MIN_QUERY_LENGTH = 2;

function navigateTo(hit: SemanticSearchHit): void {
  requestSceneChunkJump(hit.sceneId, hit.chunkText);
}

function toItem(hit: SemanticSearchHit): CommandCenterItem {
  const fallback = i18next.t("commandCenter.untitled", {
    defaultValue: "(無題)",
  });
  return {
    id: `semantic-chunk:${hit.sceneId}:${hit.charStart}:${hit.charEnd}`,
    kind: "semantic-chunk",
    title: hit.sceneTitle || fallback,
    subtitle: hit.chunkText,
    badge: { label: hit.score.toFixed(2), tone: "score" },
    onSelect: () => navigateTo(hit),
  };
}

function sectionTitle(): string {
  return i18next.t("commandCenter.sectionSemantic", {
    defaultValue: "意味検索",
  });
}

function emptySection(
  extra?: Partial<CommandCenterSection>,
): CommandCenterSection {
  return {
    id: PROVIDER_ID,
    title: sectionTitle(),
    order: PROVIDER_ORDER,
    items: [],
    ...extra,
  };
}

export const semanticSearchProvider: CommandCenterProvider = {
  id: PROVIDER_ID,
  order: PROVIDER_ORDER,
  title: "Semantic",
  hideWhenEmpty: true,
  surfaces: ["bar", "panel"],
  supportsMode: (mode) => mode === "search",
  cacheKeyExtras: (extras) => `desc=${extras.descriptionMode ? "1" : "0"}`,
  async search(ctx: ProviderSearchContext): Promise<CommandCenterSection> {
    const query = ctx.query.trim();
    if (query.length < MIN_QUERY_LENGTH) return emptySection();
    try {
      const hits = await semanticSearch({
        projectId: getCurrentProjectId(),
        query,
        limit: ctx.limit,
        descriptionMode: ctx.descriptionMode,
      });
      if (ctx.signal.aborted) return emptySection();
      return {
        id: PROVIDER_ID,
        title: sectionTitle(),
        order: PROVIDER_ORDER,
        items: hits.map(toItem),
      };
    } catch (e) {
      if (ctx.signal.aborted) return emptySection();
      // 埋め込みモデル未インストール (オンデマンド DL 中/失敗) は「壊れた」ではなく
      // degrade。error バナーを出さず無音で空にする (lexical/FTS section は別 provider
      // で並行表示され続ける)。DL 完了後は再検索で dense も乗る。
      const message = e instanceof Error ? e.message : String(e);
      if (/not installed/i.test(message)) return emptySection();
      return emptySection({
        state: { kind: "error", message },
      });
    }
  },
};
