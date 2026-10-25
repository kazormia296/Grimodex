// @vitest-environment happy-dom
// DA-2b の PUB-G 前の必須 4（DR-DA2B-R24）：定数が true で閉のとき、chat panel の送信の
// 閉鎖と文言は 3 状態。会話の無い場面の会話では送信も閉じて別の文言を出し、
// aiClosed の文は会話のある場面の会話でだけ出す。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));
vi.mock("@/features/profile-egress/ProfileEgressChatClosureProbe", async () => {
  const { useEffect } = await import("react");
  return {
    default: function ClosedProbe({
      onChange,
    }: {
      onChange: (closed: boolean) => void;
    }) {
      useEffect(() => onChange(true), [onChange]);
      return null;
    },
  };
});

type InputProps = {
  policyDisabled?: boolean;
  editDisabled?: boolean;
  onSend?: (markdown: string) => Promise<boolean>;
};
const inputProps = vi.hoisted(() => [] as InputProps[]);
vi.mock("./components/ChatInput", () => ({
  ChatInput: (props: InputProps) => {
    inputProps.push(props);
    return <div data-testid="chat-input" />;
  },
}));

const listed = vi.hoisted(() => ({ sessions: [] as unknown[] }));
vi.mock("./chatApi", () => ({
  sendChatMessage: vi.fn(),
  sendChatMessageStream: vi.fn(),
  abortChatStream: vi.fn(() => Promise.resolve()),
  listSessions: vi.fn(() => Promise.resolve(listed.sessions)),
  getSessionForProject: vi.fn((id: string) =>
    Promise.resolve(
      listed.sessions.find((s) => (s as { id: string }).id === id) ?? null,
    ),
  ),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  listMessages: vi.fn(() => Promise.resolve([])),
  listSummaries: vi.fn(() => Promise.resolve([])),
  getSummaryGeneration: vi.fn(() => Promise.resolve(1)),
  addMessage: vi.fn(() => Promise.resolve({})),
  saveMessagePrompt: vi.fn(() => Promise.resolve()),
  updateSessionTitle: vi.fn(() => Promise.resolve()),
  listPinnedCodexEntries: vi.fn(() => Promise.resolve([])),
  listPinnedSnippetEntries: vi.fn(() => Promise.resolve([])),
  listPinnedStickyEntries: vi.fn(() => Promise.resolve([])),
  generateSessionTitle: vi.fn(() => Promise.resolve(null)),
  assertMessageMutationAllowed: vi.fn(),
  updateMessageMetadata: vi.fn(() => Promise.resolve()),
}));
vi.mock("./contextBuilder", async () => {
  const actual =
    await vi.importActual<typeof import("./contextBuilder")>(
      "./contextBuilder",
    );
  return { ...actual, ensureTokenizer: vi.fn(() => Promise.resolve()) };
});
vi.mock("@/features/editor/editorStore", async () => {
  const { create } = await import("zustand");
  return {
    useEditorStore: create(() => ({
      editor: null,
      lastInsertRange: null,
      insertFromChat: vi.fn(() => true),
      insertFromSnippet: vi.fn(() => true),
      clearInsertRange: vi.fn(),
      setEditor: vi.fn(),
    })),
  };
});
vi.mock("@/features/codex/api", () => ({
  listCodexEntries: vi.fn(() => Promise.resolve([])),
  listCodexEntriesForContext: vi.fn(() => Promise.resolve([])),
  listCodexContextMetadata: vi.fn(() => Promise.resolve([])),
  listCodexEntriesForContextByIds: vi.fn(() => Promise.resolve([])),
  listCodexMatchTargets: vi.fn(() => Promise.resolve([])),
  getCodexEntry: vi.fn(),
  listCodexEntriesByMessageId: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/features/snippets/api", () => ({
  listSnippets: vi.fn(() => Promise.resolve([])),
  getSnippet: vi.fn(),
  listSnippetsByMessageId: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/features/project/api", () => ({
  getProject: vi.fn((projectId: string) =>
    Promise.resolve({ id: projectId, title: "p", genre: "", language: "ja" }),
  ),
}));

import { ChatPanel } from "./ChatPanel";
import { useChatStore } from "./chatStore";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "./store";
import { useTreeStore } from "@/features/tree/treeStore";
import { useProjectStore } from "@/features/project/projectStore";
import {
  PROFILE_EGRESS_TRANSLATIONS,
  ensureProfileEgressTranslations,
} from "@/features/profile-egress/profileEgressTranslations";

