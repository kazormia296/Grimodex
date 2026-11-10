import { lazy } from "react";
import type {
  ComponentType,
  FunctionComponent,
  LazyExoticComponent,
} from "react";

import { Sidebar } from "@/features/tree/Sidebar";
import { SceneEditor } from "@/features/tree/SceneEditor";

import type { PanelId } from "./panelIds";
import { registerPanelPreloaders } from "./panelPreload";
import type { SlotPanelProps } from "./layoutTypes";

interface PreloadablePanel {
  Component: LazyExoticComponent<ComponentType<SlotPanelProps>>;
  preload: () => Promise<void>;
  isLoaded: () => boolean;
}

/**
 * 先読みできる lazy パネル。`lazy()` は初回の render で factory を呼び、受け取った
 * promise で必ず一度 suspend する（module が読み込み済みでも、fallback の throttle
 * の分だけ skeleton が見える）。先読みが module を読み終えていれば factory は
 * 同期に解決する thenable を返すので、初回の render は suspend しない。先読みの
 * 前（または失敗の後）は素の `import()` のまま（RelatedScenesSection の
 * preloadableLazy と同じ仕組み）。
 */
function preloadablePanel(
  load: () => Promise<{ default: ComponentType<SlotPanelProps> }>,
): PreloadablePanel {
  let loaded: { default: ComponentType<SlotPanelProps> } | null = null;
  let pending: Promise<void> | null = null;
  const Component = lazy(() =>
    loaded
      ? (syncThenable(loaded) as unknown as Promise<{
          default: ComponentType<SlotPanelProps>;
        }>)
      : load(),
  );
  const preload = () => {
    if (loaded) return Promise.resolve();
    pending ??= load().then(
      (mod) => {
        loaded = mod;
      },
      () => {
        pending = null;
      },
    );
    return pending;
  };
  return { Component, preload, isLoaded: () => loaded !== null };
}

function syncThenable<T>(value: T) {
  return {
    then(onFulfilled: (value: T) => unknown) {
      onFulfilled(value);
    },
  };
}

// 重量級のオプションパネルは lazy 化し、開くまで import しない（起動バンドル削減）。
// ChroniclePanel は ChronicleInspector → chronicleLunar → lunar-typescript まで
// 引き連れるため効果が大きい。描画サイト (SlotView / AnimatedSlotPanel) 側に
// Suspense boundary がある。
const SceneContextPanel = preloadablePanel(() =>
  import("@/features/tree/SceneContextPanel").then((m) => ({
    default: m.SceneContextPanel,
  })),
);
const ChroniclePanel = preloadablePanel(() =>
  import("@/features/chronicle/ChroniclePanel").then((m) => ({
    default: m.ChroniclePanel,
  })),
);
const WritingStatsPanel = preloadablePanel(() =>
  import("@/features/writing-stats/WritingStatsPanel").then((m) => ({
    default: m.WritingStatsPanel,
  })),
);

const CodexManagementPanel = preloadablePanel(() =>
  import("@/features/codex/CodexManagementPanel").then((m) => ({
    default: m.CodexManagementPanel,
  })),
);
const ChatHistoryPanel = preloadablePanel(() =>
  import("@/features/chat/ChatHistoryPanel").then((m) => ({
    default: m.ChatHistoryPanel,
  })),
);
const ChatPanel = preloadablePanel(() =>
  import("@/features/chat/ChatPanel").then((m) => ({
    default: m.ChatPanel,
  })),
);
const SnippetPanel = preloadablePanel(() =>
  import("@/features/snippets/SnippetPanel").then((m) => ({
    default: m.SnippetPanel,
  })),
);
const AttributionReport = preloadablePanel(() =>
  import("@/features/attribution/AttributionReport").then((m) => ({
    default: m.AttributionReport,
  })),
);
const TimelinePanel = preloadablePanel(() =>
  import("@/features/timeline/TimelinePanel").then((m) => ({
    default: m.TimelinePanel,
  })),
);
const MapPanel = preloadablePanel(() =>
  import("@/features/map/MapPanel").then((m) => ({ default: m.MapPanel })),
);
const KouetsuPanel = preloadablePanel(() =>
  import("@/features/kouetsu/KouetsuPanel").then((m) => ({
    default: m.KouetsuPanel,
  })),
);
const ForeshadowPanel = preloadablePanel(() =>
  import("@/features/foreshadow/ForeshadowPanel").then((m) => ({
    default: m.ForeshadowPanel,
  })),
);
const GridPanel = preloadablePanel(() =>
  import("@/features/grid/GridPanel").then((m) => ({ default: m.GridPanel })),
);
const MatrixPanel = preloadablePanel(() =>
  import("@/features/matrix/MatrixPanel").then((m) => ({
    default: m.MatrixPanel,
  })),
);
const TrashBinPanel = preloadablePanel(() =>
  import("@/features/trash-bin/TrashBinPanel").then((m) => ({
    default: m.TrashBinPanel,
  })),
);
const CommandCenterResultsPanel = preloadablePanel(() =>
  import("@/features/commandCenter/CommandCenterResultsPanel").then((m) => ({
    default: m.CommandCenterResultsPanel,
  })),
);

export type PanelComponent =
  | FunctionComponent<SlotPanelProps>
  | LazyExoticComponent<ComponentType<SlotPanelProps>>;

const PANEL_PRELOADERS: Partial<Record<PanelId, PreloadablePanel>> = {
  codex: CodexManagementPanel,
  "chat-history": ChatHistoryPanel,
  chat: ChatPanel,
  snippets: SnippetPanel,
  attribution: AttributionReport,
  "codex-quick": SceneContextPanel,
  timeline: TimelinePanel,
  chronicle: ChroniclePanel,
  map: MapPanel,
  kouetsu: KouetsuPanel,
  foreshadow: ForeshadowPanel,
  grid: GridPanel,
  matrix: MatrixPanel,
  "writing-stats": WritingStatsPanel,
  "trash-bin": TrashBinPanel,
  "command-center-results": CommandCenterResultsPanel,
};

registerPanelPreloaders(PANEL_PRELOADERS);

/** SSoT for panel content components. */
export const PANEL_COMPONENT_MAP: Record<PanelId, PanelComponent> = {
  scenes: Sidebar,
  codex: CodexManagementPanel.Component,
  "chat-history": ChatHistoryPanel.Component,
  editor: SceneEditor,
  chat: ChatPanel.Component,
  snippets: SnippetPanel.Component,
  attribution: AttributionReport.Component,
  "codex-quick": SceneContextPanel.Component,
  timeline: TimelinePanel.Component,
  chronicle: ChroniclePanel.Component,
  map: MapPanel.Component,
  kouetsu: KouetsuPanel.Component,
  foreshadow: ForeshadowPanel.Component,
  grid: GridPanel.Component,
  matrix: MatrixPanel.Component,
  "writing-stats": WritingStatsPanel.Component,
  "trash-bin": TrashBinPanel.Component,
  "command-center-results": CommandCenterResultsPanel.Component,
};
