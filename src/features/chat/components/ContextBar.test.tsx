// @vitest-environment happy-dom
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextBar } from "./ContextBar";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedCodexEntryWithData } from "../chatApi";
import type { ChatPromptPreviewResult } from "../chatStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { runContextCreator } from "../contextCreatorApi";
import { useAiSettingsStore } from "../store";
import { DEFAULT_AI_SETTINGS } from "../types";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "../agent/dynamicModelCaps";

const chatStoreMocks = vi.hoisted(() => ({
  buildPreviewPrompt: vi.fn(),
}));

vi.mock("../chatStore", () => ({
  useChatStore: vi.fn(
    (
      selector: (state: {
        buildPreviewPrompt: typeof chatStoreMocks.buildPreviewPrompt;
      }) => unknown,
    ) =>
      selector({
        buildPreviewPrompt: chatStoreMocks.buildPreviewPrompt,
      }),
  ),
}));

vi.mock("../contextCreatorApi", () => ({
  runContextCreator: vi.fn(() => Promise.resolve([])),
}));

// AnimatePresence をスタブ化: happy-dom では exit アニメーションが完了せず
// 古い要素が DOM に残り続けるため、アニメーションなしで即時削除させる
vi.mock("motion/react", async () => {
  const { createElement } = await import("react");
  type P = Record<string, unknown> & { children?: React.ReactNode };
  const el =
    (tag: string) =>
    ({
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      children,
      ...rest
    }: P) =>
      createElement(tag, rest, children);
  return {
    motion: { div: el("div"), span: el("span") },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => false,
  };
});

afterEach(() => {
  useCodexStore.setState({ entries: [] });
  chatStoreMocks.buildPreviewPrompt.mockReset();
  vi.mocked(runContextCreator).mockReset().mockResolvedValue([]);
  globalThis.localStorage?.removeItem("grimodex.modelCaps.v2");
  globalThis.localStorage?.removeItem("grimodex.openrouterModelCaps.v1");
  __resetDynamicModelCapsForTests();
  useAiSettingsStore.setState({
    settings: null,
    models: [],
    modelCapsRevision: 0,
  });
});

function makeEntry(
  id: string,
  name: string,
  type = "character",
  parentId: string | null = null,
): CodexEntry {
  return {
    id,
    name,
    type,
    summary: "",
    content: "{}",
    contextMode: "auto",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectId: "p1",
    parentId,
    childrenBudget: "medium",
    tagsCache: null,
    aliases: null,
    excludedAliases: null,
    readings: null,
    sourceChatMessageId: null,
    notes: null,
    version: 0,
    icon: null,
  };
}

function makePinnedEntry(
  id: string,
  name: string,
  type = "character",
  withChildren = false,
): PinnedCodexEntryWithData {
  return {
    ...makeEntry(id, name, type),
    withChildren,
    pinnedType: "codex",
    pinSource: "manual",
  };
}

