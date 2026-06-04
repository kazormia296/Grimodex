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
  Network,
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
  | "map"
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
  { id: "map", label: "Map", Icon: Network },
  { id: "linter", label: "Linter", Icon: CheckSquare },
  { id: "about", label: "About", Icon: Info },
];

/**
 * Scope of each settings key.
 * "global"  → stored in global-settings.json userPreferences (user preference, cross-workspace)
 * "project" → stored in project_settings table (work-specific, seeded from projectDefaults on creation)
 */
export const KEY_SCOPE: Record<string, "global" | "project"> = {
  // Editor — user preference (global)
  "editor.fontFamily": "global",
  "editor.fontSize": "global",
  "editor.lineHeight": "global",
  "editor.maxContentWidth": "global",
  "editor.paragraphSpacing": "global",
  "editor.typewriterMode": "global",
  "editor.focusMode": "global",
  "editor.autoSaveDelay": "global",
  "editor.spellCheck": "global",
  "editor.smartQuotes": "global",
  "editor.smartDashes": "global",
  "editor.markdownStrictLineBreaks": "global",
  "editor.inlineAiCommand": "global",
  "editor.inlineAiShortcut": "global",
  "editor.smoothCaret": "global",
  "editor.cursorBlink": "global",
  "editor.characterFadeIn": "global",
  "editor.characterFadeOut": "global",
  "editor.disableAllAnimations": "global",
  "editor.focusModeHideBeats": "global",
  "editor.sceneMetaPanelOpen": "global",
  "editor.sceneMetaPanelWidth": "global",
  "editor.linearBeatDisplay": "global",
  "editor.showBreadcrumb": "global",
  "editor.showLineNumbers": "global",
  // Editor — work-specific (project)
  "editor.targetCharCount": "project",
  "editor.wordBreak": "project",
  "editor.lineBreak": "project",
  "editor.paragraphIndent": "project",
  // Display — user preference (global)
  "display.showWordCount": "global",
  "display.showAiBadge": "global",
  "display.reduceMotion": "global",
  "display.cardLayout": "global",
  "display.glassEffectEnabled": "global",
  "display.glassTransparency": "global",
  "display.glassBackdropGradient": "global",
  "display.glassNativeVibrancy": "global",
  "display.glassSurfaceShell": "global",
  "display.glassSurfaceDock": "global",
  "display.glassSurfacePanels": "global",
  "display.glassSurfaceChat": "global",
  "display.glassSurfacePopovers": "global",
  "display.glassSurfaceEditorChrome": "global",
  "display.codexHighlight": "global",
  "display.codexHighlightStyle": "global",
  "display.attributionHighlightOpacity": "global",
  // AI — user preference (global)
  "ai.inlineModel": "global",
  "ai.sessionTitleModel": "global",
  "ai.modelWhitelist": "global",
  // AI — Web 検索 (RAG) ドメイン制御ポリシー (global)
  "ai.webSearch.domainMode": "global",
  "ai.webSearch.domains": "global",
  "ai.webSearch.maxContentTokens": "global",
  // AI — work-specific (project)
  "ai.contextBudget.l1": "project",
  "ai.contextBudget.l2": "project",
  "ai.contextBudget.l3": "project",
  "ai.contextBudget.l4": "project",
  "ai.contextBudget.l5": "project",
  "ai.contextBudget.reserve": "project",
  // Beat — work-specific (project)
  "beat.injectIntoContext": "project",
  "beat.inferRoles": "project",
  "beat.roleInferenceConfidenceThreshold": "project",
  // AI prompt customization — 追記式カスタム指示 (project)
  "aiPrompt.custom.chat": "project",
  "aiPrompt.custom.kouetsu": "project",
  "aiPrompt.custom.foreshadow": "project",
  "aiPrompt.custom.inline": "project",
  "aiPrompt.custom.beat": "project",
  "aiPrompt.custom.aiBranch": "project",
  // Keys — user preference (global)
  "keys.bindings": "global",
  // Data — user preference (global)
  "data.autoBackup": "global",
  "data.backupInterval": "global",
  "data.maxBackups": "global",
  // Revision — user preference (global)
  "revision.autoInterval": "global",
  "revision.keepCount": "global",
  // Tree — work-specific (project)
  "tree.folderNaming": "project",
  "tree.numberingScope": "project",
  // Map defaults — user preference (global)
  "map.defaultStickyPaletteId": "global",
  "map.defaultStickyColorSlot": "global",
  "map.defaultEdgeStyle": "global",
  // Export — work-specific (project)
  "export.format": "project",
  "export.folderHeading": "project",
  "export.folderHeadingStyle": "project",
  "export.sceneDivider": "project",
  "export.sceneDividerCustom": "project",
  "export.sceneTitle": "project",
  "export.rubyStyle": "project",
  "export.emphasisDotsStyle": "project",
  "export.sceneBreakStyle": "project",
  "export.sceneBreakCustom": "project",
  // Timelapse — work-specific (project)
  "timelapse.enabled": "project",
};

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
  // false → Obsidian default / GFM: single newline = visible line break (hardBreak)
  // true  → CommonMark spec: single newline = soft break (space)
  "editor.markdownStrictLineBreaks": "false",
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
  "display.cardLayout": "true",
  "display.glassEffectEnabled": "false",
  "display.glassTransparency": "30",
  "display.glassBackdropGradient": "true",
  "display.glassNativeVibrancy": "true",
  "display.glassSurfaceShell": "true",
  "display.glassSurfaceDock": "true",
  "display.glassSurfacePanels": "true",
  "display.glassSurfaceChat": "true",
  "display.glassSurfacePopovers": "true",
  "display.glassSurfaceEditorChrome": "true",
  "display.codexHighlight": "true",
  "display.codexHighlightStyle": "color-text",
  "display.attributionHighlightOpacity": "10",
  // AI
  "ai.inlineModel": "",
  "ai.sessionTitleModel": "",
  "ai.modelWhitelist": "[]",
  "ai.webSearch.domainMode": "off",
  "ai.webSearch.domains": "[]",
  "ai.webSearch.maxContentTokens": "",
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
  // AI prompt customization addenda — 空 = 組み込みプロンプトのまま (byte-identical)
  "aiPrompt.custom.chat": "",
  "aiPrompt.custom.kouetsu": "",
  "aiPrompt.custom.foreshadow": "",
  "aiPrompt.custom.inline": "",
  "aiPrompt.custom.beat": "",
  "aiPrompt.custom.aiBranch": "",
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
  // Map defaults
  "map.defaultStickyPaletteId": "post-it-playful",
  "map.defaultStickyColorSlot": "0",
  "map.defaultEdgeStyle": "solid",
  // Timelapse — record changes for this project (default on, preserves
  // the previous always-on behaviour; legacy projects with no row read on).
  "timelapse.enabled": "true",
};
