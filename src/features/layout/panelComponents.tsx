import { lazy } from "react";
import type {
  ComponentType,
  FunctionComponent,
  LazyExoticComponent,
} from "react";

import { Sidebar } from "@/features/tree/Sidebar";
import { SceneContextPanel } from "@/features/tree/SceneContextPanel";
import { SceneEditor } from "@/features/tree/SceneEditor";

import type { PanelId } from "./panelIds";
import type { SlotPanelProps } from "./layoutTypes";

// 重量級のオプションパネルは lazy 化し、開くまで import しない（起動バンドル削減）。
// ChroniclePanel は ChronicleInspector → chronicleLunar → lunar-typescript まで
// 引き連れるため効果が大きい。描画サイト (SlotView / AnimatedSlotPanel) 側に
// Suspense boundary がある。
const ChroniclePanel = lazy(() =>
  import("@/features/chronicle/ChroniclePanel").then((m) => ({
    default: m.ChroniclePanel,
  })),
);
const WritingStatsPanel = lazy(() =>
  import("@/features/writing-stats/WritingStatsPanel").then((m) => ({
    default: m.WritingStatsPanel,
  })),
);

const CodexManagementPanel = lazy(() =>
  import("@/features/codex/CodexManagementPanel").then((m) => ({
    default: m.CodexManagementPanel,
  })),
);
const ChatHistoryPanel = lazy(() =>
  import("@/features/chat/ChatHistoryPanel").then((m) => ({
    default: m.ChatHistoryPanel,
  })),
);
const ChatPanel = lazy(() =>
  import("@/features/chat/ChatPanel").then((m) => ({
    default: m.ChatPanel,
  })),
);
const SnippetPanel = lazy(() =>
  import("@/features/snippets/SnippetPanel").then((m) => ({
    default: m.SnippetPanel,
  })),
);
const AttributionReport = lazy(() =>
  import("@/features/attribution/AttributionReport").then((m) => ({
    default: m.AttributionReport,
  })),
);
const TimelinePanel = lazy(() =>
  import("@/features/timeline/TimelinePanel").then((m) => ({
    default: m.TimelinePanel,
  })),
);
const MapPanel = lazy(() =>
  import("@/features/map/MapPanel").then((m) => ({ default: m.MapPanel })),
);
const KouetsuPanel = lazy(() =>
  import("@/features/kouetsu/KouetsuPanel").then((m) => ({
    default: m.KouetsuPanel,
  })),
);
const ForeshadowPanel = lazy(() =>
  import("@/features/foreshadow/ForeshadowPanel").then((m) => ({
    default: m.ForeshadowPanel,
  })),
);
const GridPanel = lazy(() =>
  import("@/features/grid/GridPanel").then((m) => ({ default: m.GridPanel })),
);
const MatrixPanel = lazy(() =>
  import("@/features/matrix/MatrixPanel").then((m) => ({
    default: m.MatrixPanel,
  })),
);
const TrashBinPanel = lazy(() =>
  import("@/features/trash-bin/TrashBinPanel").then((m) => ({
    default: m.TrashBinPanel,
  })),
);
const CommandCenterResultsPanel = lazy(() =>
  import("@/features/commandCenter/CommandCenterResultsPanel").then((m) => ({
    default: m.CommandCenterResultsPanel,
  })),
);

export type PanelComponent =
  | FunctionComponent<SlotPanelProps>
  | LazyExoticComponent<ComponentType<SlotPanelProps>>;

/** SSoT for panel content components. */
export const PANEL_COMPONENT_MAP: Record<PanelId, PanelComponent> = {
  scenes: Sidebar,
  codex: CodexManagementPanel,
  "chat-history": ChatHistoryPanel,
  editor: SceneEditor,
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
