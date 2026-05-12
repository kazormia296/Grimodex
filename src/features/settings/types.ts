import {
  FolderOpen,
  Bot,
  Type,
  Monitor,
  Keyboard,
  Database,
  BookOpen,
  CheckSquare,
  Info,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type SettingsCategory =
  | "project"
  | "ai"
  | "editor"
  | "display"
  | "keys"
  | "data"
  | "codex"
  | "linter"
  | "about";

export interface CategoryDef {
  id: SettingsCategory;
  label: string;
  Icon: LucideIcon;
}

export const SETTINGS_CATEGORIES: CategoryDef[] = [
  { id: "project", label: "Project", Icon: FolderOpen },
  { id: "ai", label: "AI", Icon: Bot },
  { id: "editor", label: "Editor", Icon: Type },
  { id: "display", label: "Display", Icon: Monitor },
  { id: "keys", label: "Keys", Icon: Keyboard },
  { id: "data", label: "Data", Icon: Database },
  { id: "codex", label: "Codex", Icon: BookOpen },
  { id: "linter", label: "校正", Icon: CheckSquare },
  { id: "about", label: "About", Icon: Info },
];

export const DEFAULT_SETTINGS: Record<string, string> = {
  // Editor
  "editor.fontFamily": "serif",
  "editor.fontSize": "18",
  "editor.lineHeight": "2.0",
  "editor.maxContentWidth": "720",
  "editor.paragraphSpacing": "8",
  "editor.typewriterMode": "false",
  "editor.focusMode": "false",
  "editor.autoSaveDelay": "2000",
  "editor.spellCheck": "false",
  "editor.smartQuotes": "false",
  "editor.smartDashes": "false",
  "editor.inlineAiCommand": "true",
  "editor.inlineAiShortcut": "true",
  "editor.smoothCaret": "true",
  "editor.cursorBlink": "true",
  "editor.targetCharCount": "0",
  "editor.characterFadeIn": "false",
  "editor.characterFadeOut": "false",
  "editor.disableAllAnimations": "false",
  "editor.wordBreak": "normal",
  "editor.lineBreak": "strict",
  "editor.focusModeHideBeats": "false",
  "editor.sceneMetaPanelOpen": "true",
  "editor.sceneMetaPanelWidth": "20",
  "editor.linearBeatDisplay": "collapsed",
  "editor.showBreadcrumb": "true",
  "editor.showLineNumbers": "false",
  "editor.paragraphIndent": "0",
  // Display (theme, uiLanguage, uiScale are in GlobalSettings)
  "display.showWordCount": "true",
  "display.showAiBadge": "false",
  "display.reduceMotion": "false",
  "display.codexHighlight": "true",
  "display.codexHighlightStyle": "color-text",
  "display.attributionHighlightOpacity": "10",
  // AI
  "ai.inlineModel": "",
  "ai.sessionTitleModel": "",
  "ai.modelWhitelist": "[]",
  "ai.contextBudget.l1": "2",
  "ai.contextBudget.l2": "10",
  "ai.contextBudget.l3": "40",
  "ai.contextBudget.l4": "20",
  "ai.contextBudget.l5": "20",
  "ai.contextBudget.reserve": "5",
  // Beat AI context injection (Phase C)
  "beat.injectIntoContext": "true",
  "beat.inferRoles": "true",
  "beat.roleInferenceConfidenceThreshold": "0.7",
  // Keys
  "keys.bindings": "{}",
  // Data
  "data.autoBackup": "true",
  "data.backupInterval": "60",
  "data.maxBackups": "10",
  // Revision
  "revision.autoInterval": "5",
  "revision.keepCount": "50",
  // Tree / naming
  "tree.folderNaming": "auto",
  // tree.sceneNaming / tree.noteNaming: intentionally omitted — fallback
  // is resolved via i18next so the default follows the active UI language.
  "tree.numberingScope": "project",
  // Export
  "export.format": "plaintext",
  "export.folderHeading": "true",
  "export.folderHeadingStyle": "squares",
  "export.sceneDivider": "blank",
  "export.sceneDividerCustom": "",
  "export.sceneTitle": "none",
  "export.rubyStyle": "",
  "export.emphasisDotsStyle": "",
  "export.sceneBreakStyle": "asterisks",
  "export.sceneBreakCustom": "",
};
