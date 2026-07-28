import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { Play } from "lucide-react";
import { useReducedMotion } from "@/lib/animation";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import {
  awaitChatComposerAuthority,
  captureChatComposerAuthority,
  useChatStore,
} from "./chatStore";
import { useMapBoardAutoActivate } from "./useMapBoardAutoActivate";
import { useMapStore } from "@/features/map/mapStore";
import { getMapBoard } from "@/features/map/mapApi";
import { useSceneStore } from "@/features/tree/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { ChatMessage } from "./components/ChatMessage";
import type { ChatContextMenuState } from "./components/ChatDialogs";
import { ChatDialogs } from "./components/ChatDialogs";
import { ChatPanelHeader } from "./components/ChatPanelHeader";
import { AccessibleChatTranscriptDialog } from "./components/AccessibleChatTranscriptDialog";
import { ChatInput } from "./components/ChatInput";
import { AgentProgressBar } from "./components/AgentProgressBar";
import { UserQuestionCard } from "./components/UserQuestionCard";
import { CodexApprovalCard } from "./components/CodexApprovalCard";
import { QuickActionStrip } from "./components/QuickActionStrip";
import { ChatRecallPromoteBanner } from "./components/ChatRecallPromoteBanner";
import { ContextBar } from "./components/ContextBar";
import { resolveModelCapabilities } from "./agent/modelLimits";
import { resolveAinoveristApiVariant } from "./aiNovelist";
import { computeSpotlightCandidates } from "./spotlightSuggestion";
import { CodexPopover } from "@/features/editor/CodexPopover";
import * as chatApi from "./chatApi";
import { listen } from "@/lib/tauri";
import { respondToCodexServerRequest } from "./codexAppApi";
import type { CodexAppEventEnvelope } from "@/../electron/shared/codexAppProtocol";
import { useAiSettingsStore, isRagCapableProvider } from "./store";
import { useRuntimeCapabilities } from "@/runtime/runtimeCapabilitiesContext";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { openAiPolicySettings } from "@/features/ai-policy/openAiPolicySettings";
import { useTreeStore } from "@/features/tree/treeStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  saveDocumentsForEntity,
  saveDocumentsForKind,
} from "@/features/editor/editorSaveRegistry";
import {
  flushAutoSavesForEntity,
  flushAutoSavesForKind,
} from "@/hooks/useAutoSave";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { resolveScopeSessionKey, type ChatScope } from "./chatScope";
import { recordMark, registerRuntimePerformanceControl } from "@/lib/perfLog";
import type { ChatMessage as ChatMessageType } from "./chatTypes";
import type { MessagePromptSnapshot } from "./chatApi";
import { MessageBubbleSkeletonList } from "@/components/ui/skeleton-patterns";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useChatSessionLifecycle } from "./useChatSessionLifecycle";
import { useChatPinsController } from "./useChatPinsController";
import { useChatMessageViewport } from "./useChatMessageViewport";
import {
  useChatMessageActions,
  wholeMessageContent,
} from "./useChatMessageActions";

/**
 * チャットのシーンスコープ選択からエディタへシーンを同期する。
 * Editor パネルが表示されている場合のみ、ツリーや他のパネルと同じ
 * navigation 経路で対象シーンを開く（tab を pinned で開いて active 化＋
 * Editor パネルを前面化）。非表示時はレイアウトに触れない —
 * openPinned は内部で ensureEditorVisible を呼ぶため、ガード外に出すと
 * 非表示の Editor が強制表示されてしまう。
 *
 * tree の active scene 更新はレイアウト非接触の純粋な state set。
 * その変化を ChatPanel の mirror effect が chatStore.activeSceneId に
 * 伝播するため、Editor 非表示でもチャットの scene anchor は追従する。
 */
export function selectSceneFromChat(sceneId: string): void {
  const editorVisible = useLayoutStore.getState().isPanelActive("editor");
  if (!editorVisible) {
    useTreeStore.getState().setActiveScene(sceneId);
    return;
  }
  openEditorDocument(
    {
      target: { kind: "scene", documentId: sceneId },
      mode: "pinned",
      revealEditor: true,
      focusEditor: false,
      syncSceneContext: true,
    },
    defaultEditorNavigationPorts,
  );
}

export type CodexApproval = {
  envelope: CodexAppEventEnvelope;
  request: Extract<
    CodexAppEventEnvelope["event"],
    { type: "approval-requested" }
  >;
};

function codexApprovalKey(approval: CodexApproval): string {
  const requestId = approval.request.requestId;
  return JSON.stringify([
    approval.envelope.projectId,
    approval.envelope.sessionId,
    approval.envelope.grimodexTurnId,
    typeof requestId,
    requestId,
  ]);
}

export function enqueueCodexApproval(
  current: CodexApproval[],
  approval: CodexApproval,
): CodexApproval[] {
  const key = codexApprovalKey(approval);
  return current.some((item) => codexApprovalKey(item) === key)
    ? current
    : [...current, approval];
}

export function removeCodexApproval(
  current: CodexApproval[],
  approval: CodexApproval,
): CodexApproval[] {
  const key = codexApprovalKey(approval);
  return current.filter((item) => codexApprovalKey(item) !== key);
}