const defaultProps = {
  previewAuthorityKey: "workspace-a/project-a/scene-a",
  onReturnToAuto: vi.fn(),
  onRemove: vi.fn(),
  onRemoveAuto: vi.fn(),
  onPin: vi.fn(),
  pinnedCodexIds: new Set<string>(),
  pinnedSnippetIds: new Set<string>(),
  onPinEntry: vi.fn(),
  onUnpinEntry: vi.fn(),
  onTogglePinChildren: vi.fn(),
  contextTokenCount: 0,
  contextLayers: [],
  systemPrompt: "",
  model: "",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function readyPreview(
  prompt: string,
  totalTokens: number,
): ChatPromptPreviewResult {
  return {
    status: "ready",
    prompt,
    layers: [],
    totalTokens,
    contextWindowUsage: null,
    userMessage: "",
  };
}

describe("ContextBar model capability scope", () => {
  it("centers the pill row with equal vertical insets", () => {
    render(<ContextBar {...defaultProps} pinnedEntries={[]} />);
    expect(screen.getByTestId("context-bar-pills")).toHaveClass(
      "items-center",
      "pt-1",
      "pb-0.5",
    );
  });

  it("uses the provider-scoped Ollama window while no finalized override exists", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "gemma4:latest",
          name: "Gemma 4",
          contextLength: 131_072,
          supportedParameters: ["tools"],
        },
      ],
      { ollamaEndpoint: DEFAULT_AI_SETTINGS.ollamaEndpoint },
    );
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "gemma4:latest",
      },
      modelCapsRevision: 1,
    });

    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        contextTokenCount={1_000}
        model="gemma4:latest"
        provider="ollama"
      />,
    );

    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "1",
    );
  });

  it("does not reinterpret an explicit unknown window as the generic 8k fallback", () => {
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "unknown-local:latest",
      },
    });

    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        contextTokenCount={3_282}
        contextWindowOverride={null}
        model="unknown-local:latest"
        provider="ollama"
      />,
    );

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "実効コンテキスト容量が不明なため、使用率を計算できません",
      }),
    ).toHaveAttribute("data-testid", "context-window-unknown");
  });

  it("shows the full reserved request instead of only the visible context input", () => {
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        contextTokenCount={1_321}
        contextWindowOverride={4_096}
        contextWindowUsage={{
          contextTokens: 1_037,
          toolTokens: 5_591,
          envelopeTokens: 0,
          safetyMarginTokens: 32,
          inputTokens: 6_628,
          outputReservedTokens: 3_072,
          reservedTotalTokens: 9_732,
          contextWindow: 4_096,
          remainingTokens: -5_636,
          overflowTokens: 5_636,
          estimated: false,
        }}
        model="gemma4:latest"
        provider="ollama"
      />,
    );

    const tokenButton = screen.getByRole("button", {
      name: /~9,732 tokens/,
    });
    expect(tokenButton).toHaveAttribute(
      "title",
      expect.stringContaining("Agentツール 5,591"),
    );
    expect(tokenButton).toHaveAttribute(
      "title",
      expect.stringContaining("応答予約 3,072"),
    );

    const progress = screen.getByRole("progressbar", { name: /238%/ });
    expect(progress).toHaveAttribute("aria-valuenow", "100");
  });
});

