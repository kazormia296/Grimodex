// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useSettingsStore } from "@/features/settings/settingsStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useCodexHighlightStore } from "./codexHighlightStore";
import { useLayerAutoFollow } from "./useLayerAutoFollow";
import * as layoutStoreModule from "@/features/layout/layoutStore";

// layoutStore を「パネルID→可視」の小さな zustand ストアで置き換え、
// テストから可視状態を driving できるようにする。
vi.mock("@/features/layout/layoutStore", async () => {
  const { create } = await import("zustand");
  const usePanelsMock = create<Record<string, boolean>>(() => ({}));
  const useLayoutStore = (
    selector: (s: { isPanelActive: (id: string) => boolean }) => unknown,
  ) =>
    usePanelsMock((panels) =>
      selector({ isPanelActive: (id: string) => panels[id] ?? false }),
    );
  useLayoutStore.getState = () => ({
    isPanelActive: (id: string) => usePanelsMock.getState()[id] ?? false,
  });
  return { useLayoutStore, __panelsMock: usePanelsMock };
});

const { __panelsMock } = layoutStoreModule as unknown as {
  __panelsMock: {
    setState: (s: Record<string, boolean>, replace?: boolean) => void;
    getState: () => Record<string, boolean>;
  };
};

const settingsSetSpy = vi.fn();

beforeEach(() => {
  settingsSetSpy.mockClear();
  __panelsMock.setState(
    { kouetsu: false, codex: false, attribution: false, foreshadow: false },
    true,
  );
  useSettingsStore.setState({ set: settingsSetSpy } as never);
  useCursorSettingsStore.setState({
    layerAutoFollow: true,
    showComments: false,
    showForeshadowMarks: false,
    showLint: true,
  });
  useAnnotationStore.setState({
    showAnnotations: true,
    showReaderComments: true,
  });
  useAttributionStore.setState({ showAttribution: false });
  useCodexHighlightStore.setState({ enabled: true });
});

describe("useLayerAutoFollow", () => {
  it("ON中はパネル可視状態に完全追従し、設定へは書き込まない", () => {
    renderHook(() => useLayerAutoFollow(null));

    // 初期同期: 全パネル閉 → 追従レイヤーは全OFF
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);
    expect(useAnnotationStore.getState().showReaderComments).toBe(false);
    expect(useCursorSettingsStore.getState().showLint).toBe(false);
    expect(useCodexHighlightStore.getState().enabled).toBe(false);

    // kouetsu パネルを開く → 校閲の指摘 (校閲+Lint) と読者コメントがON
    act(() => {
      __panelsMock.setState({ kouetsu: true });
    });
    expect(useAnnotationStore.getState().showAnnotations).toBe(true);
    expect(useAnnotationStore.getState().showReaderComments).toBe(true);
    expect(useCursorSettingsStore.getState().showLint).toBe(true);

    // codex / attribution / foreshadow パネル → 対応レイヤーがON
    act(() => {
      __panelsMock.setState({
        codex: true,
        attribution: true,
        foreshadow: true,
      });
    });
    expect(useCodexHighlightStore.getState().enabled).toBe(true);
    expect(useAttributionStore.getState().showAttribution).toBe(true);
    expect(useCursorSettingsStore.getState().showForeshadowMarks).toBe(true);

    // パネルを閉じると OFF に戻る
    act(() => {
      __panelsMock.setState({ kouetsu: false });
    });
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);
    expect(useCursorSettingsStore.getState().showLint).toBe(false);

    // 自動追従は display.layer* を一切永続化しない
    expect(settingsSetSpy).not.toHaveBeenCalled();
  });

  it("OFF中は追従しない (手動モード)", () => {
    useCursorSettingsStore.setState({ layerAutoFollow: false });
    renderHook(() => useLayerAutoFollow(null));

    expect(useAttributionStore.getState().showAttribution).toBe(false);
    act(() => {
      __panelsMock.setState({ attribution: true });
    });
    expect(useAttributionStore.getState().showAttribution).toBe(false);
    expect(useAnnotationStore.getState().showAnnotations).toBe(true); // 初期値のまま
  });

  it("ON→OFF で保存済み設定 (手動基準値) へ復元する", () => {
    renderHook(() => useLayerAutoFollow(null));
    // 全パネル閉で auto 同期 → 全OFF
    expect(useCodexHighlightStore.getState().enabled).toBe(false);
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);

    act(() => {
      useCursorSettingsStore.setState({ layerAutoFollow: false });
    });
    // initFromSettings 復元: 既定は layerReview/layerLint/codexHighlight=true
    expect(useAnnotationStore.getState().showAnnotations).toBe(true);
    expect(useAnnotationStore.getState().showReaderComments).toBe(true);
    expect(useCursorSettingsStore.getState().showLint).toBe(true);
    expect(useCodexHighlightStore.getState().enabled).toBe(true);
    expect(useAttributionStore.getState().showAttribution).toBe(false);
  });
});
