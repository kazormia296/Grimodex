// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { ScenePropertyGrid } from "./ScenePropertyGrid";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
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

const updatePovSpy = vi.fn();
const updateLocSpy = vi.fn();

function makeNode(overrides: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: "s1",
    nodeType: "scene",
    projectId: "p1",
    title: "シーン",
    povCharacterId: "c1",
    locationId: null,
    ...overrides,
  } as TreeNodeData;
}

beforeEach(() => {
  updatePovSpy.mockClear();
  updateLocSpy.mockClear();
  useTreeStore.setState({
    updatePovCharacter: updatePovSpy,
    updateLocation: updateLocSpy,
  } as never);
  useCodexStore.setState({
    entries: [
      { id: "c1", name: "千早", type: "character" },
      { id: "c2", name: "累", type: "character" },
      { id: "l1", name: "廃社", type: "location" },
    ],
  } as never);
});

describe("ScenePropertyGrid", () => {
  it("視点チップに解決済みの名前、場所チップに未設定を表示する", () => {
    render(<ScenePropertyGrid node={makeNode()} />);
    expect(screen.getByText("千早")).toBeTruthy();
    // 場所は未設定 / 日付も未設定
    expect(screen.getAllByText("editor.sceneDetail.notSet")).toHaveLength(2);
  });

  it("視点チップ → ピッカーで人物を選ぶと updatePovCharacter が呼ばれる", async () => {
    render(<ScenePropertyGrid node={makeNode()} />);
    fireEvent.click(screen.getByText("千早"));
    const picker = await screen.findByTestId("codex-ref-picker");
    expect(picker).toBeTruthy();
    fireEvent.click(screen.getByText("累"));
    expect(updatePovSpy).toHaveBeenCalledWith("s1", "c2");
    await waitFor(() => {
      expect(screen.queryByTestId("codex-ref-picker")).toBeNull();
    });
  });

  it("「指定なしにする」で null が渡る", async () => {
    render(<ScenePropertyGrid node={makeNode()} />);
    fireEvent.click(screen.getByText("千早"));
    const clear = await screen.findByText("editor.sceneDetail.clearSelection");
    fireEvent.click(clear);
    expect(updatePovSpy).toHaveBeenCalledWith("s1", null);
  });

  it("検索でピッカー候補が絞り込まれる", async () => {
    render(<ScenePropertyGrid node={makeNode()} />);
    fireEvent.click(screen.getByText("千早"));
    const input = await screen.findByLabelText(
      "editor.sceneDetail.searchCharacter",
    );
    fireEvent.change(input, { target: { value: "累" } });
    const picker = screen.getByTestId("codex-ref-picker");
    expect(picker.textContent).toContain("累");
    expect(picker.textContent).not.toContain("千早");
  });
});
