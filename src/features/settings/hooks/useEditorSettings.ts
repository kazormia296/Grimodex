import { useSettingsStore } from "../settingsStore";

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  maxContentWidth: number;
  paragraphSpacing: number;
  typewriterMode: boolean;
  focusMode: boolean;
  autoSaveDelay: number;
  spellCheck: boolean;
  smartQuotes: boolean;
  smartDashes: boolean;
  inlineAiCommand: boolean;
  inlineAiShortcut: boolean;
  smoothCaret: boolean;
  cursorBlink: boolean;
  characterFadeIn: boolean;
  characterFadeOut: boolean;
  disableAllAnimations: boolean;
  wordBreak: string;
  lineBreak: string;
}

export function useEditorSettings(): EditorSettings {
  const store = useSettingsStore();
  return {
    fontFamily: store.get("editor.fontFamily", "serif"),
    fontSize: store.getNumber("editor.fontSize", 18),
    lineHeight: store.getNumber("editor.lineHeight", 2.0),
    maxContentWidth: store.getNumber("editor.maxContentWidth", 720),
    paragraphSpacing: store.getNumber("editor.paragraphSpacing", 8),
    typewriterMode: store.getBoolean("editor.typewriterMode", false),
    focusMode: store.getBoolean("editor.focusMode", false),
    autoSaveDelay: store.getNumber("editor.autoSaveDelay", 2000),
    spellCheck: store.getBoolean("editor.spellCheck", false),
    smartQuotes: store.getBoolean("editor.smartQuotes", false),
    smartDashes: store.getBoolean("editor.smartDashes", false),
    inlineAiCommand: store.getBoolean("editor.inlineAiCommand", true),
    inlineAiShortcut: store.getBoolean("editor.inlineAiShortcut", true),
    smoothCaret: store.getBoolean("editor.smoothCaret", true),
    cursorBlink: store.getBoolean("editor.cursorBlink", true),
    characterFadeIn: store.getBoolean("editor.characterFadeIn", false),
    characterFadeOut: store.getBoolean("editor.characterFadeOut", false),
    disableAllAnimations: store.getBoolean(
      "editor.disableAllAnimations",
      false,
    ),
    wordBreak: store.get("editor.wordBreak", "normal"),
    lineBreak: store.get("editor.lineBreak", "strict"),
  };
}