describe("ContextBar グループ化", () => {
  it("chat_mention は表示中でも picker では未選択で、クリックを onPinEntry へ渡す", async () => {
    const user = userEvent.setup();
    const onPinEntry = vi.fn();
    const chatMention: PinnedCodexEntryWithData = {
      ...makeEntry("alice", "アリス"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "chat_mention",
    };
    useCodexStore.setState({
      entries: [makeEntry("alice", "アリス")],
    });
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[chatMention]}
        pinnedCodexIds={new Set()}
        onPinEntry={onPinEntry}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Codex/Snippet を Spotlight",
      }),
    );
    const checkbox = screen.getByRole("checkbox", { name: /アリス/ });
    expect(checkbox.closest("div.fixed")).toHaveClass("z-[9999]");
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);

    expect(onPinEntry).toHaveBeenCalledTimes(1);
    expect(onPinEntry).toHaveBeenCalledWith("alice", "codex");
  });

  it("scopeAnchor は picker で checked のまま変更不可になる", async () => {
    const user = userEvent.setup();
    useCodexStore.setState({
      entries: [makeEntry("alice", "アリス")],
    });
    render(
      <ContextBar
        {...defaultProps}
        scopeAnchor={{ kind: "codex", id: "alice", name: "アリス" }}
        pinnedEntries={[]}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Codex/Snippet を Spotlight",
      }),
    );

    const checkbox = screen.getByRole("checkbox", { name: /アリス/ });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
  });

  it("Spotlight が操作不能へ変わると trigger を無効化して開いた picker を閉じる", async () => {
    const user = userEvent.setup();
    useCodexStore.setState({
      entries: [makeEntry("alice", "アリス")],
    });
    const { rerender } = render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        spotlightDisabled={false}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Codex/Snippet を Spotlight",
    });

    await user.click(trigger);
    expect(
      screen.getByRole("checkbox", { name: /アリス/ }),
    ).toBeInTheDocument();

    rerender(
      <ContextBar {...defaultProps} pinnedEntries={[]} spotlightDisabled />,
    );

    expect(trigger).toBeDisabled();
    await waitFor(() => {
      expect(
        screen.queryByRole("checkbox", { name: /アリス/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("Spotlight が操作不能へ変わると AI context creator も無効化して閉じる", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        canUseCreator
        spotlightDisabled={false}
      />,
    );
    const creatorTrigger = screen.getByRole("button", {
      name: "AIコンテキスト提案",
    });

    await user.click(creatorTrigger);
    expect(
      screen.getByPlaceholderText("コンテキストに追加するものを指示..."),
    ).toBeInTheDocument();

    rerender(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        canUseCreator
        spotlightDisabled
      />,
    );

    expect(creatorTrigger).toBeDisabled();
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("コンテキストに追加するものを指示..."),
      ).not.toBeInTheDocument();
    });
  });

  it("AI context creator の複数選択を一つの batch として渡す", async () => {
    const user = userEvent.setup();
    const onPin = vi.fn(async () => {});
    const onPinBatch = vi.fn(async () => true);
    vi.mocked(runContextCreator).mockResolvedValueOnce([
      {
        id: "alice",
        name: "アリス",
        type: "character",
        summary: "",
        reason: "relevant",
        alreadyPinned: false,
      },
      {
        id: "bob",
        name: "ボブ",
        type: "character",
        summary: "",
        reason: "relevant",
        alreadyPinned: false,
      },
    ]);
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        canUseCreator
        onPin={onPin}
        onPinBatch={onPinBatch}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "AIコンテキスト提案" }),
    );
    const input = screen.getByPlaceholderText(
      "コンテキストに追加するものを指示...",
    );
    await user.type(input, "登場人物{Enter}");
    await user.click(
      await screen.findByRole("button", { name: "選択を追加 (2)" }),
    );

    expect(onPinBatch).toHaveBeenCalledWith(["alice", "bob"]);
    expect(onPin).not.toHaveBeenCalled();
  });

  it("AI context creator の batch が部分失敗すると dialog を閉じない", async () => {
    const user = userEvent.setup();
    const onPinBatch = vi.fn(async () => false);
    vi.mocked(runContextCreator).mockResolvedValueOnce([
      {
        id: "alice",
        name: "アリス",
        type: "character",
        summary: "",
        reason: "relevant",
        alreadyPinned: false,
      },
    ]);
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        canUseCreator
        onPinBatch={onPinBatch}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "AIコンテキスト提案" }),
    );
    const input = screen.getByPlaceholderText(
      "コンテキストに追加するものを指示...",
    );
    await user.type(input, "登場人物{Enter}");
    await user.click(
      await screen.findByRole("button", { name: "選択を追加 (1)" }),
    );

    expect(onPinBatch).toHaveBeenCalledWith(["alice"]);
    expect(input).toBeInTheDocument();
  });

  it("Spotlight が操作不能な間は表示済み pill の変更操作も無効化する", () => {
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[makePinnedEntry("alice", "アリス")]}
        detectedEntries={[makeEntry("bob", "ボブ")]}
        spotlightDisabled
      />,
    );

    expect(
      screen.getByRole("button", { name: "アリス を auto に戻す" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "アリス の Spotlight 解除" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "ボブ を Spotlight" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "ボブ の Spotlight 解除" }),
    ).toBeDisabled();
  });

  it("close/reopen と authority change 後の stale preview を表示・保存しない", async () => {
    const user = userEvent.setup();
    const closedRequest = deferred<ChatPromptPreviewResult>();
    const oldAuthorityRequest = deferred<ChatPromptPreviewResult>();
    const currentRequest = deferred<ChatPromptPreviewResult>();
    chatStoreMocks.buildPreviewPrompt
      .mockReturnValueOnce(closedRequest.promise)
      .mockReturnValueOnce(oldAuthorityRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);

    const { rerender } = render(
      <ContextBar
        {...defaultProps}
        previewAuthorityKey="workspace-a/project-a/scene-a"
        pinnedEntries={[]}
        contextTokenCount={1}
        systemPrompt="LIVE CACHE A"
      />,
    );

    await user.click(screen.getByRole("button", { name: /~1 tokens/ }));
    expect(
      screen.getByText(/プロンプトを構築中|Building prompt/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /閉じる|Close/ }));

    await user.click(screen.getByRole("button", { name: /~1 tokens/ }));
    expect(chatStoreMocks.buildPreviewPrompt).toHaveBeenCalledTimes(2);

    rerender(
      <ContextBar
        {...defaultProps}
        previewAuthorityKey="workspace-b/project-b/scene-b"
        pinnedEntries={[]}
        contextTokenCount={2}
        systemPrompt="LIVE CACHE B"
      />,
    );
    expect(
      screen.queryByText(/システムプロンプト プレビュー|System prompt preview/),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /~2 tokens/ }));
    expect(chatStoreMocks.buildPreviewPrompt).toHaveBeenCalledTimes(3);

    await act(async () => {
      closedRequest.resolve(readyPreview("STALE CLOSED PROMPT", 10));
      oldAuthorityRequest.resolve(readyPreview("STALE AUTHORITY PROMPT", 20));
      await Promise.all([closedRequest.promise, oldAuthorityRequest.promise]);
    });

    expect(
      screen.getByText(/プロンプトを構築中|Building prompt/),
    ).toBeInTheDocument();
    expect(screen.queryByText("STALE CLOSED PROMPT")).not.toBeInTheDocument();
    expect(
      screen.queryByText("STALE AUTHORITY PROMPT"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("LIVE CACHE B")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /テンプレート保存|Save template/,
      }),
    ).not.toBeInTheDocument();

    await act(async () => {
      currentRequest.resolve(readyPreview("CURRENT PROJECT B PROMPT", 30));
      await currentRequest.promise;
    });

    expect(screen.getByText("CURRENT PROJECT B PROMPT")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /テンプレート保存|Save template/ }),
    ).toBeInTheDocument();
  });

  it("preview request の予期しない reject を unavailable で終端する", async () => {
    const user = userEvent.setup();
    chatStoreMocks.buildPreviewPrompt.mockRejectedValueOnce(
      new Error("unexpected preview failure"),
    );
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        contextTokenCount={1}
        systemPrompt="LIVE CACHE MUST NOT ESCAPE"
      />,
    );

    await user.click(screen.getByRole("button", { name: /~1 tokens/ }));

    expect(
      await screen.findByText(
        /正確なプロンプトを構築できませんでした|exact prompt could not be built/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("LIVE CACHE MUST NOT ESCAPE"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /テンプレート保存|Save template/,
      }),
    ).not.toBeInTheDocument();
  });

  it("renders only items selected by the materialized ContextPlan", () => {
    const selected = makePinnedEntry("selected", "Selected");
    const trimmed = makePinnedEntry("trimmed", "Trimmed");
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[selected, trimmed]}
        contextPlan={
          {
            requestId: "request-1",
            items: [
              {
                key: "codex:selected",
                kind: "codex",
                authority: "canonical",
                priority: 3,
                stability: "turn-volatile",
                trim: { mode: "atomic", minTokens: 0, maxTokens: 1 },
                provenance: { sourceType: "codex-pin", sourceId: "selected" },
                payload: {
                  kind: "codex",
                  entry: {
                    id: "selected",
                    type: "character",
                    name: "Selected",
                    summary: "",
                  },
                  includePinnedExtras: true,
                },
              },
            ],
            decisions: [
              {
                key: "codex:selected",
                status: "selected",
                reason: "within-budget",
                tokensBefore: 1,
                tokensAfter: 1,
              },
              {
                key: "codex:trimmed",
                status: "trimmed",
                reason: "budget-priority",
                tokensBefore: 1,
                tokensAfter: 0,
              },
            ],
            usage: {
              candidateTokens: 2,
              selectedTokens: 1,
              trimmedTokens: 1,
              budgetTokens: 1,
            },
            digest: "ctx-test",
          } as never
        }
      />,
    );

    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("Selected")).toBeInTheDocument();
    expect(within(pills).queryByText("Trimmed")).not.toBeInTheDocument();
  });

  it("summarizes unavailable, trimmed, and excluded decisions with compact details", async () => {
    const user = userEvent.setup();
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        contextPlan={
          {
            requestId: "request-diagnostics",
            items: [],
            decisions: [
              {
                key: "codex:hidden",
                status: "excluded",
                reason: "hidden-by-policy",
                tokensBefore: 0,
                tokensAfter: 0,
              },
              {
                key: "source:semantic-recall:SEMANTIC_RECALL_UNAVAILABLE",
                status: "unavailable",
                reason: "semantic-recall-unavailable",
                tokensBefore: 0,
                tokensAfter: 0,
              },
              {
                key: "codex:optional",
                status: "trimmed",
                reason: "budget-priority",
                tokensBefore: 42,
                tokensAfter: 0,
              },
            ],
            usage: {
              candidateTokens: 42,
              selectedTokens: 0,
              trimmedTokens: 42,
              budgetTokens: 0,
            },
            digest: "ctx-diagnostics",
          } as never
        }
      />,
    );

    const summary = screen.getByTestId("context-decision-summary");
    expect(summary).toHaveAccessibleName("3 件を非注入");
    const contextHeader = screen.getByTestId("context-bar-toggle");
    expect(contextHeader).toHaveAttribute("aria-expanded", "true");
    summary.focus();
    await user.keyboard("{Enter}");
    expect(contextHeader).toHaveAttribute("aria-expanded", "true");

    const popover = screen.getByTestId("context-decision-popover");
    expect(within(popover).getByText("取得不可: 1")).toBeInTheDocument();
    expect(within(popover).getByText("予算により除外: 1")).toBeInTheDocument();
    expect(
      within(popover).getByText("ポリシーにより対象外: 1"),
    ).toBeInTheDocument();
    expect(
      within(popover).getByText(
        "source:semantic-recall:SEMANTIC_RECALL_UNAVAILABLE",
      ),
    ).toBeInTheDocument();
    expect(within(popover).getByText(/42 → 0 tokens/)).toBeInTheDocument();
  });

  it("keeps header actions independent from the collapse button", async () => {
    const user = userEvent.setup();
    const onCreateLinkedSession = vi.fn();
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        summaryCount={4}
        onCreateLinkedSession={onCreateLinkedSession}
      />,
    );

    const contextBar = screen.getByTestId("context-bar");
    const contextHeader = within(contextBar).getByTestId("context-bar-toggle");
    expect(contextHeader).toHaveAttribute("aria-expanded", "true");
    const createSession = within(contextBar).getByRole("button", {
      name: "4 回要約済み — 新セッション推奨",
    });
    createSession.focus();
    await user.keyboard("{Enter}");

    expect(onCreateLinkedSession).toHaveBeenCalledTimes(1);
    expect(contextHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("6件以下では個別ピルを表示する", () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      makePinnedEntry(`e${i}`, `エントリ${i}`),
    );
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("エントリ0")).toBeInTheDocument();
    expect(within(pills).getByText("エントリ5")).toBeInTheDocument();
    // グループピルは表示されない
    expect(within(pills).queryByText(/▾/)).not.toBeInTheDocument();
  });

  it("7件以上ではグループ化ピルを表示する", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makePinnedEntry(`l${i}`, `場所${i}`, "location"),
      ),
    ];
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    const pills = screen.getByTestId("pills-visible");
    // グループピルが表示される
    expect(
      within(pills).getByRole("button", { name: /キャラクター/ }),
    ).toBeInTheDocument();
    expect(
      within(pills).getByRole("button", { name: /場所/ }),
    ).toBeInTheDocument();
    // 個別エントリ名は非表示
    expect(within(pills).queryByText("キャラ0")).not.toBeInTheDocument();
  });

  it("グループピルクリックで個別エントリが展開される", async () => {
    const user = userEvent.setup();
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makePinnedEntry(`l${i}`, `場所${i}`, "location"),
      ),
    ];
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    const pills = screen.getByTestId("pills-visible");
    await user.click(
      within(pills).getByRole("button", { name: /キャラクター/ }),
    );
    const popup = screen.getByTestId("group-popup");
    expect(within(popup).getByText("キャラ0")).toBeInTheDocument();
    // 場所グループはまだ折りたたみ
    expect(within(pills).queryByText("場所0")).not.toBeInTheDocument();
  });

  it("別グループクリックで前のポップオーバーが閉じ新しいポップオーバーが開く", async () => {
    const user = userEvent.setup();
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makePinnedEntry(`l${i}`, `場所${i}`, "location"),
      ),
    ];
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    const pills = screen.getByTestId("pills-visible");
    await user.click(
      within(pills).getByRole("button", { name: /キャラクター/ }),
    );
    expect(
      within(screen.getByTestId("group-popup")).getByText("キャラ0"),
    ).toBeInTheDocument();
    await user.click(within(pills).getByRole("button", { name: /場所/ }));
    const popup = screen.getByTestId("group-popup");
    expect(within(popup).getByText("場所0")).toBeInTheDocument();
    // キャラクターグループのポップオーバーは閉じている
    expect(within(popup).queryByText("キャラ0")).not.toBeInTheDocument();
  });

  it("0件のグループは表示しない", () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      makePinnedEntry(`c${i}`, `キャラ${i}`, "character"),
    );
    render(<ContextBar {...defaultProps} pinnedEntries={entries} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText(/キャラクター/)).toBeInTheDocument();
    expect(within(pills).queryByText(/場所/)).not.toBeInTheDocument();
  });
});

