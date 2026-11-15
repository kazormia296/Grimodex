// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { buildDefaultLayoutState } from "@/features/layout/layoutStateUtils";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/types";
import { readUiState } from "./uiState";

const SECRET = "SECRET-BODY-OR-KEY-31c9";

/** get_ui_state が返してよいトップレベルの項目（allowlist）。増やすときはこの表を意識的に変える。 */
const ALLOWED_KEYS = [
  "activeScene",
  "focusedPanel",
  "isPhoneWidth",
  "layoutLocked",
  "layoutPreset",
  "maximizedPanel",
  "openOverlay",
  "openPanels",
  "phoneSurface",
  "settings",
  "viewportProfile",
];

function sceneNode(id: string, title: string): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title,
    synopsis: SECRET,
    intent: SECRET,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    content: SECRET,
  } as unknown as TreeNodeData;
}

beforeEach(() => {
  document.body.innerHTML = "";
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    activePresetId: null,
    customPresets: [],
    maximizedPanelId: null,
    openOverlay: null,
    layoutLocked: false,
  });
  useTreeStore.setState({ nodes: [], activeSceneId: "" });
  useCompactNavigationStore.getState().reset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readUiState — allowlist", () => {
  it("返す項目は allowlist のものだけ（秘密を入れた store でも漏れない）", () => {
    useSettingsStore.setState({
      cache: {
        "ai.apiKey": SECRET,
        "ai.endpoint": SECRET,
        "ai.provider": SECRET,
      },
    });
    useTreeStore.setState({
      nodes: [sceneNode("s1", "第一章")],
      activeSceneId: "s1",
      projectId: "p1",
    });
    document.body.innerHTML = `<div data-viewport-profile="wide"><div data-settings-category="ai"></div></div>`;

    const state = readUiState(document);
    expect(Object.keys(state).sort()).toEqual(ALLOWED_KEYS);
    expect(Object.keys(state.settings).sort()).toEqual(["category", "open"]);
    expect(state.activeScene).toEqual({ id: "s1", title: "第一章" });
    expect(Object.keys(state.activeScene!).sort()).toEqual(["id", "title"]);
    expect(JSON.stringify(state)).not.toContain(SECRET);
  });

  it("シーンが無いとき activeScene は null", () => {
    expect(readUiState(document).activeScene).toBeNull();
  });
});

describe("readUiState — レイアウト", () => {
  it("開いているパネルと適用中のプリセットを返す", () => {
    useLayoutStore.getState().showPanel("chat");
    useLayoutStore.setState({ activePresetId: "builtin:plan" });
    const state = readUiState(document);
    expect(state.openPanels?.map((panel) => panel.id)).toContain("chat");
    expect(state.openPanels?.map((panel) => panel.id)).not.toContain("scenes");
    expect(state.layoutPreset).toEqual({
      id: "builtin:plan",
      name: "Plan",
      builtin: true,
    });
  });

  it("ユーザー定義のプリセットは名前を返す", () => {
    useLayoutStore.setState({
      activePresetId: "custom-1",
      customPresets: [
        {
          id: "custom-1",
          name: "夜の執筆",
          state: buildDefaultLayoutState({ allInactive: true }),
        },
      ],
    });
    expect(readUiState(document).layoutPreset).toEqual({
      id: "custom-1",
      name: "夜の執筆",
      builtin: false,
    });
  });
});

describe("readUiState — DOM の印", () => {
  it("印が無いときは推測せず null（不明）で返す", () => {
    const state = readUiState(document);
    expect(state.viewportProfile).toBeNull();
    expect(state.isPhoneWidth).toBeNull();
    expect(state.settings).toEqual({ open: null, category: null });
    expect(state.focusedPanel).toBeNull();
  });

  it("document が無い環境でも落ちない", () => {
    const state = readUiState(null);
    expect(state.viewportProfile).toBeNull();
    expect(state.settings.open).toBeNull();
  });

  it("Settings の開閉とカテゴリを読む。未知のカテゴリ値は採らない", () => {
    document.body.innerHTML = `<div data-viewport-profile="wide"></div>`;
    expect(readUiState(document).settings).toEqual({
      open: false,
      category: null,
    });
    document.body.innerHTML = `<div data-viewport-profile="wide"><div data-settings-category="keys"></div></div>`;
    expect(readUiState(document).settings).toEqual({
      open: true,
      category: "keys",
    });
    document.body.innerHTML = `<div data-viewport-profile="wide"><div data-settings-category="bogus"></div></div>`;
    expect(readUiState(document).settings.category).toBeNull();
  });

  it("phone 幅では配置ではなく表示中の画面を返す", () => {
    useLayoutStore.getState().showPanel("chat");
    useCompactNavigationStore.getState().openSurface("scenes");
    document.body.innerHTML = `<div data-viewport-profile="phone" data-mobile-workspace="true"></div>`;
    const state = readUiState(document);
    expect(state.viewportProfile).toBe("phone");
    expect(state.isPhoneWidth).toBe(true);
    expect(state.phoneSurface).toBe("scenes");
    expect(state.openPanels).toBeNull();

    document.body.innerHTML = `<div data-viewport-profile="compact"></div>`;
    const compact = readUiState(document);
    expect(compact.isPhoneWidth).toBe(false);
    expect(compact.phoneSurface).toBeNull();
    expect(compact.openPanels).not.toBeNull();
  });

  it("フォーカスがあるパネルを読む（未知のパネル ID は採らない）", () => {
    document.body.innerHTML = `
      <div data-viewport-profile="wide">
        <section data-slot-panel="chat"><input id="in-chat" /></section>
        <section data-slot-panel="not-a-panel"><input id="in-bogus" /></section>
        <div class="ProseMirror" tabindex="0" id="in-editor"></div>
      </div>`;
    document.getElementById("in-chat")!.focus();
    expect(readUiState(document).focusedPanel).toEqual({
      id: "chat",
      title: "チャット",
    });
    document.getElementById("in-bogus")!.focus();
    expect(readUiState(document).focusedPanel).toBeNull();
    document.getElementById("in-editor")!.focus();
    expect(readUiState(document).focusedPanel?.id).toBe("editor");
  });
});
