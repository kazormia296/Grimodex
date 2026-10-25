// @vitest-environment happy-dom
// DA-2b の PUB-G 前の必須 3・4（DR-DA2B-R22、R24）：Mobile の chat も chat panel と同じ
// 3 状態で送信を閉じ、理由を示す（場面の会話の送信は開いたまま）。定数が false の間は
// 閉の状態があっても今のまま。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  get PROFILE_ACTIVATION_UI_ENABLED() {
    return flags.enabled;
  },
}));

import i18n from "@/lib/i18n";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "@/features/chat/store";
import { useChatStore } from "@/features/chat/chatStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  PROFILE_EGRESS_TRANSLATIONS,
  ensureProfileEgressTranslations,
} from "@/features/profile-egress/profileEgressTranslations";
import { ConnectedMobileWorkspaceSurface } from "./MobileWorkspaceSurfaces";
import { useCompactNavigationStore } from "./compactNavigationStore";

const en = PROFILE_EGRESS_TRANSLATIONS.en;

function chatSession(id: string, nodeId: string | null) {
  return {
    id,
    projectId: "project-1",
    nodeId,
    codexAnchorId: null,
    snippetAnchorId: null,
    title: id,
    titleManual: 0,
    model: "claude-test",
    createdAt: "2026-07-24T00:00:00Z",
    updatedAt: "2026-07-24T00:00:00Z",
  };
}

function setChat(patch: Record<string, unknown>) {
  useChatStore.setState({
    messages: [],
    sessions: [],
    activeSessionId: null,
    activeSceneId: "scene-1",
    isLoadingSessions: false,
    isLoadingMessages: false,
    isStreaming: false,
    chatScope: "scene",
    scopeAnchorId: null,
    threadFocusOverride: null,
    loadSessions: vi.fn().mockResolvedValue(true),
    selectSession: vi.fn().mockResolvedValue(undefined),
    createNewSession: vi.fn().mockResolvedValue(undefined),
    ...patch,
  } as never);
}

function renderSurface() {
  render(
    <ConnectedMobileWorkspaceSurface surface="ai" onOpenSettings={() => {}} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "draft" },
  });
  return screen.getByRole("button", { name: "Send" });
}

beforeEach(async () => {
  flags.enabled = true;
  await i18n.changeLanguage("en");
  ensureProfileEgressTranslations();
  useCompactNavigationStore.setState({
    activeSurface: "ai",
    backStack: [],
    sheet: null,
  });
  useProjectStore.setState({
    currentProjectId: "project-1",
    projects: [{ id: "project-1", aiPolicy: null }] as never,
  });
  useAiSettingsStore.setState({
    settings: { ...DEFAULT_AI_SETTINGS, provider: "anthropic", model: "m" },
    hasApiKey: true,
    profileEgressClosed: true,
  });
  useTreeStore.setState({ activeSceneId: "scene-1" } as never);
});

afterEach(async () => {
  cleanup();
  useAiSettingsStore.setState({ profileEgressClosed: undefined });
  await i18n.changeLanguage("ja");
});

describe("Mobile の chat の送信の閉鎖（定数 true、閉）", () => {
  it("会話のある場面の会話：送信は開き、aiClosed を示す", () => {
    setChat({
      activeSessionId: "chat-1",
      sessions: [chatSession("chat-1", "scene-1")],
    });
    expect(renderSurface()).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(en.chat.aiClosed);
  });

  it("会話の無い場面の会話：送信を閉じ、新しい会話の文を示す", () => {
    setChat({ activeSessionId: null });
    expect(renderSurface()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      en.chat.newConversationClosed,
    );
  });

  it("場面の会話でない会話：送信を閉じ、sendClosed を示す", () => {
    setChat({
      chatScope: "project",
      activeSessionId: "chat-2",
      sessions: [chatSession("chat-2", null)],
    });
    expect(renderSurface()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(en.chat.sendClosed);
  });
});

describe("開のとき、または定数が false の間", () => {
  it.each([
    ["開", true, undefined],
    ["定数 false", false, true],
  ] as const)("%s：会話の無い場面でも送信を閉じない", (_l, enabled, closed) => {
    flags.enabled = enabled;
    useAiSettingsStore.setState({ profileEgressClosed: closed });
    setChat({ activeSessionId: null });
    expect(renderSurface()).toBeEnabled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
