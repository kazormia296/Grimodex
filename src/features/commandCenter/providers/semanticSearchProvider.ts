import i18next from "i18next";
import {
  semanticSearch,
  type SemanticSearchHit,
} from "@/features/semantic-search/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useSemanticNavStore } from "@/features/semantic-search/semanticNavStore";
import { useCommandCenterStore } from "../store/commandCenterStore";
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
 *   (EditorPane の switchScene 経路が同一 microtask で consumeJump するため)
 */

const PROVIDER_ID = "semantic";
const PROVIDER_ORDER = 2;
/** embedding 計算回避: 1 文字での検索は無意味なので skip */
const MIN_QUERY_LENGTH = 2;

function navigateTo(hit: SemanticSearchHit): void {
  // 重要: requestJump を setActiveScene の前に。順序は不変条件。
  useSemanticNavStore.getState().requestJump({
    sceneId: hit.sceneId,
    chunkText: hit.chunkText,
  });
  useTreeStore.getState().setActiveScene(hit.sceneId);
  useLayoutStore.getState().showPanel("editor");
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
  supportsMode: (mode) => mode === "search",
  cacheKeyExtras: () => {
    const desc = useCommandCenterStore.getState().descriptionMode;
    return `desc=${desc ? "1" : "0"}`;
  },
  async search(ctx: ProviderSearchContext): Promise<CommandCenterSection> {
    const query = ctx.query.trim();
    if (query.length < MIN_QUERY_LENGTH) return emptySection();
    const descriptionMode = useCommandCenterStore.getState().descriptionMode;
    try {
      const hits = await semanticSearch({
        projectId: getCurrentProjectId(),
        query,
        limit: ctx.limit,
        descriptionMode,
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
      return emptySection({
        state: {
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  },
};
