import {
  FolderTree,
  BookOpen,
  Pin,
  MessageSquare,
  MessagesSquare,
  Search,
  NotepadText,
  Signature,
  CalendarClock,
  Map as MapIcon,
  SpellCheck,
  LineSquiggle,
  Columns3,
  Table2,
  Trash2,
  BarChart3,
  History,
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
  "codex-quick": Pin,
  chat: MessageSquare,
  "chat-history": MessagesSquare,
  "command-center-results": Search,
  snippets: NotepadText,
  attribution: Signature,
  timeline: CalendarClock,
  map: MapIcon,
  kouetsu: SpellCheck,
  foreshadow: LineSquiggle,
  grid: Columns3,
  matrix: Table2,
  "writing-stats": BarChart3,
  "related-scenes": History,
  "trash-bin": Trash2,
};
