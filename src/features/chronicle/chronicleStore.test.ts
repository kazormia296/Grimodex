import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useChronicleStore,
  loadAndSyncChronicleSettings,
} from "./chronicleStore";
import { invoke } from "@/lib/tauri";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

function reset() {
  useChronicleStore.setState({
    zoom: 1,
    scrollOffset: 0,
    showOffpage: true,
    selectedEventId: null,
  });
}

describe("chronicleStore persistent subscriber", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reset();
    vi.clearAllTimers();
    vi.mocked(invoke).mockResolvedValue({ chronicle: {} });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("zoom 変更で chronicle 設定の save IPC が発火する", async () => {
    useChronicleStore.getState().setZoom(2);
    await vi.runAllTimersAsync();
    expect(invoke).toHaveBeenCalledWith(
      "save_global_settings",
      expect.objectContaining({
        settings: expect.objectContaining({
          chronicle: expect.objectContaining({ zoom: 2 }),
        }),
      }),
    );
  });

  it("loadAndSync 後は save-back IPC を発火しない", async () => {
    loadAndSyncChronicleSettings({
      zoom: 3,
      scrollOffset: 10,
      showOffpage: false,
    });
    await vi.runAllTimersAsync();
    expect(invoke).not.toHaveBeenCalledWith(
      "save_global_settings",
      expect.anything(),
    );
    expect(useChronicleStore.getState().zoom).toBe(3);
    expect(useChronicleStore.getState().showOffpage).toBe(false);
  });

  it("setZoom は 0.25..4 にクランプ", () => {
    useChronicleStore.getState().setZoom(99);
    expect(useChronicleStore.getState().zoom).toBe(4);
    useChronicleStore.getState().setZoom(0.01);
    expect(useChronicleStore.getState().zoom).toBe(0.25);
  });
});

describe("chronicleStore 選択（単一/複数）", () => {
  beforeEach(() => {
    useChronicleStore.setState({ selectedEventId: null, selectedEventIds: [] });
    useExternalWriteStore.getState().clear();
  });
  afterEach(() => {
    useExternalWriteStore.getState().clear();
  });

  it("setSelectedEventId は集合 [id] と同期、null で全解除", () => {
    useChronicleStore.getState().setSelectedEventId("a");
    expect(useChronicleStore.getState().selectedEventIds).toEqual(["a"]);
    useChronicleStore.getState().setSelectedEventId(null);
    expect(useChronicleStore.getState().selectedEventId).toBeNull();
    expect(useChronicleStore.getState().selectedEventIds).toEqual([]);
  });

  it("setSelection は集合とプライマリを明示設定", () => {
    useChronicleStore.getState().setSelection(["a", "b", "c"], "b");
    expect(useChronicleStore.getState().selectedEventIds).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(useChronicleStore.getState().selectedEventId).toBe("b");
  });

  it("sanitizeSelection は実在 id へ整合（プライマリ生存なら維持）", () => {
    useChronicleStore.getState().setSelection(["a", "b", "c"], "b");
    useChronicleStore.getState().sanitizeSelection(new Set(["a", "b"]));
    expect(useChronicleStore.getState().selectedEventIds).toEqual(["a", "b"]);
    expect(useChronicleStore.getState().selectedEventId).toBe("b");
  });

  it("sanitizeSelection はプライマリが消えたら残りの末尾へ", () => {
    useChronicleStore.getState().setSelection(["a", "b", "c"], "b");
    useChronicleStore.getState().sanitizeSelection(new Set(["a", "c"]));
    expect(useChronicleStore.getState().selectedEventIds).toEqual(["a", "c"]);
    expect(useChronicleStore.getState().selectedEventId).toBe("c");
  });

  it("sanitizeSelection は全消失で空・null", () => {
    useChronicleStore.getState().setSelection(["a", "b"], "a");
    useChronicleStore.getState().sanitizeSelection(new Set(["z"]));
    expect(useChronicleStore.getState().selectedEventIds).toEqual([]);
    expect(useChronicleStore.getState().selectedEventId).toBeNull();
  });

  it("sanitizeSelection は変化なしなら配列参照を据え置く", () => {
    useChronicleStore.getState().setSelection(["a", "b"], "a");
    const before = useChronicleStore.getState().selectedEventIds;
    useChronicleStore.getState().sanitizeSelection(new Set(["a", "b"]));
    expect(useChronicleStore.getState().selectedEventIds).toBe(before);
  });

  it("dirty Event の外部競合中は選択変更と sanitize による owner unmount を拒否する", () => {
    useChronicleStore.getState().setSelectedEventId("event-a");
    useExternalWriteStore.getState().pushConflict({
      documentKey: { kind: "chronicle-event", id: "event-a" },
      sceneId: "event-a",
      domain: "event",
      opType: "event.delete",
      entityId: "event-a",
    });

    useChronicleStore.getState().setSelectedEventId("event-b");
    useChronicleStore.getState().sanitizeSelection(new Set(["event-b"]));

    expect(useChronicleStore.getState().selectedEventId).toBe("event-a");
    expect(useChronicleStore.getState().selectedEventIds).toEqual(["event-a"]);
  });

  it("scene:* 選択も canonical tree conflict が解決するまで維持する", () => {
    useChronicleStore.getState().setSelectedEventId("scene:scene-a");
    useExternalWriteStore.getState().pushConflict({
      documentKey: { kind: "tree", id: "scene-a", storage: "database" },
      sceneId: "scene-a",
      domain: "grid",
      opType: "tree.update",
      entityId: "scene-a",
    });

    useChronicleStore
      .getState()
      .setSelection(["scene:scene-b"], "scene:scene-b");

    expect(useChronicleStore.getState().selectedEventId).toBe("scene:scene-a");
  });
});
