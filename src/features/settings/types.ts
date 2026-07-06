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
  KeyRound,
  Network,
  Activity,
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
  | "usage"
  | "license"
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
  { id: "usage", label: "Usage", Icon: Activity },
  // License は licensing 無効ビルドでは CategoryNav が非表示にする (設計書 §9.1)
  { id: "license", label: "License", Icon: KeyRound },
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
  "editor.bubbleMenu": "global",
  "editor.smoothCaret": "global",
  "editor.cursorBlink": "global",
  "editor.caretSlideDuration": "global",
  "editor.caretSlideSnappiness": "global",
  "editor.characterFadeOut": "global",
  "editor.disableAllAnimations": "global",
  "editor.focusModeHideBeats": "global",
  "editor.sceneMetaPanelOpen": "global",
  "editor.sceneMetaPanelWidth": "global",
  "editor.linearBeatDisplay": "global",
  "editor.showLineNumbers": "global",
  // Editor — work-specific (project)
  "editor.targetCharCount": "project",
  "editor.wordBreak": "project",
  "editor.lineBreak": "project",
  "editor.textAutospace": "project",
  "editor.paragraphIndent": "project",
  "editor.verticalMode": "project",
  "editor.tateChuYoko": "project",
  // Writing goal — daily character target
  // default は全プロジェクト共通の既定値 (global)、override は当該プロジェクト
  // 固有値 (project)。override が 0 のとき default にフォールバックする。
  "goal.dailyDefaultChars": "global",
  "goal.dailyChars": "project",
  // Finish-line pacemaker — 原稿全体の目標総文字数と任意の締切（共に project 固有）。
  "goal.manuscriptTargetChars": "project",
  "goal.manuscriptDeadline": "project",
  // Display — user preference (global)
  "display.uiFontFamily": "global",
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
  "display.codexHighlightOpacity": "global",
  "display.attributionHighlightOpacity": "global",
  // 本文レイヤーの表示トグル (Editorパネル Refine 1c で永続化を統一)
  "display.layerAttribution": "global",
  "display.layerComments": "global",
  "display.layerReaderComments": "global",
  "display.layerForeshadow": "global",
  "display.layerReview": "global",
  "display.layerLint": "global",
  // 本文レイヤーのパネル連動 (Auto) モード
  "display.layerAutoFollow": "global",
  // Codex — user preference (global)
  "codex.entryTitleFont": "global",
  // AI — user preference (global)
  "ai.inlineModel": "global",
  "ai.sessionTitleModel": "global",
  "ai.modelWhitelist": "global",
  // AI — 機能別モデル（ロール単位）。空 = 既定チャットモデルにフォールバック (global)。
  // 解決は src/features/chat/modelRouting.ts の resolveModelForPath が正本。
  "aiModel.role.conversation": "global",
  "aiModel.role.agent": "global",
  "aiModel.role.inline": "global",
  "aiModel.role.cheap": "global",
  "aiModel.role.structured": "global",
  "aiModel.role.review": "global",
  // 機能別モデルのプロバイダ横断: 各ロールに別プロバイダ/別エンドポイントを
  // 割り当てる JSON マップ Record<role,{provider?,endpointId?}>。空 {} なら全ロール
  // アクティブ provider 据え置き(後方互換)。解決は resolveRolePathConfig が正本 (global)。
  "aiModel.roleProviders": "global",
  // AI — Web 検索 (RAG) ドメイン制御ポリシー (global)
  "ai.webSearch.domainMode": "global",
  "ai.webSearch.domains": "global",
  "ai.webSearch.maxContentTokens": "global",
  // AI — work-specific (project)
  // Auto-apply AI body proposals (headless full-auto): when on (and the
  // bodyWrite policy is on), proposed prose-staging rows are applied without a
  // human accept. Default off — does not change the human-in-the-loop contract.
  "ai.autoAcceptBodyProposals": "project",
  // Semantic recall (Layer4 RAG): drafting チャットへ過去シーンの意味検索
  // 抜粋を自動注入する (project)
  "ai.semanticRecall": "project",
  // Hybrid recall: 意味検索 (dense) に FTS5/bm25 (sparse) を RRF 融合し、
  // 固有名詞 (人名・地名) の recall を補う。semanticRecall が前提 (project)
  "ai.hybridRecall": "project",
  // Chat episodic recall: 過去の対話 (チャット履歴) を意味検索で自動注入する。
  // scene RAG (semanticRecall) とは独立トグルで、記憶だけ切れる (project)
  "ai.chatRecall": "project",
  "ai.contextBudget.l1": "project",
  "ai.contextBudget.l2": "project",
  "ai.contextBudget.l3": "project",
  "ai.contextBudget.l4": "project",
  "ai.contextBudget.l5": "project",
  "ai.contextBudget.reserve": "project",
  // AI cost budget — 月予算 (USD)・プロジェクト毎・表示のみ (0 = 未設定)。
  // 生成はブロックしない (機能①「トークン予算 ETA」)。
  "ai.costBudgetPerMonth": "project",
  // Beat — work-specific (project)
  "beat.injectIntoContext": "project",
  "beat.inferRoles": "project",
  "beat.roleInferenceConfidenceThreshold": "project",
  // --- A/B 比較 (③) — モデル/プロンプト A/B の既定値 (global) -----------------
  // モデル A/B のデフォルト相手モデル (A=現在の既定モデル, B=これ)。空=未設定。
  "abTest.defaultModelB": "global",
  // プロンプト A/B のデフォルト追記指示 (A=なし, B=これ)。空=未設定。
  "abTest.defaultPromptVariantB": "global",
  // ---------------------------------------------------------------------------
  // AI prompt customization — 追記式カスタム指示 (project)
  "aiPrompt.custom.chat": "project",
  "aiPrompt.custom.kouetsu": "project",
  "aiPrompt.custom.foreshadow": "project",
  "aiPrompt.custom.inline": "project",
  "aiPrompt.custom.beat": "project",
  "aiPrompt.custom.aiBranch": "project",
  // 作中年表スナップショットを AI チャット文脈に注入するか (project)
  "aiPrompt.chronicle.enabled": "project",
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
  // Trash bin — work-specific (project)。Project タブで設定し「既定として保存」で
  // 新規プロジェクトへ継承させるため project スコープ。未登録だと legacy(appSettings)
  // へ書かれ getAllProjectSettings の集計から漏れて defaults に乗らなかった。
  // 既存ユーザーの legacy 値は buildCache の legacy 層マージで引き続き読める(移行安全)。
  "trashBin.enabled": "project",
  "trashBin.retentionDays": "project",
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
  // Vivliostyle（本の書き出し）— CLI バイナリパスはユーザー環境依存 (global)、
  // テーマ/形式は作品の体裁 (project)
  "vivliostyle.binaryPath": "global",
  "vivliostyle.theme": "project",
  "vivliostyle.format": "project",
};

