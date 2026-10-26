// @vitest-environment happy-dom
// DD-1c（DR-DD1C-7）：ChatPanel の送信の受理から local 生成の start までの結線。定数が
// false の間は panel を mount せず、受理を渡さない。定数を true に差し替えると、受理の
// 時点の会話と Scene を panel の受け口に 1 回だけ渡し、受理されない送信では渡さない。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const nir1 = vi.hoisted(() => ({
  enabled: false,
  imported: 0,
  props: [] as Array<Record<string, unknown>>,
  accepted: [] as unknown[],
}));
vi.mock("./nir1/nir1LocalGenerationAvailability", () => ({
  get NIR1_LOCAL_GENERATION_UI_ENABLED() {
    return nir1.enabled;
  },
}));
vi.mock("./nir1/Nir1LocalGenerationPanel", async () => {
  nir1.imported += 1;
  const { useEffect } = await import("react");
  return {
    default: function PanelStub(props: {
      acceptedRef: { current: ((send: unknown) => void) | null };
    }) {
      nir1.props.push(props as unknown as Record<string, unknown>);
      useEffect(() => {
        props.acceptedRef.current = (send) => nir1.accepted.push(send);
      }, [props.acceptedRef]);
      return <div data-testid="nir1-panel-stub" />;
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

const LOCAL = "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

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
    activeSessionId: LOCAL,
    inputPinnedEntryIds: [],
    sessionsLoaded: true,
    ...patch,
  } as never);
}

/** A sendMessage that reports the acceptance (as a capture-only send does). */
function acceptingSend() {
  return vi.fn(
    async (
      _content: string,
      _instruction: unknown,
      options?: { _onAccepted?: () => void },
    ) => {
      options?._onAccepted?.();
      return true;
    },
  );
}

function lastInput() {
  return inputProps.at(-1)!;
}

beforeEach(() => {
  inputProps.length = 0;
  nir1.enabled = false;
  nir1.props.length = 0;
  nir1.accepted.length = 0;
  useAiSettingsStore.setState({
    settings: { ...DEFAULT_AI_SETTINGS, provider: "anthropic", model: "m" },
    hasApiKey: true,
    profileEgressClosed: undefined,
    loadSettings: async () => {},
  } as never);
  useTreeStore.setState({ projectId: "proj-1", activeSceneId: "scene-1" });
  useProjectStore.setState({
    currentProjectId: "proj-1",
    projects: [{ id: "proj-1", aiPolicy: null }] as never,
  });
});

describe("ChatPanel と local 生成の結線（DR-DD1C-7）", () => {
  it("定数が false の間：panel を要求せず、受理を渡さない", async () => {
    const sendMessage = acceptingSend();
    setChat({ sendMessage, sessions: [session(LOCAL, "scene-1")] });
    render(<ChatPanel />);
    await waitFor(() => expect(lastInput()).toBeDefined());
    await lastInput().onSend!("本文");
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(screen.queryByTestId("nir1-panel-stub")).toBeNull();
    expect(nir1.imported).toBe(0);
    expect(nir1.accepted).toEqual([]);
  });

  it("定数を true に差し替えると、受理の時点の会話と Scene を 1 回だけ渡す", async () => {
    nir1.enabled = true;
    const sendMessage = acceptingSend();
    setChat({ sendMessage, sessions: [session(LOCAL, "scene-1")] });
    render(<ChatPanel />);
    await screen.findByTestId("nir1-panel-stub");
    expect(nir1.props.at(-1)).toMatchObject({
      conversationId: LOCAL,
      sceneId: "scene-1",
    });
    await lastInput().onSend!("本文");
    await waitFor(() => expect(nir1.accepted).toHaveLength(1));
    expect(nir1.accepted[0]).toEqual({
      conversationId: LOCAL,
      sceneId: "scene-1",
    });
  });

  it("受理されない送信では渡さない", async () => {
    nir1.enabled = true;
    const sendMessage = vi.fn(async () => true);
    setChat({ sendMessage, sessions: [session(LOCAL, "scene-1")] });
    render(<ChatPanel />);
    await screen.findByTestId("nir1-panel-stub");
    await lastInput().onSend!("本文");
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(nir1.accepted).toEqual([]);
  });

  it("panel から会話を開くと、chat の会話の選択に渡す", async () => {
    nir1.enabled = true;
    const selectSession = vi.fn(async () => {});
    setChat({ selectSession, sessions: [session(LOCAL, "scene-1")] });
    render(<ChatPanel />);
    await screen.findByTestId("nir1-panel-stub");
    const open = nir1.props.at(-1)!.onOpenConversation as (id: string) => void;
    open(LOCAL);
    expect(selectSession).toHaveBeenCalledWith(LOCAL);
  });
});
