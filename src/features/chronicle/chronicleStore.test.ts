import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useChronicleStore,
  loadAndSyncChronicleSettings,
} from "./chronicleStore";
import { invoke } from "@/lib/tauri";

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