export async function saveChatScopeBeforeSend(
  scope: ChatScope,
  activeSceneId: string | null | undefined,
  scopeAnchorId: string | null | undefined,
): Promise<void> {
  switch (scope) {
    case "scene":
      if (activeSceneId) {
        await saveDocumentsForEntity("tree", activeSceneId);
        await flushAutoSavesForEntity("tree", activeSceneId);
      }
      return;
    case "codex":
      if (scopeAnchorId) {
        await saveDocumentsForEntity("codex", scopeAnchorId);
        await flushAutoSavesForEntity("codex", scopeAnchorId);
      }
      return;
    case "snippet":
      if (scopeAnchorId) {
        await saveDocumentsForEntity("snippet", scopeAnchorId);
        await flushAutoSavesForEntity("snippet", scopeAnchorId);
      }
      return;
    case "folder":
    case "project":
      // Aggregated prompts and project-agent tools read Scene bodies from the
      // database. Every unsaved body is necessarily owned by a mounted tree
      // editor, so flush all current-Project tree variants before snapshotting.
      await saveDocumentsForKind("tree");
      await flushAutoSavesForKind("tree");
      return;
    default:
      scope satisfies never;
  }
}

export function removeCodexApprovalsForTurn(
  current: CodexApproval[],
  grimodexTurnId: string,
): CodexApproval[] {
  return current.filter(
    (item) => item.envelope.grimodexTurnId !== grimodexTurnId,
  );
}

export async function declineCodexApprovals(
  approvals: readonly CodexApproval[],
  respond: typeof respondToCodexServerRequest = respondToCodexServerRequest,
): Promise<void> {
  await Promise.allSettled(
    approvals.map((approval) =>
      respond({
        projectId: approval.envelope.projectId,
        sessionId: approval.envelope.sessionId,
        grimodexTurnId: approval.envelope.grimodexTurnId,
        requestId: approval.request.requestId,
        decision: "decline",
      }),
    ),
  );
}

interface ChatMessageViewportProps {
  activeSessionId: string | null;
  codexApproval: CodexApproval | null;
  onCodexApprovalDecision: (decision: "accept" | "decline") => Promise<void>;
  renderMessage: (message: ChatMessageType, isStreaming: boolean) => ReactNode;
}

type RuntimeChatStreamingDraftControl =
  | {
      action: "prepare";
      messageId: string;
      content: string;
    }
  | {
      action: "delta";
      messageId: string;
      delta: string;
    }
  | {
      action: "cleanup";
      messageId: string;
    };

function parseRuntimeChatStreamingDraftControl(
  payload: unknown,
): RuntimeChatStreamingDraftControl {
  if (!payload || typeof payload !== "object") {
    throw new Error("chat streaming draft control payload is invalid");
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    !["prepare", "delta", "cleanup"].includes(String(value.action))
  ) {
    throw new Error("chat streaming draft control payload is invalid");
  }
  if (value.action === "prepare" && typeof value.content === "string") {
    return {
      action: "prepare",
      messageId: value.messageId,
      content: value.content,
    };
  }
  if (value.action === "delta" && typeof value.delta === "string") {
    return {
      action: "delta",
      messageId: value.messageId,
      delta: value.delta,
    };
  }
  if (value.action === "cleanup") {
    return { action: "cleanup", messageId: value.messageId };
  }
  throw new Error("chat streaming draft control payload is invalid");
}

export function createRuntimeChatStreamingDraftControl() {
  let ownedDraft: { messageId: string; content: string } | null = null;

  const releaseOwnedDraft = () => {
    if (!ownedDraft) return;
    const current = useChatStore.getState();
    // A genuine stream may have started after benchmark preparation. Only
    // release the exact object installed by this controller; never clear or
    // stop a draft now owned by the user/provider path.
    if (current.isStreaming && current.streamingDraft === ownedDraft) {
      useChatStore.setState({
        isStreaming: false,
        streamingDraft: null,
      });
    }
    ownedDraft = null;
  };

  return {
    invoke(payload: unknown) {
      const control = parseRuntimeChatStreamingDraftControl(payload);
      const state = useChatStore.getState();

      if (control.action === "cleanup") {
        if (!ownedDraft || ownedDraft.messageId !== control.messageId) {
          throw new Error("chat streaming draft control is not prepared");
        }
        releaseOwnedDraft();
        return null;
      }

      if (
        !state.messages.some(
          (message) =>
            message.id === control.messageId && message.role === "assistant",
        )
      ) {
        throw new Error("chat streaming draft control message is not loaded");
      }

      if (control.action === "prepare") {
        if (ownedDraft) {
          throw new Error("chat streaming draft control is already prepared");
        }
        if (state.isStreaming || state.streamingDraft !== null) {
          throw new Error(
            "chat streaming draft control refused because a real chat stream is active",
          );
        }
        ownedDraft = {
          messageId: control.messageId,
          content: control.content,
        };
        useChatStore.setState({
          isStreaming: true,
          streamingDraft: ownedDraft,
        });
        return control.content;
      }

      if (
        !ownedDraft ||
        ownedDraft.messageId !== control.messageId ||
        !state.isStreaming ||
        state.streamingDraft !== ownedDraft
      ) {
        throw new Error(
          "chat streaming draft control lost ownership of the prepared draft",
        );
      }
      ownedDraft = {
        messageId: control.messageId,
        content: ownedDraft.content + control.delta,
      };
      useChatStore.setState({ streamingDraft: ownedDraft });
      return ownedDraft.content;
    },
    dispose: releaseOwnedDraft,
  };
}