export const DEFAULT_SETTINGS: Record<string, string> = {
  // Editor
  // 同梱フォント Noto Serif JP を本文デフォルトに。fallback を付けない値は
  // buildFontOptions の同梱/列挙 option (quoteFamily) と一致し、重複表示を避ける。
  "editor.fontFamily": '"Noto Serif JP"',
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
  "editor.bubbleMenu": "true",
  "editor.smoothCaret": "true",
  "editor.cursorBlink": "true",
  "editor.caretSlideDuration": "80",
  "editor.caretSlideSnappiness": "50",
  "editor.targetCharCount": "0",
  "editor.characterFadeOut": "false",
  "editor.disableAllAnimations": "false",
  "editor.wordBreak": "normal",
  "editor.lineBreak": "strict",
  // 和欧間スペーシング (CSS text-autospace)。WebKit のデフォルトは
  // no-autospace なので、和欧間アキを効かせるには normal を明示する必要がある
  // （normal は仕様本来の既定値で、CJK↔英数字に四分アキ相当を自動挿入）。
  "editor.textAutospace": "normal",
  "editor.focusModeHideBeats": "false",
  "editor.sceneMetaPanelOpen": "true",
  "editor.sceneMetaPanelWidth": "20",
  "editor.linearBeatDisplay": "collapsed",
  "editor.showLineNumbers": "false",
  "editor.paragraphIndent": "0",
  "editor.verticalMode": "false",
  // 縦中横（縦書き時に半角数字を正立結合）。既定は出版物の慣習に最も近い
  // 2桁のみ結合。3桁以上は流儀に幅があるため "all" で任意に有効化できる。
  "editor.tateChuYoko": "2",
  // Writing goal — daily character target (0 = no goal). default は global、
  // project 固有値が 0 のとき default にフォールバックする。
  "goal.dailyDefaultChars": "0",
  "goal.dailyChars": "0",
  // Finish-line pacemaker（0 / 空 = 未設定）。締切は "YYYY-MM-DD" のローカル日付。
  "goal.manuscriptTargetChars": "0",
  "goal.manuscriptDeadline": "",
  // Display (theme, uiLanguage, uiScale are in GlobalSettings)
  // 同梱 UI 書体 M PLUS 1 を既定に。fallback 無しは buildFontOptions の
  // 同梱/列挙 option (quoteFamily) と一致させ重複表示を防ぐ。
  "display.uiFontFamily": '"M PLUS 1"',
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
  // Codex ハイライト(背景スタイル)の濃度。10 = パレット設計値そのまま
  // (codexHighlightBackground が 10 未満を透明側、10 超を fg 混合で解決)
  "display.codexHighlightOpacity": "10",
  "display.attributionHighlightOpacity": "10",
  // 本文レイヤー表示の既定: 校閲・Lint・読者コメントはON、帰属・コメント・伏線はOFF
  // （従来の各ストア初期値と同じ。以後はトグルが write-through で永続化）
  "display.layerAttribution": "false",
  "display.layerComments": "false",
  "display.layerReaderComments": "true",
  "display.layerForeshadow": "false",
  "display.layerReview": "true",
  "display.layerLint": "true",
  "display.layerAutoFollow": "false",
  // Codex — エントリタイトル(名称欄)のフォント。空 = 言語別の既定に追従
  // (codexNameFont が ja=駅名標 / en=Helvetica系 を解決)。ユーザーが明示選択した
  // 値が勝つ。ピッカーでは空が「デフォルト (<言語の既定フォント名>)」として表示される。
  "codex.entryTitleFont": "",
  // AI
  "ai.inlineModel": "",
  "ai.sessionTitleModel": "",
  "ai.modelWhitelist": "[]",
  // 機能別モデル（ロール単位）。空 = 既定チャットモデルにフォールバック。
  "aiModel.role.conversation": "",
  "aiModel.role.agent": "",
  "aiModel.role.inline": "",
  "aiModel.role.cheap": "",
  "aiModel.role.structured": "",
  "aiModel.role.review": "",
  // 機能別モデルのプロバイダ横断マップ。既定は空 {} = 全ロール アクティブ provider。
  "aiModel.roleProviders": "{}",
  "ai.webSearch.domainMode": "off",
  "ai.webSearch.domains": "[]",
  "ai.webSearch.maxContentTokens": "",
  "ai.autoAcceptBodyProposals": "false",
  "ai.semanticRecall": "true",
  "ai.hybridRecall": "true",
  "ai.chatRecall": "true",
  "ai.contextBudget.l1": "2",
  "ai.contextBudget.l2": "10",
  "ai.contextBudget.l3": "40",
  "ai.contextBudget.l4": "20",
  "ai.contextBudget.l5": "20",
  "ai.contextBudget.reserve": "5",
  // 月予算 (USD)。0 = 未設定 (バー・残日数を表示しない)。
  "ai.costBudgetPerMonth": "0",
  // Beat AI context injection (Phase C)
  "beat.injectIntoContext": "true",
  "beat.inferRoles": "true",
  "beat.roleInferenceConfidenceThreshold": "0.7",
  // A/B 比較 (③) — 既定値 (空 = 未設定)
  "abTest.defaultModelB": "",
  "abTest.defaultPromptVariantB": "",
  // AI prompt customization addenda — 空 = 組み込みプロンプトのまま (byte-identical)
  "aiPrompt.custom.chat": "",
  "aiPrompt.custom.kouetsu": "",
  "aiPrompt.custom.foreshadow": "",
  "aiPrompt.custom.inline": "",
  "aiPrompt.custom.beat": "",
  "aiPrompt.custom.aiBranch": "",
  "aiPrompt.chronicle.enabled": "true",
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
  // Vivliostyle（本の書き出し）
  "vivliostyle.binaryPath": "",
  "vivliostyle.theme": "bunko-vertical",
  "vivliostyle.format": "pdf",
};

/**
 * Per-language overrides for the *defaults* only.
 *
 * When a project's `language` matches a key here, these values replace the
 * baseline `DEFAULT_SETTINGS` as the fallback — but an explicit user setting
 * still wins (precedence in settingsStore: DEFAULT < language override < user
 * layers). So no migration is needed: existing projects keep whatever they
 * set, and only *unset* keys pick up the language-appropriate default.
 *
 * `ja` has no entry (the baseline `DEFAULT_SETTINGS` is already Japanese-tuned).
 */
export const LANGUAGE_DEFAULT_OVERRIDES: Record<
  string,
  Record<string, string>
> = {
  en: {
    "editor.fontFamily": '"Literata"', // bundled latin serif (incl. italic)
    "editor.lineHeight": "1.6", // 2.0 is too airy for Latin prose
    "editor.smartQuotes": "true", // curly quotes are standard in English
    "editor.smartDashes": "true", // -- → em dash
    "editor.spellCheck": "true", // browser dict via document.lang=en
    "editor.paragraphIndent": "1", // first-line indent (em), English convention
    "editor.paragraphSpacing": "0", // indent instead of blank-line spacing
  },
};