describe("ContextBar 子エントリピル表示 (非グループモード)", () => {
  it("withChildren=false のエントリは子エントリピルを表示しない", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", false);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("親キャラ")).toBeInTheDocument();
    expect(within(pills).queryByText("子キャラ")).not.toBeInTheDocument();
  });

  it("withChildren=true のエントリは子エントリを通常ピルと同スタイルで via 表示する", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("親キャラ")).toBeInTheDocument();
    expect(within(pills).getByText("子キャラ")).toBeInTheDocument();
    expect(within(pills).getByText(/親キャラ 由来/)).toBeInTheDocument();
  });

  it("withChildren=true でも子がいなければ子ピルは表示されない", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({ entries: [] });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("親キャラ")).toBeInTheDocument();
    expect(within(pills).queryByText(/親キャラ 由来/)).not.toBeInTheDocument();
  });

  it("chat_mention (input-detected) エントリは子ピルへ自動展開しない", () => {
    const parent: PinnedCodexEntryWithData = {
      ...makeEntry("p1", "検出キャラ"),
      withChildren: false,
      pinnedType: "codex",
      pinSource: "chat_mention",
    };
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(<ContextBar {...defaultProps} pinnedEntries={[parent]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("検出キャラ")).toBeInTheDocument();
    expect(within(pills).queryByText("子キャラ")).not.toBeInTheDocument();
    expect(
      within(pills).queryByText(/検出キャラ 由来/),
    ).not.toBeInTheDocument();
  });

  it("子エントリが既に pinnedEntries に含まれる場合は via 表示しない（重複排除）", () => {
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    const childAsPinned = makePinnedEntry("c1", "子キャラ", "character", false);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(
      <ContextBar {...defaultProps} pinnedEntries={[parent, childAsPinned]} />,
    );
    // 子キャラはピン済みとして表示されるが via ラベルは付かない
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getAllByText("子キャラ")).toHaveLength(1);
    expect(within(pills).queryByText(/親キャラ 由来/)).not.toBeInTheDocument();
  });

  it("onDismissViaChild が渡された場合、via子エントリに X ボタンが表示される", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    const onDismissViaChild = vi.fn();
    const parent = makePinnedEntry("p1", "親キャラ", "character", true);
    useCodexStore.setState({
      entries: [makeEntry("c1", "子キャラ", "character", "p1")],
    });
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[parent]}
        onDismissViaChild={onDismissViaChild}
      />,
    );
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("子キャラ")).toBeInTheDocument();
    const dismissBtn = within(pills).getByRole("button", {
      name: /子キャラ の Spotlight 解除/,
    });
    await user.click(dismissBtn);
    expect(onDismissViaChild).toHaveBeenCalledWith("c1");
  });
});

