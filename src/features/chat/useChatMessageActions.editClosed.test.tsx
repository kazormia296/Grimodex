// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import i18next from "@/lib/i18n";
import { useChatStore } from "./chatStore";
import { useChatMessageActions } from "./useChatMessageActions";
import { resetNonSceneEditClosureForTest } from "./chatEgressClosure";
import {
  configureCloudRoute,
  configureOpenaiCompatibleRoute,
} from "./editCaptureRoute.testSupport";

function installBridge(state: string) {
  const invoke = vi.fn(async () => ({ ok: true, value: { state } }));
  (window as unknown as { grimodex?: unknown }).grimodex = {
    invoke,
    listen: vi.fn(() => () => undefined),
  };
  return invoke;
}

afterEach(() => {
  delete (window as unknown as { grimodex?: unknown }).grimodex;
});

function render(editClosed: boolean) {
  const editUserMessage = vi.fn(() => ({ content: "" }));
  // 場面の会話で、再送が capture の内の route（同期の経路。Electron の bridge があり、
  // loopback の OpenAI 互換）。状態の読取の経路は
  // `useChatMessageActions.nonSceneEdit.test.tsx`（DR-DA2B-R17、R29）。
  if (!(window as unknown as { grimodex?: unknown }).grimodex) {
    installBridge("restricted");
  }
  configureOpenaiCompatibleRoute();
  useChatStore.setState({
    agentMode: false,
    ragEnabled: false,
    editUserMessage,
    // 対象の行は一覧にある（同期の経路でも対象の確認を通る。R21）。
    activeProjectId: "p1",
    activeSessionId: "s1",
    isStreaming: false,
    messages: [
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        content: "question",
        createdAt: "2026-10-25T00:00:00.000Z",
      },
    ] as never,
    chatScope: "scene",
    activeSceneId: "scene-1",
    scopeAnchorId: null,
    threadFocusOverride: null,
  });
  const { result } = renderHook(() =>
    useChatMessageActions({
      aiSettings: null,
      // 本文を戻す先の editor（生きた stub）。無いと編集は行を消さずに止まる（R21）。
      chatEditorRef: {
        current: {
          isDestroyed: false,
          commands: { setContent: vi.fn(), focus: vi.fn() },
        },
      } as never,
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

  // PUB-G で定数を開けたとき（DR-DA2B-R20）：probe がまだ開でも、非場面の会話の編集の
  // 読取が閉なら、一般の文ではなく既存の理由の文（editClosed）を出す。
  it("定数が true で probe が開でも、読取が閉なら editClosed の理由を出す", async () => {
    enabled.value = true;
    toastInfo.mockClear();
    resetNonSceneEditClosureForTest();
    await import("@/lib/profileEgressStatus");
    const invoke = installBridge("restricted");
    const { result, editUserMessage } = render(false);
    useChatStore.setState({ chatScope: "project", activeSceneId: "" });
    result.current.handleEditMessage("m1");
    await vi.waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        i18next.t("profileEgress.chat.editClosed"),
      ),
    );
    expect(invoke).toHaveBeenCalledWith("get_profile_egress_status");
    expect(editUserMessage).not.toHaveBeenCalled();
  });

  // 表の 5（DR-DA2B-R29）：場面の会話で route が capture の外のときは、「場面の会話で
  // ない会話の」と言う editClosed ではなく、route の文（案）を出す。
  it("定数が true で、場面の会話の route が capture の外なら editClosedRoute を出す", async () => {
    enabled.value = true;
    toastInfo.mockClear();
    resetNonSceneEditClosureForTest();
    await import("@/lib/profileEgressStatus");
    const invoke = installBridge("restricted");
    const { result, editUserMessage } = render(false);
    configureCloudRoute();
    result.current.handleEditMessage("m1");
    await vi.waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        i18next.t("profileEgress.chat.editClosedRoute"),
      ),
    );
    expect(i18next.t("profileEgress.chat.editClosedRoute")).not.toBe(
      i18next.t("profileEgress.chat.editClosed"),
    );
    expect(invoke).toHaveBeenCalledWith("get_profile_egress_status");
    expect(editUserMessage).not.toHaveBeenCalled();
  });
});
