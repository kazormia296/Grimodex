// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  filterCommands,
  getInlineAiCommands,
  INLINE_AI_COMMANDS,
} from "./inlineAiCommands";

describe("filterCommands", () => {
  it("returns all commands for empty query", () => {
    expect(filterCommands("")).toHaveLength(INLINE_AI_COMMANDS.length);
  });

  it("filters by command id prefix", () => {
    const result = filterCommands("con");
    expect(result.some((c) => c.id === "continue")).toBe(true);
    expect(result.every((c) => c.id.startsWith("con"))).toBe(true);
  });

  it("returns empty array for no match", () => {
    const result = filterCommands("zzznomatch");
    expect(result).toHaveLength(0);
  });

  it("all commands have required fields", () => {
    for (const cmd of getInlineAiCommands()) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.label).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(["insert", "replace"]).toContain(cmd.mode);
    }
  });

  it("replace-mode commands all require selection", () => {
    const replaceCommands = INLINE_AI_COMMANDS.filter(
      (c) => c.mode === "replace",
    );
    expect(replaceCommands.every((c) => c.needsSelection)).toBe(true);
  });
});

describe("editor.inlineAiCommand setting gates the slash suggestion", () => {
  // 設定UIのみ存在し suggestion 側が読んでいなかった配線漏れの regression gate。
  // allow は "/" 入力のたびに評価されるため、実行時参照ならエディタ再生成なしで
  // トグルが効く。
  function getAllow(editor: Editor) {
    const ext = editor.extensionManager.extensions.find(
      (e) => e.name === "slashCommand",
    );
    const options = ext?.options as {
      suggestion: {
        allow: (props: {
          state: EditorState;
          range: { from: number; to: number };
        }) => boolean;
      };
    };
    return options.suggestion.allow;
  }

  function setInlineAiCommand(value: string) {
    useSettingsStore.setState((s) => ({
      cache: { ...s.cache, "editor.inlineAiCommand": value },
    }));
  }

  beforeEach(() => {
    setInlineAiCommand("true");
  });

  it("allows on an empty line by default", () => {
    const editor = new Editor({
      extensions: getEditorExtensions(),
      content: "<p>/</p>",
    });
    const allow = getAllow(editor);
    expect(allow({ state: editor.state, range: { from: 1, to: 2 } })).toBe(
      true,
    );
    editor.destroy();
  });

  it("blocks when the setting is off, and re-enables at runtime", () => {
    const editor = new Editor({
      extensions: getEditorExtensions(),
      content: "<p>/</p>",
    });
    const allow = getAllow(editor);
    setInlineAiCommand("false");
    expect(allow({ state: editor.state, range: { from: 1, to: 2 } })).toBe(
      false,
    );
    setInlineAiCommand("true");
    expect(allow({ state: editor.state, range: { from: 1, to: 2 } })).toBe(
      true,
    );
    editor.destroy();
  });
});
