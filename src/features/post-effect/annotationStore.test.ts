import { describe, expect, it, vi } from "vitest";
import { useAnnotationStore } from "./annotationStore";
import { useSettingsStore } from "@/features/settings/settingsStore";

describe("annotationStore live reader setting", () => {
  it("persists the live reader ON/OFF state independently of body layers", () => {
    const set = vi.fn();
    useSettingsStore.setState({ set } as never);
    useAnnotationStore.setState({
      liveReaderEnabled: true,
      showReaderComments: false,
    });

    useAnnotationStore.getState().setLiveReaderEnabled(false);

    expect(useAnnotationStore.getState().liveReaderEnabled).toBe(false);
    expect(useAnnotationStore.getState().showReaderComments).toBe(false);
    expect(set).toHaveBeenCalledWith("ai.liveReaderComments", "false");
  });

  it("起動時の初期化では保存済みの ON を毎回 OFF に戻す", () => {
    const set = vi.fn();
    const getBoolean = vi.fn(() => true);
    useSettingsStore.setState({ set, getBoolean } as never);
    useAnnotationStore.setState({ liveReaderEnabled: true });

    useAnnotationStore.getState().initFromSettings({ resetLiveReader: true });

    expect(useAnnotationStore.getState().liveReaderEnabled).toBe(false);
    expect(set).toHaveBeenCalledWith("ai.liveReaderComments", "false");
    expect(getBoolean).not.toHaveBeenCalledWith("ai.liveReaderComments", false);
  });

  it("通常の設定再同期では保存済みの ON を反映する", () => {
    const getBoolean = vi.fn(() => true);
    useSettingsStore.setState({ getBoolean } as never);
    useAnnotationStore.setState({ liveReaderEnabled: false });

    useAnnotationStore.getState().initFromSettings();

    expect(useAnnotationStore.getState().liveReaderEnabled).toBe(true);
    expect(getBoolean).toHaveBeenCalledWith("ai.liveReaderComments", false);
  });
});
