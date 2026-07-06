// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useEditorStore } from "./editorStore";
import { SceneMetaChipRow } from "./SceneMetaChipRow";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: unknown) =>
      opts && typeof opts === "object" && "count" in opts
        ? `${k}:${(opts as { count: number }).count}`
        : k,
    i18n: { language: "ja" },
  }),
}));

vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({
          initial: _i,
          animate: _a,
          transition: _t,
          exit: _e,
          ...rest
        }: Record<string, unknown>) =>
          createElement(tag, rest as object),
    },
  ),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  useReducedMotion: () => false,
}));

const settingsSetSpy = vi.fn();

function stubPanelOpen(open: boolean) {
  useSettingsStore.setState({
    getBoolean: (key: string, def: boolean) =>
      key === "editor.sceneMetaPanelOpen" ? open : def,
    set: settingsSetSpy,
  } as never);
}

function seedScene(overrides: Partial<TreeNodeData> = {}) {
  const node = {
    id: "s1",
    nodeType: "scene",
    projectId: "p1",
    title: "シーン",
    povCharacterId: "c1",
    locationId: "l1",
    synopsis: "千早が帰還する。",
    ...overrides,
  } as TreeNodeData;
  useTreeStore.setState({
    nodes: [node],
    activeSceneId: "s1",
  } as never);
}

beforeEach(() => {
  settingsSetSpy.mockClear();
  stubPanelOpen(false);
  useCursorSettingsStore.setState({ focusMode: false });
  useEditorStore.setState({ editor: null } as never);
  useCodexStore.setState({
    entries: [
      { id: "c1", name: "千早", type: "character" },
      { id: "l1", name: "廃社", type: "location" },
    ],
  } as never);
  seedScene();
});

describe("SceneMetaChipRow の表示条件", () => {
  it("パネルが閉じているシーンで表示される", () => {
    render(<SceneMetaChipRow />);
    expect(screen.getByTestId("scene-meta-chip-row")).toBeTruthy();
    expect(screen.getByText("千早")).toBeTruthy();
    expect(screen.getByText("廃社")).toBeTruthy();
    expect(screen.getByText("千早が帰還する。")).toBeTruthy();
  });

  it("パネルが開いていると出ない", () => {
    stubPanelOpen(true);
    render(<SceneMetaChipRow />);
    expect(screen.queryByTestId("scene-meta-chip-row")).toBeNull();
  });

  it("フォーカスモード中は出ない", () => {
    useCursorSettingsStore.setState({ focusMode: true });
    render(<SceneMetaChipRow />);
    expect(screen.queryByTestId("scene-meta-chip-row")).toBeNull();
  });

  it("scene 以外のノードでは出ない", () => {
    seedScene({ nodeType: "note" } as Partial<TreeNodeData>);
    render(<SceneMetaChipRow />);
    expect(screen.queryByTestId("scene-meta-chip-row")).toBeNull();
  });
});

describe("SceneMetaChipRow の操作", () => {
  it("ビートチップでパネルを開く", () => {
    render(<SceneMetaChipRow />);
    fireEvent.click(screen.getByText("editor.sceneDetail.beatsChip:0"));
    expect(settingsSetSpy).toHaveBeenCalledWith(
      "editor.sceneMetaPanelOpen",
      "true",
    );
  });

  it("視点チップでピッカーが開く", async () => {
    render(<SceneMetaChipRow />);
    fireEvent.click(screen.getByText("千早"));
    expect(await screen.findByTestId("codex-ref-picker")).toBeTruthy();
  });

  it("あらすじチップでポップオーバーが開く", async () => {
    render(<SceneMetaChipRow />);
    fireEvent.click(screen.getByText("千早が帰還する。"));
    expect(await screen.findByTestId("synopsis-chip-popover")).toBeTruthy();
  });
});
