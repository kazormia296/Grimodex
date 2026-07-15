// @vitest-environment happy-dom
import { createRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexMatchRow } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { RubyNode } from "./RubyNode";
import { Toolbar, type ToolbarActions } from "./Toolbar";

const toastSpies = vi.hoisted(() => ({
  show: vi.fn(),
  dismiss: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(toastSpies.show, {
    dismiss: toastSpies.dismiss,
    success: toastSpies.success,
    error: toastSpies.error,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type ReadingTarget = CodexMatchRow & { readings: string | null };
type PromptToastOptions = {
  id?: string;
  closeButton?: boolean;
  action?: { label: string; onClick: () => void | Promise<void> };
  cancel?: { label: string; onClick: () => void };
};

const originalCodexUpdate = useCodexStore.getState().update;
const originalRegisterRubyReading =
  useCodexStore.getState().registerRubyReading;
const PROMPT_SETTING_KEY = "editor.promptCodexReadingOnRuby";

function target(
  name: string,
  aliases: string | null,
  readings: string | null,
  id = name,
): ReadingTarget {
  return {
    id,
    name,
    type: "character",
    aliases,
    excludedAliases: null,
    readings,
  };
}

function createEditor(text: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, RubyNode],
    content: `<p>${text}</p>`,
  });
  editor.commands.setTextSelection({ from: 1, to: text.length + 1 });
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 10,
    right: 10,
    top: 10,
    bottom: 20,
  });
  return editor;
}

function openRuby(editor: Editor, targets: ReadingTarget[]): void {
  useCodexStore.setState({ completionTargets: targets });
  const actionsRef = createRef<ToolbarActions>();
  render(
    <Toolbar
      editor={editor}
      onFindReplace={() => {}}
      actionsRef={actionsRef}
    />,
  );
  act(() => actionsRef.current?.openRuby());
}

function applyManualRuby(annotation: string): void {
  fireEvent.change(
    screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    { target: { value: annotation } },
  );
  fireEvent.click(screen.getByRole("button", { name: "common.ok" }));
}

function latestPromptOptions(): PromptToastOptions {
  const call = toastSpies.show.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call?.[1] as PromptToastOptions;
}

function setPromptSetting(value: boolean): void {
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, [PROMPT_SETTING_KEY]: String(value) },
    layers: {
      ...state.layers,
      global: {
        ...state.layers.global,
        [PROMPT_SETTING_KEY]: String(value),
      },
    },
  }));
}

afterEach(() => {
  cleanup();
  useCodexStore.setState({
    completionTargets: [],
    update: originalCodexUpdate,
    registerRubyReading: originalRegisterRubyReading,
  });
  for (const timer of useSettingsStore.getState()._timers.values()) {
    clearTimeout(timer);
  }
  useSettingsStore.setState({
    cache: { ...DEFAULT_SETTINGS },
    layers: { legacy: {}, project: {}, global: {} },
    _timers: new Map(),
    _pending: new Map(),
  });
  toastSpies.show.mockReset();
  toastSpies.dismiss.mockReset();
  toastSpies.success.mockReset();
  toastSpies.error.mockReset();
});

