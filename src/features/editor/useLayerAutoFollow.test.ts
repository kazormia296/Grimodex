// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useSettingsStore } from "@/features/settings/settingsStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
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
  useKouetsuStore.setState({ activeTab: "issues" });
});

describe("useLayerAutoFollow", () => {
  it("ON中はパネル可視状態に完全追従し、設定へは書き込まない", () => {
    renderHook(() => useLayerAutoFollow(null));

    // 初期同期: 全パネル閉 → 追従レイヤーは全OFF
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);
    expect(useAnnotationStore.getState().showReaderComments).toBe(false);
    expect(useCursorSettingsStore.getState().showLint).toBe(false);
    expect(useCodexHighlightStore.getState().enabled).toBe(false);

    // kouetsu パネルを開く (指摘タブ) → 校閲の指摘 (校閲+Lint) のみON
    act(() => {
      __panelsMock.setState({ kouetsu: true });
    });
    expect(useAnnotationStore.getState().showAnnotations).toBe(true);
    expect(useCursorSettingsStore.getState().showLint).toBe(true);
    expect(useAnnotationStore.getState().showReaderComments).toBe(false);
    expect(useCursorSettingsStore.getState().showComments).toBe(false);

    // コメントタブへ切替 → コメント+読者コメントがON、指摘はOFF
    act(() => {
      useKouetsuStore.setState({ activeTab: "comments" });
    });
    expect(useAnnotationStore.getState().showReaderComments).toBe(true);
    expect(useCursorSettingsStore.getState().showComments).toBe(true);
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);
    expect(useCursorSettingsStore.getState().showLint).toBe(false);

    // ブロッカータブ → kouetsu系レイヤー全OFF
    act(() => {
      useKouetsuStore.setState({ activeTab: "blocker" });
    });
    expect(useAnnotationStore.getState().showReaderComments).toBe(false);
    expect(useCursorSettingsStore.getState().showComments).toBe(false);
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);

    act(() => {
      useKouetsuStore.setState({ activeTab: "issues" });
    });

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

  it("外部リセット (initFromSettings) 後、requestLayerAutoFollowSync で再同期する", () => {
    renderHook(() => useLayerAutoFollow(null));
    // 全パネル閉で auto 同期 → 全OFF
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);
    expect(useCursorSettingsStore.getState().showLint).toBe(false);

    // SettingsDialog close 相当: initFromSettings が手動基準値 (既定 true) へ
    // 巻き戻す。enabled とパネル可視は不変なので follow effect は自発しない
    // （layerAutoFollow は実環境では設定=true が読み戻される — ここでは触らず
    // annotation 側の巻き戻しと showLint の手動巻き戻しで再現する）。
    act(() => {
      useAnnotationStore.getState().initFromSettings();
      useCursorSettingsStore.setState({ showLint: true });
    });
    expect(useAnnotationStore.getState().showAnnotations).toBe(true); // 巻き戻った

    // nonce bump → follow effect が再実行されパネル可視状態 (閉) へ再同期
    act(() => {
      useCursorSettingsStore.getState().requestLayerAutoFollowSync();
    });
    expect(useAnnotationStore.getState().showAnnotations).toBe(false);
    expect(useAnnotationStore.getState().showReaderComments).toBe(false);
    expect(useCursorSettingsStore.getState().showLint).toBe(false);
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
