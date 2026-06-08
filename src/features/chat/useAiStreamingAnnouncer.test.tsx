// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

import { useAiStreamingAnnouncer } from "./useAiStreamingAnnouncer";
import { useChatStore } from "./chatStore";
import {
  getAnnouncerState,
  __resetAnnouncerForTest,
} from "@/lib/a11y/announcer";

function Harness() {
  useAiStreamingAnnouncer();
  return null;
}

describe("useAiStreamingAnnouncer", () => {
  beforeEach(() => {
    __resetAnnouncerForTest();
    useChatStore.setState({ isStreaming: false, error: null });
  });

  it("announces when streaming starts and again when it ends successfully", () => {
    render(<Harness />);
    expect(getAnnouncerState().polite).toBe("");

    act(() => {
      useChatStore.setState({ isStreaming: true, error: null });
    });
    const afterStart = getAnnouncerState().polite;
    expect(afterStart).toContain("生成");

    act(() => {
      useChatStore.setState({ isStreaming: false, error: null });
    });
    const afterEnd = getAnnouncerState().polite;
    expect(afterEnd).not.toBe(afterStart);
    expect(afterEnd).toContain("完了");
  });

  it("does NOT announce completion when the stream ended with an error (Sonner reads the toast)", () => {
    render(<Harness />);
    act(() => {
      useChatStore.setState({ isStreaming: true, error: null });
    });
    const afterStart = getAnnouncerState().polite;
    // error 付きで終了 → 完了 announce は出さない
    act(() => {
      useChatStore.setState({ isStreaming: false, error: "boom" });
    });
    expect(getAnnouncerState().polite).toBe(afterStart);
  });
});