/**
 * Message store + virtualizer の接続境界。row measurement や streaming draft が
 * 更新しても Header / ContextBar / Composer を含む ChatPanel 本体は再評価しない。
 */
function ChatMessageViewport({
  activeSessionId,
  codexApproval,
  onCodexApprovalDecision,
  renderMessage,
}: ChatMessageViewportProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const messages = useChatStore((state) => state.messages);
  const isLoadingMessages = useChatStore((state) => state.isLoadingMessages);
  const isStreaming = useChatStore((state) => state.isStreaming);
  const pendingUserQuestion = useChatStore(
    (state) => state.pendingUserQuestion,
  );
  const resolveUserQuestion = useChatStore(
    (state) => state.resolveUserQuestion,
  );
  const dismissUserQuestion = useChatStore(
    (state) => state.dismissUserQuestion,
  );
  const [messagesContainerEl, setMessagesContainerEl] =
    useState<HTMLElement | null>(null);
  const {
    bottomRef,
    scrollContainerRef,
    visibleMessages,
    virtualizer,
    entranceAnim,
    handleListScroll,
  } = useChatMessageViewport({
    messages,
    isLoadingMessages,
    activeSessionId,
  });
  const transcriptMessages = useMemo(
    () => messages.filter((message) => message.role !== "system"),
    [messages],
  );
  const transcriptPositionById = useMemo(
    () =>
      new Map(
        transcriptMessages.map((message, index) => [message.id, index + 1]),
      ),
    [transcriptMessages],
  );

  return (
    <>
      <CodexPopover containerEl={messagesContainerEl} />
      {!isLoadingMessages && transcriptMessages.length > 0 && (
        <AccessibleChatTranscriptDialog messages={transcriptMessages} />
      )}
      <div
        ref={scrollContainerRef}
        data-testid="chat-scroll-container"
        onScroll={handleListScroll}
        className="flex-1 overflow-y-auto px-4 py-3 [overflow-anchor:none]"
      >
        {isLoadingMessages ? (
          <MessageBubbleSkeletonList testId="chat-messages-loading" />
        ) : messages.length === 0 ? (
          <div className="mt-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t("chat.noMessages")}
            </p>
            <p className="mt-2 text-[11px] leading-tight text-muted-foreground/70">
              {t("chat.disclaimer")}
            </p>
          </div>
        ) : (
          <>
            <div
              data-testid="chat-virtual-list"
              role="list"
              aria-label={t("chat.transcript.virtualListLabel")}
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
              ref={setMessagesContainerEl}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const message = visibleMessages[virtualItem.index];
                if (!message) return null;
                const animateIn = entranceAnim.animateIds.has(message.id);
                return (
                  <div
                    key={message.id}
                    role="listitem"
                    aria-posinset={
                      transcriptPositionById.get(message.id) ??
                      virtualItem.index + 1
                    }
                    aria-setsize={transcriptMessages.length}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className="absolute left-0 top-0 w-full pb-4"
                    style={{
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <motion.div
                      data-animate-in={animateIn || undefined}
                      initial={animateIn ? { opacity: 0, x: 20 } : false}
                      animate={{ opacity: 1, x: 0 }}
                      transition={
                        reduced
                          ? { duration: 0 }
                          : { type: "spring", stiffness: 260, damping: 22 }
                      }
                    >
                      {renderMessage(message, isStreaming)}
                    </motion.div>
                  </div>
                );
              })}
            </div>
            {codexApproval && (
              <CodexApprovalCard
                key={codexApprovalKey(codexApproval)}
                request={codexApproval.request}
                onDecision={onCodexApprovalDecision}
              />
            )}
            {pendingUserQuestion &&
              pendingUserQuestion.sessionId === activeSessionId && (
                <UserQuestionCard
                  key={pendingUserQuestion.toolCallId}
                  spec={pendingUserQuestion.spec}
                  onSubmit={resolveUserQuestion}
                  onSkip={dismissUserQuestion}
                />
              )}
            {isStreaming && !pendingUserQuestion && (
              <div
                data-testid="streaming-indicator"
                className="flex items-center gap-1 text-muted-foreground"
              >
                <span className="animate-pulse text-xs">
                  {t("chat.generating")}
                </span>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>
    </>
  );
}

export function ChatPanel({ isActive = true }: SlotPanelProps = {}) {
  const runtimeCapabilities = useRuntimeCapabilities();
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const chatGate = useAiGate("chat");
  const activeWorkspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const workspaceOpenRevision = useWorkspaceStore(
    (s) => s.workspaceOpenRevision,
  );
  const chronicleRevision = useChronicleStore((s) => s.revisionCounter);
  useMapBoardAutoActivate();
  const isStreaming = useChatStore((s) => s.isStreaming);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const contextTokenCount = useChatStore((s) => s.contextTokenCount);
  const contextWindowSize = useChatStore((s) => s.contextWindowSize);
  const contextModel = useChatStore((s) => s.contextModel);
  const contextLayers = useChatStore((s) => s.contextLayers);
  const contextPlan = useChatStore((s) => s.contextPlan);
  const pinsVersion = useChatStore((s) => s.pinsVersion);
  const projectOutline = useChatStore((s) => s.projectOutline);
  const chapterOutlines = useChatStore((s) => s.chapterOutlines);
  const detectedEntries = useChatStore((s) => s.detectedEntries);
  const alwaysEntries = useChatStore((s) => s.alwaysEntries);
  const scopeAnchor = useChatStore((s) => s.scopeAnchor);
  const systemPrompt = useChatStore((s) => s.lastSystemPrompt);
  const setActiveSceneId = useChatStore((s) => s.setActiveSceneId);
  const refreshContextLayers = useChatStore((s) => s.refreshContextLayers);
  const dismissChatRecallPromote = useChatStore(
    (s) => s.dismissChatRecallPromote,
  );
  const removeEntryFromAuto = useChatStore((s) => s.removeEntryFromAuto);
  const excludeEntryFromAuto = useChatStore((s) => s.excludeEntryFromAuto);
  const clearAutoExclusion = useChatStore((s) => s.clearAutoExclusion);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const agentMode = useChatStore((s) => s.agentMode);
  const agentProgress = useChatStore((s) => s.agentProgress);
  const subAgentProgress = useChatStore((s) => s.subAgentProgress);
  const agentContinuation = useChatStore((s) => s.agentContinuation);
  const continueAgentRun = useChatStore((s) => s.continueAgentRun);
  const pendingUserQuestion = useChatStore((s) => s.pendingUserQuestion);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const selectSession = useChatStore((s) => s.selectSession);
  const createNewSession = useChatStore((s) => s.createNewSession);
  const ensureSession = useChatStore((s) => s.ensureSession);
  const activeProjectId = useChatStore((s) => s.activeProjectId);
  const chatScope = useChatStore((s) => s.chatScope);
  const scopeAnchorId = useChatStore((s) => s.scopeAnchorId);
  const threadFocusAuthority = useChatStore((s) =>
    s.threadFocusOverride
      ? JSON.stringify([
          s.threadFocusOverride.threadId,
          s.threadFocusOverride.title,
        ])
      : null,
  );
  const setChatScope = useChatStore((s) => s.setChatScope);
  const includeBodies = useChatStore((s) => s.includeBodies);
  const setIncludeBodies = useChatStore((s) => s.setIncludeBodies);
  const includeMapBoard = useChatStore((s) => s.includeMapBoard);
  const mapBoardIdFromStore = useChatStore((s) => s.mapBoardId);
  const setIncludeMapBoard = useChatStore((s) => s.setIncludeMapBoard);
  const ragEnabled = useChatStore((s) => s.ragEnabled);
  const setRagEnabled = useChatStore((s) => s.setRagEnabled);
  const [mapBoardTitle, setMapBoardTitle] = useState<string | null>(null);
  const [codexApprovals, setCodexApprovals] = useState<CodexApproval[]>([]);
  const codexApprovalsRef = useRef<CodexApproval[]>([]);
  const codexApprovalEpochRef = useRef(0);
  const sendPreparationRef = useRef(false);
  const updateCodexApprovals = useCallback(
    (update: (current: CodexApproval[]) => CodexApproval[]) => {
      const next = update(codexApprovalsRef.current);
      codexApprovalsRef.current = next;
      setCodexApprovals(next);
    },
    [],
  );
  const codexApproval = codexApprovals[0] ?? null;
  const syncInsertedToEditorMetadata = useChatStore(
    (s) => s.syncInsertedToEditorMetadata,
  );
  const createLinkedSession = useChatStore((s) => s.createLinkedSession);
  const dismissCacheInvalidated = useChatStore(
    (s) => s.dismissCacheInvalidated,
  );
  const summaryCount = useChatStore((s) => s.summaryCount);
  const maxSummaryGeneration = useChatStore((s) => s.maxSummaryGeneration);
  useEffect(() => {
    const control = createRuntimeChatStreamingDraftControl();
    const unregister = registerRuntimePerformanceControl(
      "chat.streamingDraft",
      control.invoke,
    );
    return () => {
      unregister();
      control.dispose();
    };
  }, []);
  const cacheInvalidatedReason = useChatStore((s) => s.cacheInvalidatedReason);

  // Phase 2: scene と folder スコープでは本文（または集約本文）が context に
  // 入るので、そこから検出された codex を ContextBar に出す。project スコープは
  // 本文集約しないので detect 系は無効。
  const showDetectedEntries = chatScope !== "project";

  // chatStore の activeSceneId (手動変更可能)
  const chatSceneId = useChatStore((s) => s.activeSceneId);

  // ツリーのアクティブシーン → chatStore に同期
  const treeActiveSceneId = useSceneStore((s) => s.activeSceneId);
  const sceneTitle = useTreeStore(
    (s) =>
      s.nodes.find((n) => n.id === treeActiveSceneId)?.title ??
      t("chat.fallbackSceneTitle"),
  );

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const chatModelOverride = useAiSettingsStore((s) => s.chatModelOverride);
  const loadAiSettings = useAiSettingsStore((s) => s.loadSettings);
  const aiModels = useAiSettingsStore((s) => s.models);
  // 動的 capability レジストリ（OpenRouter /models 等）更新時に再計算する。
  useAiSettingsStore((s) => s.modelCapsRevision);
  const currentModel =
    contextModel ?? chatModelOverride ?? aiSettings?.model ?? "";
  const contextPreviewAuthorityKey = useMemo(
    () =>
      JSON.stringify([
        isActive,
        activeWorkspacePath,
        workspaceOpenRevision,
        activeProjectId,
        activeSessionId,
        chatSceneId,
        chatScope,
        scopeAnchorId,
        threadFocusAuthority,
        chronicleRevision,
        contextPlan?.requestId ?? null,
        currentModel,
        agentMode,
        ragEnabled,
        includeBodies,
        includeMapBoard,
        mapBoardIdFromStore,
      ]),
    [
      isActive,
      activeWorkspacePath,
      workspaceOpenRevision,
      activeProjectId,
      activeSessionId,
      chatSceneId,
      chatScope,
      scopeAnchorId,
      threadFocusAuthority,
      chronicleRevision,
      contextPlan?.requestId,
      currentModel,
      agentMode,
      ragEnabled,
      includeBodies,
      includeMapBoard,
      mapBoardIdFromStore,
    ],
  );

  // Context Creator（AIコンテキスト提案）は Codex/Snippet 検索ツールを使う
  // エージェント実行のため、現在のモデル/プロバイダが Tool Use 対応のときだけ
  // 有効化する。判定は ChatInput の agent ゲートと同じ resolveModelCapabilities
  // 経路に揃える（CLI / AI のべりすと legacy 等のツール非対応プロバイダも反映）。
  const canUseCreator = resolveModelCapabilities(
    currentModel,
    aiSettings,
    resolveAinoveristApiVariant(
      currentModel,
      aiModels,
      aiSettings?.modelApiVariant,
    ),
  ).supportsTools;

  const [sessionsPanelOpen, setSessionsPanelOpen] = useState(false);
  const [inputHasText, setInputHasText] = useState(false);
  const chatEditorRef = useRef<Editor | null>(null);
  const allCodexEntries = useCodexStore((s) => s.entries);

  const {
    pinnedEntries,
    pinnedSnippets,
    pinnedStickies,
    pinnedIds,
    pinnedSnippetIds,
    inputPinnedEntries,
    inputPinnedIds,
    dismissedViaChildIds,
    handleDetectedEntries,
    resetInputDismissed,
    handlePin,
    handleUnpin,
    handleReturnToAuto,
    handleRemoveAuto,
    handleRemoveEntry,
    handleDismissViaChild,
    handleTogglePinChildren,
  } = useChatPinsController({
    isActive,
    activeSessionId,
    pinsVersion,
    allCodexEntries,
    ensureSession,
    removeEntryFromAuto,
    excludeEntryFromAuto,
    clearAutoExclusion,
    refreshContextLayers,
  });
  const contextBarProjection = useMemo(() => {
    const detected = showDetectedEntries
      ? detectedEntries.filter((entry) => !inputPinnedIds.has(entry.id))
      : [];
    const always = alwaysEntries.filter(
      (entry) => !inputPinnedIds.has(entry.id),
    );
    const allPinnedIds = new Set([...pinnedIds, ...inputPinnedIds]);
    return {
      detected,
      always,
      spotlightCandidateIds: computeSpotlightCandidates(
        showDetectedEntries ? detectedEntries : [],
        alwaysEntries,
        allPinnedIds,
      ),
    };
  }, [
    alwaysEntries,
    detectedEntries,
    inputPinnedIds,
    pinnedIds,
    showDetectedEntries,
  ]);

  useChatSessionLifecycle({
    isActive,
    treeActiveSceneId,
    chatScope,
    scopeAnchorId,
    activeSessionId,
    includeBodies,
    includeMapBoard,
    mapBoardId: mapBoardIdFromStore,
    agentMode,
    provider: aiSettings?.provider,
    currentModel,
    allCodexEntries,
    loadAiSettings,
    setActiveSceneId,
    loadSessions,
    selectSession,
    refreshContextLayers,
  });

  const {
    extractionDialog,
    snippetDialog,
    handleExtractCodexDetailed,
    handleExtractCodexQuick,
    handleSaveSnippetDetailed,
    handleSaveSnippetQuick,
    saveCodexExtraction,
    saveSnippetExtraction,
    closeCodexExtraction,
    closeSnippetExtraction,
    insertFromChat,
    handleEditMessage,
    handleDeleteMessage,
    handleRegenerate,
    handleRetryWithAgent,
  } = useChatMessageActions({
    aiSettings,
    chatEditorRef,
    syncInsertedToEditorMetadata,
  });
  // Context menu state
  const [contextMenu, setContextMenu] = useState<ChatContextMenuState | null>(
    null,
  );

  // 過去メッセージのプロンプト表示: 送信時に保存したスナップショットを遅延取得。
  const [promptViewOpen, setPromptViewOpen] = useState(false);
  const [promptViewSnapshot, setPromptViewSnapshot] =
    useState<MessagePromptSnapshot | null>(null);

  const handleViewPrompt = useCallback(
    (messageId: string) => {
      chatApi
        .getMessagePrompt(messageId)
        .then((snap) => {
          if (!snap) {
            toast.info(t("chat.context.promptSnapshotMissing"));
            return;
          }
          setPromptViewSnapshot(snap);
          setPromptViewOpen(true);
        })
        .catch(() => toast.error(t("chat.context.promptSnapshotError")));
    },
    [t],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, msg: ChatMessageType) => {
      const sel = window.getSelection();
      let selectedText: string | null = null;
      if (sel && !sel.isCollapsed) {
        const text = sel.toString().trim();
        if (text.length > 0) selectedText = text;
      }
      setContextMenu({
        messageId: msg.id,
        messageRole: msg.role === "user" ? "user" : "assistant",
        messageContent: wholeMessageContent(msg),
        selectedText,
        x: e.clientX,
        y: e.clientY,
      });
    },
    [],
  );

  const handleContextCopy = useCallback(
    (text: string, messageId: string) => {
      const msg = useChatStore
        .getState()
        .messages.find((message) => message.id === messageId);
      const source = msg?.role === "assistant" ? "ai" : "human";
      copyWithAttribution(text, source)
        .then(() => toast.success(t("chat.copied")))
        .catch(() => toast.error(t("chat.copyFailed")));
    },
    [t],
  );

  const handleSend = useCallback(
    async (
      markdown: string,
      options?: {
        overrideAgentMode?: boolean;
        mentionedSceneIds?: string[];
        commandInstruction?: string;
      },
    ): Promise<boolean> => {
      const trimmed = markdown.trim();
      if (
        !trimmed ||
        useChatStore.getState().isStreaming ||
        sendPreparationRef.current
      ) {
        return false;
      }
      sendPreparationRef.current = true;
      const authority = captureChatComposerAuthority();
      // スラッシュコマンド由来の一回限りの指示 (/brainstorm の VS 等) は
      // sendMessage の commandInstruction (L6) へ。残りは送信オプションとして渡す。
      const { commandInstruction, ...rest } = options ?? {};
      // Flush the active scope document so prompt construction reads the
      // latest Scene, Codex, or Snippet content from persistence.
      try {
        await saveChatScopeBeforeSend(chatScope, chatSceneId, scopeAnchorId);
        if (!(await awaitChatComposerAuthority(authority))) {
          toast.warning(t("chat.sendCancelledScopeChanged"));
          return false;
        }
        const send = sendMessage(trimmed, commandInstruction, rest);
        // sendMessage publishes its owned placeholders and isStreaming before
        // its first asynchronous context/tokenizer boundary. A false value here
        // means policy/loading/concurrent-send guards declined this draft.
        if (!useChatStore.getState().isStreaming) {
          await send;
          return false;
        }
        void send.then(
          () => resetInputDismissed(),
          (cause: unknown) => {
            resetInputDismissed();
            toast.error(
              t("chat.sendFailed", {
                message: cause instanceof Error ? cause.message : String(cause),
              }),
            );
          },
        );
        return true;
      } catch (cause) {
        toast.error(
          t("chat.sendFailed", {
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        );
        return false;
      } finally {
        sendPreparationRef.current = false;
      }
    },
    [
      sendMessage,
      chatScope,
      chatSceneId,
      scopeAnchorId,
      resetInputDismissed,
      t,
    ],
  );

  const handleScopeChange = useCallback(
    (scope: ChatScope, anchorId?: string | null) => {
      setChatScope(scope, anchorId);
    },
    [setChatScope],
  );

  const handleSelectScene = useCallback((sceneId: string) => {
    selectSceneFromChat(sceneId);
  }, []);

  const handleNewSession = useCallback(() => {
    if (isStreaming) return;
    const { nodeId, codexAnchorId, snippetAnchorId } = resolveScopeSessionKey(
      chatScope,
      chatSceneId,
      scopeAnchorId,
    );
    createNewSession(
      getCurrentProjectId(),
      "New session",
      nodeId === null ? undefined : nodeId,
      codexAnchorId,
      snippetAnchorId,
    );
  }, [createNewSession, chatScope, scopeAnchorId, chatSceneId, isStreaming]);

  // Map overlay chip 表示用の board title 取得。includeMapBoard が ON のとき
  // のみ fetch する（OFF 時に余計な DB アクセスを発生させない）。
  const activeBoardIdForChip = useMapStore((s) => s.activeBoardId);
  const resolvedMapBoardId = mapBoardIdFromStore ?? activeBoardIdForChip;
  // Map 注入トグルは Map panel が表示されている場合のみ有効。
  // `useMapBoardAutoActivate` と同じ `isPanelActive("map")` 述語で gate し、
  // overlay の auto-OFF と disabled 状態を一致させる。
  const mapPanelActive = useLayoutStore((s) => s.isPanelActive("map"));
  useEffect(() => {
    if (!includeMapBoard || !resolvedMapBoardId) {
      setMapBoardTitle(null);
      return;
    }
    let cancelled = false;
    getMapBoard(resolvedMapBoardId)
      .then((b) => {
        if (!cancelled) setMapBoardTitle(b?.title ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [includeMapBoard, resolvedMapBoardId]);

  // Approval requests are rendered outside the message virtualizer so a
  // session switch cannot leave an old request attached to another chat.
  useEffect(() => {
    const epoch = codexApprovalEpochRef.current + 1;
    codexApprovalEpochRef.current = epoch;
    codexApprovalsRef.current = [];
    setCodexApprovals([]);
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const projectId = activeProjectId ?? getCurrentProjectId();
    void listen<unknown>("codex-app:event", (raw) => {
      if (
        cancelled ||
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw)
      ) {
        return;
      }
      const envelope = raw as CodexAppEventEnvelope;
      if (
        envelope.projectId !== projectId ||
        envelope.sessionId !== activeSessionId ||
        typeof envelope.event !== "object" ||
        envelope.event === null
      ) {
        return;
      }
      if (envelope.event.type === "approval-requested") {
        const approval = { envelope, request: envelope.event };
        updateCodexApprovals((current) =>
          enqueueCodexApproval(current, approval),
        );
        return;
      }
      if (
        envelope.event.type === "turn-completed" ||
        (envelope.event.type === "turn-error" &&
          envelope.event.retryable !== true)
      ) {
        updateCodexApprovals((current) =>
          removeCodexApprovalsForTurn(current, envelope.grimodexTurnId),
        );
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      if (codexApprovalEpochRef.current === epoch) {
        codexApprovalEpochRef.current += 1;
      }
      const pendingApprovals = codexApprovalsRef.current;
      codexApprovalsRef.current = [];
      void declineCodexApprovals(pendingApprovals);
      unlisten?.();
    };
  }, [activeProjectId, activeSessionId, updateCodexApprovals]);

  const handleCodexApprovalDecision = useCallback(
    async (decision: "accept" | "decline") => {
      if (!codexApproval) return;
      const resolvedApproval = codexApproval;
      const responseEpoch = codexApprovalEpochRef.current;
      try {
        await respondToCodexServerRequest({
          projectId: codexApproval.envelope.projectId,
          sessionId: codexApproval.envelope.sessionId,
          grimodexTurnId: codexApproval.envelope.grimodexTurnId,
          requestId: codexApproval.request.requestId,
          decision,
        });
        if (codexApprovalEpochRef.current === responseEpoch) {
          updateCodexApprovals((current) =>
            removeCodexApproval(current, resolvedApproval),
          );
        }
      } catch (cause) {
        if (codexApprovalEpochRef.current !== responseEpoch) return;
        toast.error(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    [codexApproval, updateCodexApprovals],
  );
  const renderViewportMessage = useCallback(
    (message: ChatMessageType, streaming: boolean) => (
      <ChatMessage
        msg={message}
        isStreaming={streaming}
        onInsert={insertFromChat}
        onExtractCodexQuick={handleExtractCodexQuick}
        onExtractCodexDetailed={handleExtractCodexDetailed}
        onSaveSnippetQuick={handleSaveSnippetQuick}
        onSaveSnippetDetailed={handleSaveSnippetDetailed}
        onEdit={handleEditMessage}
        onDelete={handleDeleteMessage}
        onRegenerate={handleRegenerate}
        onRetryWithAgent={handleRetryWithAgent}
        onViewPrompt={handleViewPrompt}
        onContextMenu={handleContextMenu}
      />
    ),
    [
      handleContextMenu,
      handleDeleteMessage,
      handleEditMessage,
      handleExtractCodexDetailed,
      handleExtractCodexQuick,
      handleRegenerate,
      handleRetryWithAgent,
      handleSaveSnippetDetailed,
      handleSaveSnippetQuick,
      handleViewPrompt,
      insertFromChat,
    ],
  );

  const handleToggleMapOverlay = useCallback(() => {
    const next = !includeMapBoard;
    setIncludeMapBoard(next, {
      source: "user",
      boardId: next ? (resolvedMapBoardId ?? null) : null,
    });
  }, [includeMapBoard, resolvedMapBoardId, setIncludeMapBoard]);

  // Direct browser transports do not expose provider-managed Web search.
  // Keep the trial on the explicitly disclosed Local LLM/BYOK request only.
  const ragCapable =
    !runtimeCapabilities.browserDirectAi &&
    isRagCapableProvider(aiSettings?.provider);
  const handleToggleRag = useCallback(() => {
    setRagEnabled(!ragEnabled);
  }, [ragEnabled, setRagEnabled]);

  const __renderResult = (
    <div className="chat-panel-surface relative flex h-full flex-col bg-background">
      <ChatPanelHeader
        sessionsPanelOpen={sessionsPanelOpen}
        setSessionsPanelOpen={setSessionsPanelOpen}
        chatScope={chatScope}
        scopeAnchorId={scopeAnchorId}
        chatSceneId={chatSceneId}
        editorActiveSceneId={treeActiveSceneId}
        onScopeChange={handleScopeChange}
        onSelectScene={handleSelectScene}
        onNewSession={handleNewSession}
        sessionMutationsDisabled={isStreaming}
        includeBodies={includeBodies}
        onToggleIncludeBodies={() => setIncludeBodies(!includeBodies)}
        includeMapBoard={includeMapBoard}
        mapBoardTitle={mapBoardTitle}
        mapDisabled={!mapPanelActive}
        onToggleIncludeMapBoard={handleToggleMapOverlay}
        ragEnabled={ragEnabled}
        agentMode={agentMode}
        ragDisabled={!ragCapable}
        ragDisabledReason={
          runtimeCapabilities.browserDirectAi
            ? t("chat.webSearch.unavailableWebEditor")
            : undefined
        }
        onToggleRag={handleToggleRag}
      />

      <ContextBar
        previewAuthorityKey={contextPreviewAuthorityKey}
        scopeAnchor={scopeAnchor}
        contextPlan={contextPlan}
        pinnedEntries={[...pinnedEntries, ...inputPinnedEntries]}
        pinnedSnippets={pinnedSnippets}
        pinnedStickies={pinnedStickies}
        onUnpinSticky={async (stickyId) => {
          if (!activeSessionId) return;
          await chatApi.unpinStickyEntry(activeSessionId, stickyId);
          await useChatStore.getState().refreshContextLayers();
        }}
        detectedEntries={contextBarProjection.detected}
        alwaysEntries={contextBarProjection.always}
        spotlightCandidateIds={contextBarProjection.spotlightCandidateIds}
        onReturnToAuto={handleReturnToAuto}
        onRemove={handleRemoveEntry}
        onRemoveAuto={handleRemoveAuto}
        onPin={handlePin}
        onDismissViaChild={handleDismissViaChild}
        dismissedViaChildIds={dismissedViaChildIds}
        pinnedSnippetIds={pinnedSnippetIds}
        onPinEntry={handlePin}
        onUnpinEntry={handleUnpin}
        onTogglePinChildren={handleTogglePinChildren}
        contextTokenCount={contextTokenCount}
        contextWindowOverride={contextWindowSize}
        contextLayers={contextLayers}
        systemPrompt={systemPrompt}
        model={currentModel}
        canUseCreator={canUseCreator}
        projectOutline={projectOutline}
        chapterOutlines={chapterOutlines}
        summaryCount={summaryCount}
        maxSummaryGeneration={maxSummaryGeneration}
        onCreateLinkedSession={
          isStreaming ? undefined : () => void createLinkedSession()
        }
        cacheInvalidatedReason={cacheInvalidatedReason}
        onDismissCacheInvalidated={dismissCacheInvalidated}
      />

      <ChatMessageViewport
        activeSessionId={activeSessionId}
        codexApproval={codexApproval}
        onCodexApprovalDecision={handleCodexApprovalDecision}
        renderMessage={renderViewportMessage}
      />

      {error && (
        <div className="border-t border-destructive bg-destructive/10 px-4 py-2">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      {agentProgress && isStreaming && !pendingUserQuestion && (
        <AgentProgressBar
          calls={agentProgress.totalCalls}
          maxCalls={agentProgress.maxCalls}
          tokensUsed={agentProgress.tokensUsed}
          tokenBudget={agentProgress.tokenBudget}
          currentToolName={agentProgress.currentToolName}
          subProgress={
            subAgentProgress
              ? {
                  calls: subAgentProgress.totalCalls,
                  maxCalls: subAgentProgress.maxCalls,
                  currentToolName: subAgentProgress.currentToolName,
                }
              : null
          }
        />
      )}

      {agentContinuation &&
        agentContinuation.sessionId === activeSessionId &&
        !isStreaming &&
        !pendingUserQuestion && (
          <div className="border-t border-border bg-muted/30 px-4 py-2">
            <button
              type="button"
              onClick={() => void continueAgentRun()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
            >
              <Play className="h-3 w-3 shrink-0" aria-hidden />
              {t("chat.agentContinue")}
            </button>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("chat.agentContinueHint")}
            </p>
          </div>
        )}

      {chatGate.presentation === "hidden" ? (
        // chat がポリシーで OFF: composer 自体を隠す（モード扱い）。履歴は残す。
        // 「なぜ／変更」の導線として project 設定を開くリンクを置く
        // (エディタヘッダの AiPolicyBadge と同じ open-settings イベント)。
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {t("chat.aiOffNote")}{" "}
          <button
            type="button"
            onClick={openAiPolicySettings}
            className="underline hover:text-foreground"
          >
            {t("chat.aiOffOpenSettings")}
          </button>
        </div>
      ) : (
        <>
          <ChatRecallPromoteBanner
            onPromote={(messageId, text) => {
              handleExtractCodexDetailed(messageId, text);
              dismissChatRecallPromote(messageId);
            }}
          />
          <QuickActionStrip hidden={inputHasText} />

          <ChatInput
            onSend={handleSend}
            disabled={isStreaming}
            policyDisabled={chatGate.presentation !== "enabled"}
            editorRef={chatEditorRef}
            onDetectedEntries={handleDetectedEntries}
            onHasTextChange={setInputHasText}
          />
        </>
      )}

      <ChatDialogs
        extractionDialog={extractionDialog}
        snippetDialog={snippetDialog}
        onSaveCodex={saveCodexExtraction}
        onCloseCodex={closeCodexExtraction}
        onSaveSnippet={saveSnippetExtraction}
        onCloseSnippet={closeSnippetExtraction}
        sessionsPanelOpen={sessionsPanelOpen}
        sceneTitle={sceneTitle}
        activeSceneId={treeActiveSceneId}
        onCloseSessions={() => setSessionsPanelOpen(false)}
        contextMenu={contextMenu}
        contextMutationsDisabled={isStreaming}
        onCloseContextMenu={() => setContextMenu(null)}
        contextActions={{
          onInsert: insertFromChat,
          onExtractCodexQuick: handleExtractCodexQuick,
          onExtractCodexDetailed: handleExtractCodexDetailed,
          onSaveSnippetQuick: handleSaveSnippetQuick,
          onSaveSnippetDetailed: handleSaveSnippetDetailed,
          onCopy: handleContextCopy,
          onEdit: handleEditMessage,
          onDelete: handleDeleteMessage,
          onRegenerate: handleRegenerate,
        }}
        promptViewOpen={promptViewOpen}
        promptViewSnapshot={promptViewSnapshot}
        onClosePrompt={() => setPromptViewOpen(false)}
      />
    </div>
  );
  recordMark("chatPanel.render", performance.now() - __perfStart, __perfStart);
  return __renderResult;
}
