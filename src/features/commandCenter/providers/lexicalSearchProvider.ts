import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type {
  CommandCenterItem,
  CommandCenterProvider,
  CommandCenterSection,
  ItemKind,
  ProviderSearchContext,
} from "./types";

/**
 * FTS5 ベースの全文検索 Provider。
 * - `fts_search` invoke を呼び、Scene/Codex/Snippet の混在結果を 1 セクションに格納
 * - onSelect は既存 `GlobalSearchDialog.openResult` のロジックを移植
 */

const PROVIDER_ID = "lexical";
const PROVIDER_ORDER = 1;

type LexicalSourceType = "scene" | "codex" | "snippet";

interface LexicalSearchResult {
  sourceType: LexicalSourceType;
  id: string;
  title: string;
  excerpt: string;
}

const BADGE_LABELS: Record<LexicalSourceType, string> = {
  scene: "Scene",
  codex: "Codex",
  snippet: "Snippet",
};

function toItemKind(sourceType: LexicalSourceType): ItemKind {
  switch (sourceType) {
    case "scene":
      return "lexical-scene";
    case "codex":
      return "lexical-codex";
    case "snippet":
      return "lexical-snippet";
  }
}

function navigateTo(result: LexicalSearchResult): void {
  // 既存 GlobalSearchDialog.tsx:89-104 の openResult を移植。
  if (result.sourceType === "scene") {
    useTreeStore.getState().setActiveScene(result.id);
    useLayoutStore.getState().showPanel("editor");
  } else if (result.sourceType === "codex") {
    useCodexStore.getState().requestSelectEntry(result.id);
    useLayoutStore.getState().showPanel("codex");
  } else {
    useLayoutStore.getState().showPanel("snippets");
  }
}

function toItem(result: LexicalSearchResult): CommandCenterItem {
  const kind = toItemKind(result.sourceType);
  const fallback = i18next.t("commandCenter.untitled", {
    defaultValue: "(無題)",
  });
  return {
    id: `${kind}:${result.id}`,
    kind,
    title: result.title || fallback,
    subtitle: result.excerpt || undefined,
    badge: { label: BADGE_LABELS[result.sourceType], tone: result.sourceType },
    onSelect: () => navigateTo(result),
  };
}

function sectionTitle(): string {
  return i18next.t("commandCenter.sectionLexical", {
    defaultValue: "字句検索",
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

export const lexicalSearchProvider: CommandCenterProvider = {
  id: PROVIDER_ID,
  order: PROVIDER_ORDER,
  title: "Lexical",
  hideWhenEmpty: true,
  surfaces: ["bar", "panel"],
  supportsMode: (mode) => mode === "search",
  async search(ctx: ProviderSearchContext): Promise<CommandCenterSection> {
    const query = ctx.query.trim();
    if (!query) return emptySection();
    try {
      const results = await invoke<LexicalSearchResult[]>("fts_search", {
        projectId: getCurrentProjectId(),
        query,
        scope: "all",
        limit: ctx.limit,
      });
      if (ctx.signal.aborted) return emptySection();
      return {
        id: PROVIDER_ID,
        title: sectionTitle(),
        order: PROVIDER_ORDER,
        items: results.map(toItem),
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