const ja = PROFILE_EGRESS_TRANSLATIONS.ja.chat;

function session(id: string, nodeId: string | null) {
  return {
    id,
    projectId: "proj-1",
    title: id,
    titleManual: 0,
    model: "",
    nodeId,
    codexAnchorId: null,
    snippetAnchorId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function setChat(patch: Record<string, unknown>) {
  listed.sessions = (patch.sessions as unknown[] | undefined) ?? [];
  useChatStore.setState({
    messages: [],
    streamingDraft: null,
    sessions: [],
    isStreaming: false,
    isLoadingSessions: false,
    isLoadingMessages: false,
    error: null,
    chatScope: "scene",
    scopeAnchorId: null,
    threadFocusOverride: null,
    activeProjectId: "proj-1",
    activeSceneId: "scene-1",
    activeSessionId: null,
    inputPinnedEntryIds: [],
    ...patch,
  } as never);
}

async function closedNotice(): Promise<string> {
  const notice = await screen.findByTestId("chat-profile-egress-closed");
  return notice.textContent ?? "";
}

function lastInput() {
  return inputProps.at(-1)!;
}

beforeEach(() => {
  ensureProfileEgressTranslations();
  inputProps.length = 0;
  useAiSettingsStore.setState({
    settings: { ...DEFAULT_AI_SETTINGS, provider: "anthropic", model: "m" },
    hasApiKey: true,
    profileEgressClosed: undefined,
    // Keep the ready provider (the panel loads the settings on mount).
    loadSettings: async () => {},
  } as never);
  useTreeStore.setState({ projectId: "proj-1", activeSceneId: "scene-1" });
  useProjectStore.setState({
    currentProjectId: "proj-1",
    projects: [{ id: "proj-1", aiPolicy: null }] as never,
  });
});

describe("chat panel の送信の閉鎖（定数 true、閉）", () => {
  // DR-DA2B-R26：Enter の送信（keymap の onSubmit → onSend）は送信ボタンの無効化を
  // 通らない。閉鎖は onSend でも止まり、受け付けない（本文は入力欄に残る）。
  it.each([
    ["会話の無い場面の会話", { activeSessionId: null }],
    [
      "場面の会話でない会話",
      {
        chatScope: "project",
        activeSessionId: "s2",
        sessions: [session("s2", null)],
      },
    ],
  ] as const)("%s：Enter の送信も受け付けない", async (_label, patch) => {
    const sendMessage = vi.fn(async () => true);
    setChat({ ...patch, sendMessage });
    render(<ChatPanel />);
    await closedNotice();
    await waitFor(() => expect(lastInput().policyDisabled).toBe(true));
    await expect(lastInput().onSend!("本文")).resolves.toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("会話のある場面の会話：Enter の送信は今のまま受け付ける", async () => {
    const sendMessage = vi.fn(async () => true);
    setChat({
      activeSessionId: "s1",
      sessions: [session("s1", "scene-1")],
      sendMessage,
    });
    render(<ChatPanel />);
    expect(await closedNotice()).toBe(ja.aiClosed);
    await lastInput().onSend!("本文");
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  });

  it("会話の無い場面の会話：送信を閉じ、新しい会話の文を出す", async () => {
    setChat({ activeSessionId: null });
    render(<ChatPanel />);
    expect(await closedNotice()).toBe(ja.newConversationClosed);
    await waitFor(() => expect(lastInput().policyDisabled).toBe(true));
    expect(lastInput().editDisabled).toBe(false);
  });

  it("会話のある場面の会話：送信は開き、aiClosed を出す", async () => {
    setChat({
      activeSessionId: "s1",
      sessions: [session("s1", "scene-1")],
    });
    render(<ChatPanel />);
    expect(await closedNotice()).toBe(ja.aiClosed);
    await waitFor(() => expect(lastInput().policyDisabled).toBe(false));
    expect(lastInput().editDisabled).toBe(false);
  });

  it("場面の会話でない会話：送信と編集を閉じ、sendClosed を出す", async () => {
    setChat({
      chatScope: "project",
      activeSessionId: "s2",
      sessions: [session("s2", null)],
    });
    render(<ChatPanel />);
    expect(await closedNotice()).toBe(ja.sendClosed);
    await waitFor(() => expect(lastInput().policyDisabled).toBe(true));
    expect(lastInput().editDisabled).toBe(true);
  });
});
