// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// K3/2 "chat の書込みの入口" 4 (DR-DA2B-R6): while restricted, the edit-and-
// resend entrance of a conversation that is not a scene's is closed with its
// reason (the resend could not be saved; deletion stays). The closure is D
// wording behind `PROFILE_ACTIVATION_UI_ENABLED` (D-13 (a)): with the real
// constant (false) the entrance behaves as before.

const { enabled, toastInfo } = vi.hoisted(() => ({
  enabled: { value: true },
  toastInfo: vi.fn(),
}));
vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  get PROFILE_ACTIVATION_UI_ENABLED() {
    return enabled.value;
  },
}));
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: vi.fn() } }));

import { useChatStore } from "./chatStore";
import { useChatMessageActions } from "./useChatMessageActions";

function render(editClosed: boolean) {
  const editUserMessage = vi.fn(() => ({ content: "" }));
  // 場面の会話（同期の経路）。非場面の会話の状態の読取は
  // `useChatMessageActions.nonSceneEdit.test.tsx`（DR-DA2B-R17）。
  useChatStore.setState({
    editUserMessage,
    chatScope: "scene",
    activeSceneId: "scene-1",
    scopeAnchorId: null,
    threadFocusOverride: null,
  });
  const { result } = renderHook(() =>
    useChatMessageActions({
      aiSettings: null,
      chatEditorRef: { current: null },
      syncInsertedToEditorMetadata: vi.fn(),
      editClosed,
    }),
  );
  return { result, editUserMessage };
}

describe("the closed edit-and-resend entrance", () => {
  it("shows the reason and edits nothing while closed", () => {
    enabled.value = true;
    toastInfo.mockClear();
    const { result, editUserMessage } = render(true);
    result.current.handleEditMessage("m1");
    expect(editUserMessage).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps the edit when open", () => {
    enabled.value = true;
    const { result, editUserMessage } = render(false);
    result.current.handleEditMessage("m1");
    expect(editUserMessage).toHaveBeenCalledWith("m1");
  });

  it("keeps the edit with the real constant (false) even if a closure is passed", async () => {
    enabled.value = false;
    const actual = await vi.importActual<
      typeof import("@/features/profile-egress/profileActivationAvailability")
    >("@/features/profile-egress/profileActivationAvailability");
    expect(actual.PROFILE_ACTIVATION_UI_ENABLED).toBe(false);
    const { result, editUserMessage } = render(true);
    result.current.handleEditMessage("m1");
    expect(editUserMessage).toHaveBeenCalledWith("m1");
  });
});
