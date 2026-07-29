import type { CodexContextEntry } from "@/features/codex/api";
import type { ChatMessage } from "@/features/chat/chatTypes";
import type { ChatScope } from "@/features/chat/chatScope";
import type {
  ContextPlanningPurpose,
  TurnContextBudget,
} from "@/features/chat/context/prepareTurn";
import type { RecalledMessageForPromotion } from "@/features/chat/context/contextPlannerDeps";
import type { NonSceneScopeAnchor } from "@/features/chat/context/sources/nonSceneContextSource";
import type { ChatContextPlan } from "@/features/chat/context/types";
import type { LayerBreakdown } from "@/features/chat/contextBuilder";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";

export type ChatContextPrivacy = "private" | "public-web";

export interface ChatContextThreadFocus {
  threadId: string;
  title: string;
}

/**
 * Chat-owned values captured by the calling surface. Concrete feature stores
 * are deliberately absent; the composition snapshots those synchronously.
 */
export interface ChatContextPreparationInput {
  requestId: string;
  purpose: ContextPlanningPurpose;
  privacy: ChatContextPrivacy;
  projectId: string;
  sessionId: string | null;
  effectiveSceneId: string | null;
  activeSceneId: string;
  activeProjectId: string | null;
  chatScope: ChatScope;
  scopeAnchorId: string | null;
  threadFocus: ChatContextThreadFocus | null;
  mode: "chat" | "agent";
  agentToolsAvailable: boolean;
  route: ResolvedChatTurnRoute | null;
  budget: TurnContextBudget;
  messages: readonly ChatMessage[];
  outgoingUserMessage: string;
  commandInstruction?: string;
  mentionedSceneIds: readonly string[];
  mentionedCodexIds: readonly string[];
  inputPinnedEntryIds: readonly string[];
  excludedAutoEntryIds: readonly string[];
  sessionStableCodexIds: readonly string[];
  sessionStableContextInitialized: boolean;
  includeBodies: boolean;
  includeMapBoard: boolean;
  mapBoardId: string | null;
  trackRecallPromote: boolean;
  /**
   * Preview/copy preserve the former fallback chain:
   * composer -> latest user message -> current scene body tail.
   */
  allowSceneRecallSeedFallback: boolean;
}

export type ChatContextPreparationSnapshotInput = Pick<
  ChatContextPreparationInput,
  | "privacy"
  | "projectId"
  | "effectiveSceneId"
  | "activeSceneId"
  | "activeProjectId"
  | "chatScope"
  | "scopeAnchorId"
  | "threadFocus"
  | "includeMapBoard"
  | "mapBoardId"
>;

/** Opaque composition-owned snapshot captured before a send can yield. */
export interface ChatContextPreparationSnapshot {
  readonly value: unknown;
}

/** Opaque snapshot used only to suppress stale UI publication. */
export interface ChatContextPreparationAuthority {
  readonly chronicleRevision: number;
}

export interface PreparedChatContext {
  privacy: ChatContextPrivacy;
  prompt: string;
  totalTokens: number;
  layers: LayerBreakdown[];
  contextPlan: ChatContextPlan;
  cacheSegments?: string[];
  volatileTail?: string;
  detectedEntries: CodexContextEntry[];
  alwaysEntries: CodexContextEntry[];
  fullyInjectedIds: string[];
  stableContextIds: string[];
  recalledMessages: RecalledMessageForPromotion[];
  scopeAnchor: NonSceneScopeAnchor | null;
  projectOutline: string | undefined;
  chapterOutlines: Array<{ title: string; outline: string }>;
  authority: ChatContextPreparationAuthority;
}

export interface ChatContextPreparationPort {
  capture?(
    input: ChatContextPreparationSnapshotInput,
  ): ChatContextPreparationSnapshot;
  /**
   * Implementations must synchronously snapshot every concrete Store selector
   * before starting the first source await.
   */
  prepare(
    input: ChatContextPreparationInput,
    snapshot?: ChatContextPreparationSnapshot,
  ): Promise<PreparedChatContext>;
  isAuthorityCurrent(authority: ChatContextPreparationAuthority): boolean;
}

let registeredChatContextPreparation: ChatContextPreparationPort | null = null;

/** Install the concrete renderer composition. Returns a test-friendly restore. */
export function registerChatContextPreparation(
  port: ChatContextPreparationPort,
): () => void {
  const previous = registeredChatContextPreparation;
  registeredChatContextPreparation = port;
  return () => {
    if (registeredChatContextPreparation === port) {
      registeredChatContextPreparation = previous;
    }
  };
}

function chatContextPreparation(): ChatContextPreparationPort {
  if (!registeredChatContextPreparation) {
    throw new Error("Chat context preparation dependencies are not registered");
  }
  return registeredChatContextPreparation;
}

function immutableSnapshot<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableSnapshot(entry))) as T;
  }
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new TypeError(
      "Chat context preparation only accepts immutable JSON-like input",
    );
  }

  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = immutableSnapshot(entry);
  }
  return Object.freeze(copy) as T;
}

/**
 * The single preparation entrypoint used by every Chat surface and scope.
 * Snapshotting happens before the concrete composition can start source I/O.
 */
export function prepareChatContext(
  input: ChatContextPreparationInput,
  snapshot?: ChatContextPreparationSnapshot,
): Promise<PreparedChatContext> {
  return chatContextPreparation().prepare(immutableSnapshot(input), snapshot);
}

export function captureChatContextPreparationSnapshot(
  input: ChatContextPreparationSnapshotInput,
): ChatContextPreparationSnapshot | undefined {
  const port = chatContextPreparation();
  return port.capture?.(immutableSnapshot(input));
}

export function isChatContextPreparationAuthorityCurrent(
  authority: ChatContextPreparationAuthority,
): boolean {
  return chatContextPreparation().isAuthorityCurrent(authority);
}