describe("Toolbar Codex reading ruby", () => {
  it("選択文字が Codex 名なら代表読みでルビを即時付与する", () => {
    const editor = createEditor("刹那");

    openRuby(editor, [
      target("刹那", '["セツナ"]', '{"刹那":["せつな","せちな"]}'),
    ]);

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "ruby", attrs: { base: "刹那", annotation: "せつな" } },
    ]);
    expect(
      screen.queryByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).not.toBeInTheDocument();
    expect(toastSpies.show).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("選択文字が alias なら alias 自身の読みで即時付与する", () => {
    const editor = createEditor("剣聖");

    openRuby(editor, [
      target("刹那", '["剣聖"]', '{"刹那":["せつな"],"剣聖":["けんせい"]}'),
    ]);

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "ruby", attrs: { base: "剣聖", annotation: "けんせい" } },
    ]);
    editor.destroy();
  });

  it("読みが未設定なら従来どおり入力ダイアログを開く", () => {
    const editor = createEditor("未知");

    openRuby(editor, [target("未知", null, null)]);

    expect(screen.getByPlaceholderText("editor.toolbar.rubyBase")).toHaveValue(
      "未知",
    );
    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "未知" },
    ]);
    editor.destroy();
  });

  it("同じ表記に異なる読みがある場合は自動付与せず入力ダイアログを開く", () => {
    const editor = createEditor("霞");

    openRuby(editor, [
      target("霞", null, '{"霞":["かすみ"]}', "first"),
      target("霞姫", '["霞"]', '{"霞":["かすみひめ"]}', "second"),
    ]);

    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "霞" },
    ]);
    editor.destroy();
  });

  it("hard break を跨ぐ見かけ上同じ表記は自動置換しない", () => {
    const editor = new Editor({
      extensions: [StarterKit, RubyNode],
      content: "<p>刹<br>那</p>",
    });
    editor.commands.setTextSelection({ from: 1, to: 4 });
    expect(editor.state.doc.textBetween(1, 4)).toBe("刹那");
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      left: 10,
      right: 10,
      top: 10,
      bottom: 20,
    });

    openRuby(editor, [target("刹那", null, '{"刹那":["せつな"]}')]);

    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "刹" },
      { type: "hardBreak" },
      { type: "text", text: "那" },
    ]);
    editor.destroy();
  });

  it("既存ルビの編集では Codex 読みで上書きせず現在値をダイアログに表示する", () => {
    const editor = new Editor({
      extensions: [StarterKit, RubyNode],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "ruby",
                attrs: { base: "刹那", annotation: "せちな" },
              },
            ],
          },
        ],
      },
    });
    editor.commands.setNodeSelection(1);
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      left: 10,
      right: 10,
      top: 10,
      bottom: 20,
    });

    openRuby(editor, [target("刹那", null, '{"刹那":["せつな"]}')]);

    expect(screen.getByPlaceholderText("editor.toolbar.rubyBase")).toHaveValue(
      "刹那",
    );
    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("せちな");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "ruby", attrs: { base: "刹那", annotation: "せちな" } },
    ]);
    editor.destroy();
  });

  it("手動ルビを一意な Codex alias の未設定読みとして登録できる", async () => {
    const editor = createEditor("剣聖");
    const registerRubyReading = vi.fn().mockResolvedValue(true);
    useCodexStore.setState({ registerRubyReading });

    openRuby(editor, [
      target("刹那", '["剣聖"]', '{"刹那":["せつな"]}', "setsuna"),
    ]);
    applyManualRuby("けんせい");

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "ruby", attrs: { base: "剣聖", annotation: "けんせい" } },
    ]);
    expect(toastSpies.show).toHaveBeenCalledTimes(1);
    const options = latestPromptOptions();
    expect(options.closeButton).toBe(true);
    expect(options.action?.label).toBe(
      "editor.toolbar.codexReadingPromptRegister",
    );
    expect(options.cancel?.label).toBe(
      "editor.toolbar.codexReadingPromptDisable",
    );

    await act(async () => {
      await options.action?.onClick();
    });

    expect(registerRubyReading).toHaveBeenCalledWith(
      "setsuna",
      "剣聖",
      "けんせい",
    );
    editor.destroy();
  });

  it("トーストのボタンから今後の読み登録確認を無効化できる", () => {
    const editor = createEditor("刹那");

    openRuby(editor, [target("刹那", null, null, "setsuna")]);
    applyManualRuby("せつな");
    act(() => latestPromptOptions().cancel?.onClick());

    expect(useSettingsStore.getState().getBoolean(PROMPT_SETTING_KEY)).toBe(
      false,
    );
    expect(toastSpies.dismiss).toHaveBeenCalled();
    editor.destroy();
  });

  it("Settings で確認を無効化している場合はトーストを出さない", () => {
    const editor = createEditor("刹那");
    setPromptSetting(false);

    openRuby(editor, [target("刹那", null, null, "setsuna")]);
    applyManualRuby("せつな");

    expect(toastSpies.show).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("空のルビや曖昧な複数 Codex には登録確認を出さない", () => {
    const emptyEditor = createEditor("刹那");
    openRuby(emptyEditor, [target("刹那", null, null, "setsuna")]);
    applyManualRuby("");
    expect(toastSpies.show).not.toHaveBeenCalled();
    cleanup();
    emptyEditor.destroy();

    const ambiguousEditor = createEditor("霞");
    openRuby(ambiguousEditor, [
      target("霞", null, null, "first"),
      target("霞姫", '["霞"]', null, "second"),
    ]);
    applyManualRuby("かすみ");
    expect(toastSpies.show).not.toHaveBeenCalled();
    ambiguousEditor.destroy();
  });

  it("確認後に別経路で読みが保存された場合は上書きしない", async () => {
    const editor = createEditor("刹那");
    const registerRubyReading = vi.fn().mockResolvedValue(true);
    useCodexStore.setState({ registerRubyReading });

    openRuby(editor, [target("刹那", null, null, "setsuna")]);
    applyManualRuby("せつな");
    const options = latestPromptOptions();
    useCodexStore.setState({
      completionTargets: [
        target("刹那", null, '{"刹那":["せちな"]}', "setsuna"),
      ],
    });

    await act(async () => {
      await options.action?.onClick();
    });

    expect(registerRubyReading).not.toHaveBeenCalled();
    editor.destroy();
  });
});
