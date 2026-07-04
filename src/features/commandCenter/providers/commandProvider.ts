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
  keywords?: string;
}

/**
 * パネル開閉コマンドの静的データ。
 * label は import 時に確定させず、表示時に layout.panel.<panelId> から
 * i18next で解決する (言語切替に追従させるため)。
 */
const PANEL_COMMANDS: PanelDef[] = [
  { panelId: "scenes", keywords: "scenes tree" },
  { panelId: "codex", keywords: "codex glossary" },
  { panelId: "codex-quick", keywords: "scene context codex quick" },
  {
    panelId: "command-center-results",
    keywords: "search panel results",
  },
  { panelId: "chat", keywords: "chat ai" },
  { panelId: "chat-history", keywords: "chat history" },
  { panelId: "snippets", keywords: "snippets" },
  {
    panelId: "attribution",
    keywords: "attribution heatmap",
  },
  { panelId: "timeline", keywords: "timeline" },
  { panelId: "map", keywords: "map" },
  { panelId: "kouetsu", keywords: "kouetsu review" },
  { panelId: "foreshadow", keywords: "foreshadow" },
  { panelId: "grid", keywords: "grid board" },
  { panelId: "matrix", keywords: "matrix" },
  { panelId: "trash-bin", keywords: "trash bin recycle" },
];

/** パネル名を layout.panel.<panelId> から解決する (言語切替に追従)。 */
function panelLabel(panelId: PanelDef["panelId"]): string {
  return i18next.t(`layout.panel.${panelId}`, { defaultValue: panelId });
}

function buildCommands(): CommandDef[] {
  const list: CommandDef[] = [
    {
      id: "open-settings",
      label: i18next.t("commandCenter.command.openSettings", {
        defaultValue: "設定を開く",
      }),
      keywords: "settings preferences config",
      run: () =>
        window.dispatchEvent(
          new CustomEvent("open-settings", { detail: { category: "project" } }),
        ),
    },
    {
      id: "open-export",
      label: i18next.t("commandCenter.command.export", {
        defaultValue: "エクスポート",
      }),
      keywords: "export download",
      run: () => window.dispatchEvent(new CustomEvent("open-export-dialog")),
    },
    {
      id: "open-vivliostyle",
      label: i18next.t("commandCenter.command.vivliostyle", {
        defaultValue: "本の書き出し（Vivliostyle）",
      }),
      keywords: "vivliostyle book pdf epub print 組版",
      run: () =>
        window.dispatchEvent(new CustomEvent("open-vivliostyle-dialog")),
    },
    {
      id: "restart-sample-tour",
      label: i18next.t("commandCenter.command.restartTour", {
        defaultValue: "ツアー再開",
      }),
      keywords: "tour tutorial onboarding",
      run: () => window.dispatchEvent(new CustomEvent("restart-sample-tour")),
    },
  ];

  for (const p of PANEL_COMMANDS) {
    list.push({
      id: `toggle-panel:${p.panelId}`,
      label: i18next.t("commandCenter.command.togglePanel", {
        panel: panelLabel(p.panelId),
        defaultValue: "パネル切替: {{panel}}",
      }),
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
