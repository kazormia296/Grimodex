/**
 * 実 Chromium で、エディタの分割の開閉の動きを gate する。
 *
 * - 開く: 寸法はすぐに半分になり、新しい欄は境界の辺から clip で広がる。
 * - 閉じる: 左の欄はすぐに全面になり、直前の半分から clip で広がる。
 * - 終われば clip-path を残さない（Glass が壊れる）。
 * - Zen・起動時の復元・動きを減らす設定では動かさない。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: vi.fn(async () => ({})),
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  isTauri: () => false,
}));
vi.mock("@/features/editor/Breadcrumb", () => ({
  Breadcrumb: () => <div data-breadcrumb />,
}));
vi.mock("@/features/editor/TabBar", () => ({
  TabBar: ({ groupIndex }: { groupIndex: number }) => (
    <div data-tab-bar={groupIndex} style={{ height: 28 }} />
  ),
  DRAG_DATA_KEY: "application/grimodex-tab",
  DRAG_GROUP_KEY: (group: number) => `application/grimodex-tab-g${group}`,
}));
vi.mock("@/features/editor/SceneMetaChipRow", () => ({
  SceneMetaChipRow: () => null,
}));
vi.mock("@/features/editor/EditorPane", () => ({
  EditorPane: ({ groupIndex }: { groupIndex: number }) => (
    <div data-editor-pane={groupIndex} style={{ height: "100%" }} />
  ),
}));
vi.mock("@/features/editor/LinearEditorView", () => ({
  LinearEditorView: () => <div data-linear-editor />,
}));
vi.mock("@/features/revision/RevisionHistoryModal", () => ({
  RevisionHistoryModal: () => null,
}));
vi.mock("@/features/editor/AsciiSplash", () => ({
  AsciiSplash: () => <div data-ascii-splash />,
}));
vi.mock("@/application/editor/openEditorDocument", () => ({
  openEditorDocument: vi.fn(),
}));
vi.mock("@/features/editor/editorNavigationPorts", () => ({
  defaultEditorNavigationPorts: {},
}));

import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { SceneEditor } from "./SceneEditor";
import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";

function setReduceMotion(on: boolean) {
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "display.reduceMotion": on ? "true" : "false" },
  }));
}

function group(container: HTMLElement, index: 0 | 1): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-editor-group="${index}"]`);
}

/** clip-path の inset の 4 値（px）。clip が無ければ null。 */
function insetOf(el: HTMLElement): number[] | null {
  const clip = el.style.clipPath;
  if (!clip) return null;
  return Array.from(clip.matchAll(/-?[\d.]+/g), (m) => Number(m[0]));
}

function renderEditor() {
  return render(
    <div style={{ width: 800, height: 400, display: "flex" }}>
      <SceneEditor />
    </div>,
  );
}

beforeEach(async () => {
  await page.viewport(1000, 600);
  setReduceMotion(false);
  useRevisionStore.setState({ isOpen: false });
  useCursorSettingsStore.setState({ zenMode: false });
  useSceneStore.setState({ activeSceneId: "scene-1" } as never);
  useTreeStore.setState({
    activeSceneId: "scene-1",
    nodes: [
      { id: "scene-1", nodeType: "scene", title: "One" },
      { id: "scene-2", nodeType: "scene", title: "Two" },
    ],
  } as never);
  useTabStore.setState({
    tabs: [{ nodeId: "scene-1", contentType: "scene", isPreview: false }],
    activeTabId: "scene-1",
    secondaryTabs: [
      { nodeId: "scene-2", contentType: "scene", isPreview: false },
    ],
    secondaryActiveTabId: "scene-2",
    secondaryGroupOpen: false,
    activeGroupIndex: 0,
    splitDirection: "right",
    isLinearMode: false,
    isDraggingTab: false,
    tabStateHydrated: true,
  } as never);
});

describe("editor split motion (real Chromium)", () => {
  it("opens the second group at its final size and reveals it from the split line", async () => {
    const { container } = renderEditor();
    const fullWidth = group(container, 0)!.getBoundingClientRect().width;

    act(() => {
      useTabStore.setState({ secondaryGroupOpen: true });
    });

    // 寸法はすぐに確定する（毎フレームの補間はしない）。
    expect(group(container, 0)!.getBoundingClientRect().width).toBeLessThan(
      fullWidth * 0.6,
    );
    const second = group(container, 1)!;
    const inset = insetOf(second);
    expect(inset).not.toBeNull();
    // 右の inset が大きい（左の辺＝境界から右へ広がる）。
    expect(inset![1]).toBeGreaterThan(
      second.getBoundingClientRect().width * 0.8,
    );

    await waitFor(() => {
      expect(second.style.clipPath).toBe("");
    });
    expect(getComputedStyle(second).clipPath).toBe("none");
  });

  it("widens the remaining group from its previous half when the split closes", async () => {
    useTabStore.setState({ secondaryGroupOpen: true });
    const { container } = renderEditor();

    act(() => {
      useTabStore.setState({ secondaryGroupOpen: false });
    });
    expect(group(container, 1)).toBeNull();
    const primary = group(container, 0)!;
    const inset = insetOf(primary);
    expect(inset).not.toBeNull();
    const width = primary.getBoundingClientRect().width;
    // 右半分が clip されている（直前の半分から広がる）。
    expect(inset![1]).toBeGreaterThan(width * 0.4);
    expect(inset![1]).toBeLessThan(width * 0.6);

    await waitFor(() => {
      expect(primary.style.clipPath).toBe("");
    });
  });

  it("reveals the lower group from the top edge for a below split", async () => {
    useTabStore.setState({ splitDirection: "below" });
    const { container } = renderEditor();

    act(() => {
      useTabStore.setState({ secondaryGroupOpen: true });
    });
    const second = group(container, 1)!;
    const inset = insetOf(second)!;
    // 下の inset が大きい（上の辺から下へ広がる）。
    expect(inset[2]).toBeGreaterThan(
      second.getBoundingClientRect().height * 0.8,
    );
  });

  it("does not animate while restoring tabs at startup", async () => {
    useTabStore.setState({ tabStateHydrated: false });
    const { container } = renderEditor();

    act(() => {
      useTabStore.setState({
        tabStateHydrated: true,
        secondaryGroupOpen: true,
      });
    });
    expect(group(container, 1)!.style.clipPath).toBe("");
  });

  it("does not animate in Zen or when motion is reduced", async () => {
    useCursorSettingsStore.setState({ zenMode: true });
    const zen = renderEditor();
    act(() => {
      useTabStore.setState({ secondaryGroupOpen: true });
    });
    expect(group(zen.container, 1)!.style.clipPath).toBe("");
    zen.unmount();

    useCursorSettingsStore.setState({ zenMode: false });
    useTabStore.setState({ secondaryGroupOpen: false });
    setReduceMotion(true);
    const reduced = renderEditor();
    act(() => {
      useTabStore.setState({ secondaryGroupOpen: true });
    });
    expect(group(reduced.container, 1)!.style.clipPath).toBe("");
  });
});
