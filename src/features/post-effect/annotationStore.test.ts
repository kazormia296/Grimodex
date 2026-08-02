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
});
