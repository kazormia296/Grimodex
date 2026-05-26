import i18next from "i18next";
import { useLayoutStore, type PanelId } from "@/features/layout/layoutStore";
import type {
  CommandCenterItem,
  CommandCenterProvider,
  CommandCenterSection,
  ProviderSearchContext,
} from "./types";

/**
 * バー用 Command Provider。
 * VSCode の Ctrl+Shift+P 相当。`> ` で起動する command mode 専用 (検索 mode では何も返さない)。
 * Grimodex 内のアクション (設定起動・エクスポート・ツアー再開・各パネル開閉) を一覧化する。
 */

const PROVIDER_ID = "commands";
const PROVIDER_ORDER = 3;

interface CommandDef {
  id: string;
  label: string;
  /** 部分一致用の補助キーワード (英数/カナ別表記など) */
  keywords?: string;
  run: () => void;
}

interface PanelDef {
  panelId: Exclude<PanelId, "editor">;
  label: string;
  keywords?: string;
}

const PANEL_COMMANDS: PanelDef[] = [
  { panelId: "scenes", label: "シーン", keywords: "scenes tree" },
  { panelId: "codex", label: "Codex", keywords: "codex glossary" },
  { panelId: "codex-quick", label: "Codex クイック", keywords: "codex quick" },
  {
    panelId: "command-center-results",
    label: "検索パネル",
    keywords: "search panel results",
  },
  { panelId: "chat", label: "AI チャット", keywords: "chat ai" },
  { panelId: "chat-history", label: "チャット履歴", keywords: "chat history" },
  { panelId: "snippets", label: "スニペット", keywords: "snippets" },
  {
    panelId: "attribution",
    label: "帰属ヒートマップ",
    keywords: "attribution heatmap",
  },
  { panelId: "timeline", label: "タイムライン", keywords: "timeline" },
  { panelId: "map", label: "地図", keywords: "map" },
  { panelId: "kouetsu", label: "校閲", keywords: "kouetsu review" },
  { panelId: "foreshadow", label: "伏線", keywords: "foreshadow" },
  { panelId: "grid", label: "グリッド", keywords: "grid board" },
  { panelId: "matrix", label: "マトリクス", keywords: "matrix" },
  { panelId: "trash-bin", label: "ゴミ箱", keywords: "trash bin recycle" },
];

function buildCommands(): CommandDef[] {
  const list: CommandDef[] = [
    {
      id: "open-settings",
      label: "設定を開く",
      keywords: "settings preferences config",
      run: () =>
        window.dispatchEvent(
          new CustomEvent("open-settings", { detail: { category: "project" } }),
        ),
    },
    {
      id: "open-export",
      label: "エクスポート",
      keywords: "export download",
      run: () => window.dispatchEvent(new CustomEvent("open-export-dialog")),
    },
    {
      id: "restart-sample-tour",
      label: "ツアー再開",
      keywords: "tour tutorial onboarding",
      run: () => window.dispatchEvent(new CustomEvent("restart-sample-tour")),
    },
  ];

  for (const p of PANEL_COMMANDS) {
    list.push({
      id: `toggle-panel:${p.panelId}`,
      label: `パネル切替: ${p.label}`,
      keywords: `panel toggle ${p.keywords ?? ""}`,
      run: () => useLayoutStore.getState().togglePanel(p.panelId),
    });
  }

  return list;
}

function matchScore(label: string, keywords: string, q: string): number | null {
  const l = label.toLowerCase();
  const k = keywords.toLowerCase();
  if (l.includes(q)) {
    if (l === q) return 0;
    if (l.startsWith(q)) return 1;
    return 2;
  }
  if (k.includes(q)) return 3;
  return null;
}

function toItem(cmd: CommandDef): CommandCenterItem {
  return {
    id: `command:${cmd.id}`,
    kind: "command",
    title: cmd.label,
    badge: { label: "Cmd", tone: "command" },
    onSelect: cmd.run,
  };
}

function sectionTitle(): string {
  return i18next.t("commandCenter.sectionCommands", {
    defaultValue: "コマンド",
  });
}

export const commandProvider: CommandCenterProvider = {
  id: PROVIDER_ID,
  order: PROVIDER_ORDER,
  title: "Commands",
  hideWhenEmpty: true,
  surfaces: ["bar"],
  supportsMode: (mode) => mode === "command",
  async search(ctx: ProviderSearchContext): Promise<CommandCenterSection> {
    const all = buildCommands();
    const query = ctx.query.trim().toLowerCase();
    let items: CommandCenterItem[];
    if (!query) {
      // 空クエリ時は全コマンドを宣言順で表示 (limit で打ち切り)
      items = all.slice(0, ctx.limit).map(toItem);
    } else {
      const scored: { score: number; cmd: CommandDef }[] = [];
      for (const cmd of all) {
        const s = matchScore(cmd.label, cmd.keywords ?? "", query);
        if (s !== null) scored.push({ score: s, cmd });
      }
      scored.sort((a, b) => a.score - b.score);
      items = scored.slice(0, ctx.limit).map((x) => toItem(x.cmd));
    }
    return {
      id: PROVIDER_ID,
      title: sectionTitle(),
      order: PROVIDER_ORDER,
      items,
    };
  },
};
