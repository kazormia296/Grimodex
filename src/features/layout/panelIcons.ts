import {
  FolderTree,
  BookOpen,
  Zap,
  MessageSquare,
  MessagesSquare,
  Search,
  TextQuote,
  Highlighter,
  CalendarRange,
  Map as MapIcon,
  SpellCheck,
  Sparkles,
  Grid2x2,
  Table2,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import type { PanelId } from "./layoutStore";

/**
 * Stripe / context menu / dropdown で使う panel icon。
 * header の LayoutGrid / 既存 toolbar icon と衝突しないよう選定済み。
 */
export const PANEL_ICON_MAP: Record<Exclude<PanelId, "editor">, LucideIcon> = {
  scenes: FolderTree,
  codex: BookOpen,
  "codex-quick": Zap,
  chat: MessageSquare,
  "chat-history": MessagesSquare,
  "command-center-results": Search,
  snippets: TextQuote,
  attribution: Highlighter,
  timeline: CalendarRange,
  map: MapIcon,
  kouetsu: SpellCheck,
  foreshadow: Sparkles,
  grid: Grid2x2,
  matrix: Table2,
  "trash-bin": Trash2,
};
