import i18next from "i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { requestOpenInCodex } from "@/features/codex/multiwindow/codexSelectionRouting";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import type {
  CommandCenterItem,
  CommandCenterProvider,
  CommandCenterSection,
  ProviderSearchContext,
} from "./types";

/**
 * バー用 Quick Open Provider。
 * VSCode の Ctrl+P 相当。Scene/Codex/Snippet の **名前** を in-memory で
 * 部分一致検索してジャンプする。全文検索は panel 側 (lexical/semantic) が担う。
 */

const PROVIDER_ID = "quickOpen";
const PROVIDER_ORDER = 1;

interface Match {
  score: number;
  item: CommandCenterItem;
}

/** 0=完全一致, 1=前方一致, 2=部分一致, null=ヒットなし */
function matchScore(title: string, q: string): number | null {
  const t = title.toLowerCase();
  if (!t.includes(q)) return null;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  return 2;
}

function untitled(): string {
  return i18next.t("commandCenter.untitled", { defaultValue: "(無題)" });
}

function gatherMatches(query: string, limit: number): CommandCenterItem[] {
  const q = query.toLowerCase();
  const matches: Match[] = [];

  for (const node of useTreeStore.getState().nodes) {
    if (node.nodeType !== "scene") continue;
    const title = node.title || untitled();
    const score = matchScore(title, q);
    if (score === null) continue;
    matches.push({
      score,
      item: {
        id: `quickopen-scene:${node.id}`,
        kind: "lexical-scene",
        title,
        badge: { label: "Scene", tone: "scene" },
        onSelect: () => {
          useTreeStore.getState().setActiveScene(node.id);
          useLayoutStore.getState().showPanel("editor");
        },
      },
    });
  }

  for (const entry of useCodexStore.getState().entries) {
    const title = entry.name || untitled();
    const score = matchScore(title, q);
    if (score === null) continue;
    matches.push({
      score,
      item: {
        id: `quickopen-codex:${entry.id}`,
        kind: "lexical-codex",
        title,
        badge: { label: "Codex", tone: "codex" },
        onSelect: () => {
          void requestOpenInCodex(entry.id);
        },
      },
    });
  }

  for (const snip of useSnippetStore.getState().entries) {
    const title = snip.title || untitled();
    const score = matchScore(title, q);
    if (score === null) continue;
    matches.push({
      score,
      item: {
        id: `quickopen-snippet:${snip.id}`,
        kind: "lexical-snippet",
        title,
        badge: { label: "Snippet", tone: "snippet" },
        onSelect: () => {
          useSnippetStore.getState().requestSelectEntry(snip.id);
          useLayoutStore.getState().showPanel("snippets");
        },
      },
    });
  }

  matches.sort((a, b) => a.score - b.score);
  return matches.slice(0, limit).map((m) => m.item);
}

function sectionTitle(): string {
  return i18next.t("commandCenter.sectionQuickOpen", {
    defaultValue: "ジャンプ",
  });
}

export const quickOpenProvider: CommandCenterProvider = {
  id: PROVIDER_ID,
  order: PROVIDER_ORDER,
  title: "Quick Open",
  hideWhenEmpty: true,
  surfaces: ["bar"],
  supportsMode: (mode) => mode === "search",
  async search(ctx: ProviderSearchContext): Promise<CommandCenterSection> {
    const query = ctx.query.trim();
    if (!query) {
      return {
        id: PROVIDER_ID,
        title: sectionTitle(),
        order: PROVIDER_ORDER,
        items: [],
      };
    }
    return {
      id: PROVIDER_ID,
      title: sectionTitle(),
      order: PROVIDER_ORDER,
      items: gatherMatches(query, ctx.limit),
    };
  },
};