describe("ContextBar outline chip (Phase 4 後続)", () => {
  it("projectOutline が空なら chip を表示しない", () => {
    render(<ContextBar {...defaultProps} pinnedEntries={[]} />);
    const pills = screen.getByTestId("pills-visible");
    expect(
      within(pills).queryByText(/Project outline/),
    ).not.toBeInTheDocument();
  });

  it("projectOutline が渡されると chip が表示される", () => {
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        projectOutline="全3部構成。テーマは復讐の代償。"
      />,
    );
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText("Project outline")).toBeInTheDocument();
  });

  it("chapterOutlines が祖先順で全件 chip 表示される", () => {
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        chapterOutlines={[
          { title: "第1部", outline: "outermost" },
          { title: "第3章", outline: "innermost" },
        ]}
      />,
    );
    const pills = screen.getByTestId("pills-visible");
    expect(within(pills).getByText(/第1部/)).toBeInTheDocument();
    expect(within(pills).getByText(/第3章/)).toBeInTheDocument();
  });

  it("chip クリックで outline 全文の popover が開く", async () => {
    const user = userEvent.setup();
    render(
      <ContextBar
        {...defaultProps}
        pinnedEntries={[]}
        projectOutline="全3部構成。テーマは復讐の代償。"
      />,
    );
    const pills = screen.getByTestId("pills-visible");
    await user.click(within(pills).getByText("Project outline"));
    expect(
      screen.getByText("全3部構成。テーマは復讐の代償。"),
    ).toBeInTheDocument();
  });
});
