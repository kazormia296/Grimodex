// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "./extensions";
import { tateChuYokoKey } from "./TateChuYokoPlugin";

// settingsStore を制御可能にして縦書き/policy を切り替える。
let mockVertical = true;
let mockPolicy = "2";

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: (
    selector: (s: {
      getBoolean: (k: string, d: boolean) => boolean;
      get: (k: string, d: string) => string;
    }) => unknown,
  ) =>
    selector({
      getBoolean: (k, d) => (k === "editor.verticalMode" ? mockVertical : d),
      get: (k, d) => (k === "editor.tateChuYoko" ? mockPolicy : d),
    }),
}));

import { useTateChuYoko } from "./useTateChuYoko";

function makeEditor(): Editor {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
  });
}

function tcyPluginCount(editor: Editor): number {
  return editor.view.state.plugins.filter((p) => p.spec.key === tateChuYokoKey)
    .length;
}

describe("useTateChuYoko — 動的登録ライフサイクル", () => {
  beforeEach(() => {
    mockVertical = true;
    mockPolicy = "2";
  });

  it("縦書き && policy!=='off' で plugin を1つだけ登録する", () => {
    const editor = makeEditor();
    renderHook(() => useTateChuYoko(editor));
    expect(tcyPluginCount(editor)).toBe(1);
    editor.destroy();
  });

  it("横書きでは登録しない", () => {
    mockVertical = false;
    const editor = makeEditor();
    renderHook(() => useTateChuYoko(editor));
    expect(tcyPluginCount(editor)).toBe(0);
    editor.destroy();
  });

  it("policy='off' では登録しない", () => {
    mockPolicy = "off";
    const editor = makeEditor();
    renderHook(() => useTateChuYoko(editor));
    expect(tcyPluginCount(editor)).toBe(0);
    editor.destroy();
  });

  it("縦書きを ON→OFF→ON してもプラグインは重複せず追従する（リーク無し）", () => {
    const editor = makeEditor();
    const { rerender } = renderHook(() => useTateChuYoko(editor));
    expect(tcyPluginCount(editor)).toBe(1);

    // OFF: 前 render の cleanup が unregister するはず
    mockVertical = false;
    rerender();
    expect(tcyPluginCount(editor)).toBe(0);

    // ON 再度: 二重登録されず ちょうど1つ
    mockVertical = true;
    rerender();
    expect(tcyPluginCount(editor)).toBe(1);

    editor.destroy();
  });

  it("policy を '2'→'all' に変えても重複せずちょうど1つ（再登録）", () => {
    const editor = makeEditor();
    const { rerender } = renderHook(() => useTateChuYoko(editor));
    expect(tcyPluginCount(editor)).toBe(1);

    mockPolicy = "all";
    rerender();
    expect(tcyPluginCount(editor)).toBe(1);

    editor.destroy();
  });
});
