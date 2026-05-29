import type { FunctionComponent } from "react";

import { Sidebar } from "@/features/tree/Sidebar";
import { CodexQuickPanel } from "@/features/tree/CodexQuickPanel";
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
import { TimelapsePanel } from "@/features/timelapse/TimelapsePanel";
import { CommandCenterResultsPanel } from "@/features/commandCenter/CommandCenterResultsPanel";
import { SceneEditor } from "@/features/tree/SceneEditor";

import type { PanelId } from "./panelIds";

/** SSoT for panel content components. */
export const PANEL_COMPONENT_MAP: Record<PanelId, FunctionComponent> = {
  scenes: Sidebar,
  codex: CodexManagementPanel,
  "chat-history": ChatHistoryPanel,
  editor: SceneEditor,
  chat: ChatPanel,
  snippets: SnippetPanel,
  attribution: AttributionReport,
  "codex-quick": CodexQuickPanel,
  timeline: TimelinePanel,
  map: MapPanel,
  kouetsu: KouetsuPanel,
  foreshadow: ForeshadowPanel,
  grid: GridPanel,
  matrix: MatrixPanel,
  "trash-bin": TrashBinPanel,
  timelapse: TimelapsePanel,
  "command-center-results": CommandCenterResultsPanel,
};
