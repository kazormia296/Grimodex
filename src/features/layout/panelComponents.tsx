import { lazy } from "react";
import type {
  ComponentType,
  FunctionComponent,
  LazyExoticComponent,
} from "react";

import { Sidebar } from "@/features/tree/Sidebar";
import { SceneContextPanel } from "@/features/tree/SceneContextPanel";
import { CodexManagementPanel } from "@/features/codex/CodexManagementPanel";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ChatHistoryPanel } from "@/features/chat/ChatHistoryPanel";
import { SnippetPanel } from "@/features/snippets/SnippetPanel";
import { AttributionReport } from "@/features/attribution/AttributionReport";
import { TimelinePanel } from "@/features/timeline/TimelinePanel";
import { MapPanel } from "@/features/map/MapPanel";
import { KouetsuPanel } from "@/features/kouetsu/KouetsuPanel";
import { ForeshadowPanel } from "@/features/foreshadow/ForeshadowPanel";
import { GridPanel } from "@/features/grid/GridPanel";
import { MatrixPanel } from "@/features/matrix/MatrixPanel";
import { TrashBinPanel } from "@/features/trash-bin/TrashBinPanel";
import { CommandCenterResultsPanel } from "@/features/commandCenter/CommandCenterResultsPanel";
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
