import type { ResolvedChatTurnRoute } from "../turn/resolveTurnRoute";
import type { ChatMessage } from "../chatTypes";
import type { ProjectContext, SceneContext } from "../contextBuilder";
import type { CodexContextEntry } from "@/features/codex/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ChatScope } from "../chatScope";

export type ContextPlanningPurpose = "live" | "preview" | "copy" | "send";

export type ContextScopeTarget =
  | { kind: "scene"; sceneId: string }
  | { kind: "global" }
  | { kind: "folder"; folderId: string }
  | { kind: "project" }
  | { kind: "codex"; entryId: string }
  | { kind: "snippet"; snippetId: string }
  | { kind: "thread"; threadId: string; title: string };

export interface TurnContextBudget {
  contextWindow: number;
  maxOutputTokens?: number;
  responseReservationTokens?: number;
  /** Provider framing, tool schemas and tokenizer-drift margin already known
   * before planning. Reserved so optional context can yield before finalization. */
  inputOverheadTokens?: number;
  deliveryMode: "plain" | "cache";
}

export interface TurnContextSettings {
  injectBeats: boolean;
  chronicleEnabled: boolean;
  semanticRecallEnabled: boolean;
  episodicRecallEnabled: boolean;
  hybridRecallEnabled: boolean;
  customChatInstruction: string;
}

export interface TurnContextMapSelection {
  enabled: boolean;
  boardId: string | null;
  activeBoardId: string | null;
}

export interface TurnContextActiveTab {
  nodeId: string;
  contentType: "codex" | "snippet";
}

interface TurnContextRequestBase {
  requestId: string;
  purpose: ContextPlanningPurpose;
  projectId: string;
  sessionId: string | null;
  mode: "chat" | "agent";
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
  sessionStableContextInitialized?: boolean;
  includeBodies: boolean;
  map: TurnContextMapSelection;
  activeTab: TurnContextActiveTab | null;
  settings: TurnContextSettings;
  trackRecallPromote: boolean;
}

export interface SceneTurnContextRequest extends TurnContextRequestBase {
  scope: { kind: "scene"; sceneId: string };
  sceneId: string;
  sourceSnapshot: {
    scene: SceneContext;
    project: ProjectContext | null;
    prefetchedCodexEntries?: readonly CodexContextEntry[];
  };
}

export interface NonSceneTurnContextRequest extends TurnContextRequestBase {
  scope: Exclude<ContextScopeTarget, { kind: "scene" }>;
  /** Session-owning scope. A thread focus can temporarily replace its subject. */
  containerScope: ChatScope;
  scopeAnchorId: string | null;
  activeSceneId: string;
  activeProjectId: string | null;
  /** Whether the selected provider actually executes the agent tool loop. */
  agentToolsAvailable: boolean;
  sourceSnapshot: {
    treeNodes: readonly TreeNodeData[];
    plotThreadIds: readonly string[];
    plotThreadLinks: ReadonlyArray<{ threadId: string; nodeId: string }>;
  };
}

export type TurnContextRequest =
  | SceneTurnContextRequest
  | NonSceneTurnContextRequest;

export type CreateSceneTurnContextRequestInput = Omit<
  SceneTurnContextRequest,
  "scope"
>;

export type CreateNonSceneTurnContextRequestInput = NonSceneTurnContextRequest;

function immutableSnapshot<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableSnapshot(entry))) as T;
  }

  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = immutableSnapshot(entry);
  }
  return Object.freeze(copy) as T;
}

/**
 * Capture every mutable UI/store input once before asynchronous source reads.
 * The planner never re-reads Zustand, so a turn cannot mix values from two
 * scenes, sessions, scopes, or model routes.
 */
export function createSceneTurnContextRequest(
  input: CreateSceneTurnContextRequestInput,
): SceneTurnContextRequest {
  return immutableSnapshot({
    ...input,
    scope: { kind: "scene" as const, sceneId: input.sceneId },
    route: input.route,
    budget: { ...input.budget },
    messages: input.messages.map((message) => ({ ...message })),
    mentionedSceneIds: [...input.mentionedSceneIds],
    mentionedCodexIds: [...input.mentionedCodexIds],
    inputPinnedEntryIds: [...input.inputPinnedEntryIds],
    excludedAutoEntryIds: [...input.excludedAutoEntryIds],
    sessionStableCodexIds: [...input.sessionStableCodexIds],
    map: { ...input.map },
    activeTab: input.activeTab ? { ...input.activeTab } : null,
    settings: { ...input.settings },
    sourceSnapshot: {
      scene: { ...input.sourceSnapshot.scene },
      project: input.sourceSnapshot.project
        ? { ...input.sourceSnapshot.project }
        : null,
      prefetchedCodexEntries: input.sourceSnapshot.prefetchedCodexEntries
        ? input.sourceSnapshot.prefetchedCodexEntries.map((entry) => ({
            ...entry,
          }))
        : undefined,
    },
  });
}

/**
 * Capture a non-scene turn before any asynchronous source read. In particular,
 * tree membership and thread links must come from the same UI instant as the
 * selected scope and model route.
 */
export function createNonSceneTurnContextRequest(
  input: CreateNonSceneTurnContextRequestInput,
): NonSceneTurnContextRequest {
  return immutableSnapshot({
    ...input,
    scope: { ...input.scope },
    route: input.route,
    budget: { ...input.budget },
    messages: input.messages.map((message) => ({ ...message })),
    mentionedSceneIds: [...input.mentionedSceneIds],
    mentionedCodexIds: [...input.mentionedCodexIds],
    inputPinnedEntryIds: [...input.inputPinnedEntryIds],
    excludedAutoEntryIds: [...input.excludedAutoEntryIds],
    sessionStableCodexIds: [...input.sessionStableCodexIds],
    map: { ...input.map },
    activeTab: input.activeTab ? { ...input.activeTab } : null,
    settings: { ...input.settings },
    sourceSnapshot: {
      treeNodes: input.sourceSnapshot.treeNodes.map((node) => ({ ...node })),
      plotThreadIds: [...input.sourceSnapshot.plotThreadIds],
      plotThreadLinks: input.sourceSnapshot.plotThreadLinks.map((link) => ({
        ...link,
      })),
    },
  });
}
