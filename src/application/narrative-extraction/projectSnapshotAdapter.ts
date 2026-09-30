import {
  flushQuiescenceParticipantsForScopes,
  getQuiescenceParticipantRegistryRevision,
  hasPendingQuiescenceParticipantsForScopes,
  type QuiescenceParticipantScope,
} from "@/application/lifecycle/quiescenceParticipants";
import { acquireQuiescenceLeaseAfterTimelapseGenesis } from "@/features/timelapse/genesisQuiescence";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import {
  awaitPendingAuthoritativeMutations,
  isCurrentMutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { hasExternalEditConflictForId } from "@/lib/externalEditConflictRegistry";
import {
  flushWriteBacksForScenes,
  hasPendingWriteBack,
} from "@/features/external-mount/writeBack";
import {
  hasExternalMountReloadConflictForScene,
  settleExternalMountMutationsForSourceUris,
} from "@/features/external-mount/mountManager";
import {
  awaitCoordinatedDocumentMutationsForDocuments,
  hasPendingCoordinatedDocumentMutation,
} from "@/features/editor/document/documentSaveCoordinator";
import {
  flushAutoSavesForEntity,
  getAutoSaveRegistryRevision,
  hasPendingOrFailedAutoSaveForDocument,
} from "@/hooks/useAutoSave";
import {
  listNodes,
  loadProjectNarrativeSourceRows,
  type TreeNodeLite,
} from "@/features/tree/api";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import {
  getPanelWindowHandle,
  isPanelWindow,
} from "@/features/layout/multiwindow/panelWindow";
import { waitForTreeTopologyMutationsIdle } from "@/application/tree/treeTopologyMutationRegistry";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import { freezeDeep } from "@/features/narrative-extraction/source/immutability";
import type { NarrativeScopeAuthorityDocumentInputV2 } from "@/features/narrative-extraction/source/scopeAuthorityBasisV2";
import type {
  NarrativeCorpusSnapshot,
  NarrativeSnapshotDiagnostic,
  ProjectNarrativeSourceRow,
} from "@/features/narrative-extraction/source/types";

export type ScopeFlushBlockedReason =
  | "external-conflict"
  | "save-failed"
  | "authority-changed"
  | "document-unavailable"
  | "scope-not-quiescent";

export interface ScopeFlushResult {
  status: "already-clean" | "flushed" | "blocked";
  blockedDocuments: Array<{
    sceneId: string;
    reason: ScopeFlushBlockedReason;
  }>;
}

export interface ProjectSnapshotAdapterServices {
  /** A detached renderer cannot observe or flush another window's dirty draft. */
  canFlushCompleteScope?: () => boolean | Promise<boolean>;
  isAuthorityCurrent: (authority: MutationAuthority) => boolean;
  hasExternalConflict: (sceneId: string) => boolean;
  hasPendingAutoSave: (sceneId: string) => boolean;
  hasPendingDraft: (sceneId: string) => boolean;
  hasPendingWriteBack: (sceneId: string) => boolean;
  hasPendingDocumentMutation: (sceneId: string) => boolean;
  flushAutoSaves: (sceneId: string) => Promise<void>;
  flushDrafts: (sceneId: string) => Promise<void>;
  flushWriteBacks: (sceneIds: readonly string[]) => Promise<void>;
  flushDocumentMutations: (sceneIds: readonly string[]) => Promise<void>;
  loadSourceRows: (
    projectId: string,
    orderedSceneIds: readonly string[],
  ) => Promise<ProjectNarrativeSourceRow[]>;
  /** Final external-watcher fence held immediately before publishing. */
  settleExternalSourceMutations?: (
    projectId: string,
    folderId: string,
    sourceRows: readonly ProjectNarrativeSourceRow[],
  ) => Promise<void>;
  /** Optional production preflight; dependency-injected pure tests may omit it. */
  validateSceneScope?: (
    projectId: string,
    folderId: string,
    orderedSceneIds: readonly string[],
  ) => Promise<PersistedNarrativeSceneScopeResult>;
  /** Cross-registry revision used to repeat a scoped drain to a fixed point. */
  getScopeRevision?: () => string;
  /** Production mutation-admission boundary held from scope drain through seal. */
  acquireSourceReadLease?: () =>
    | {
        openReadPhase: () => void;
        release: () => void;
      }
    | Promise<{
        openReadPhase: () => void;
        release: () => void;
      }>;
  createSnapshotId: () => string;
  now: () => string;
}

export interface ProjectNarrativeSnapshotRequest {
  projectId: string;
  folderId: string;
  language: string;
  sceneIds: readonly string[];
  authority: MutationAuthority;
}

export type ProjectNarrativeSnapshotResult =
  | {
      ok: true;
      snapshot: NarrativeCorpusSnapshot;
      scopeAuthorityDocuments: readonly NarrativeScopeAuthorityDocumentInputV2[];
      flush: ScopeFlushResult;
    }
  | {
      ok: false;
      diagnostics: readonly NarrativeSnapshotDiagnostic[];
      flush?: ScopeFlushResult;
    };

function treeNodeScope(sceneId: string): QuiescenceParticipantScope {
  return { kind: "tree-node", entityId: sceneId };
}

function sceneDocumentKeys(sceneId: string) {
  return [
    { kind: "tree" as const, id: sceneId, storage: "database" as const },
    { kind: "tree" as const, id: sceneId, storage: "file" as const },
  ];
}

function hasPendingSceneAutoSave(sceneId: string): boolean {
  return (
    hasPendingOrFailedAutoSaveForDocument({
      kind: "tree",
      id: sceneId,
      storage: "database",
    }) ||
    hasPendingOrFailedAutoSaveForDocument({
      kind: "tree",
      id: sceneId,
      storage: "file",
    })
  );
}

type PersistedNarrativeTreeNode = Pick<
  TreeNodeLite,
  "id" | "parentId" | "nodeType" | "sortOrder"
>;

export type PersistedNarrativeSceneScopeResult =
  | {
      readonly ok: true;
      readonly sceneIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "folder-unavailable" | "invalid-tree";
    };

/**
 * Include the selected folder itself so an empty external mount still fences
 * root-wide watcher reconciliation before an empty corpus can be published.
 */
export function collectNarrativeExternalSourceUris(
  nodes: readonly Pick<
    TreeNodeLite,
    "id" | "parentId" | "nodeType" | "sourceUri"
  >[],
  folderId: string,
  sourceRows: readonly Pick<ProjectNarrativeSourceRow, "sourceUri">[],
): string[] {
  const sourceUris = new Set(
    sourceRows
      .map((row) => row.sourceUri)
      .filter((sourceUri): sourceUri is string => sourceUri !== null),
  );
  const childrenByParent = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    childrenByParent.set(node.parentId, [
      ...(childrenByParent.get(node.parentId) ?? []),
      node,
    ]);
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const pendingFolderIds = [folderId];
  const visitedFolderIds = new Set<string>();
  while (pendingFolderIds.length > 0) {
    const currentFolderId = pendingFolderIds.pop();
    if (!currentFolderId || visitedFolderIds.has(currentFolderId)) continue;
    visitedFolderIds.add(currentFolderId);
    const folder = nodesById.get(currentFolderId);
    if (!folder || folder.nodeType !== "folder") continue;
    if (folder.sourceUri !== null) sourceUris.add(folder.sourceUri);
    for (const child of childrenByParent.get(currentFolderId) ?? []) {
      if (child.nodeType === "folder") pendingFolderIds.push(child.id);
    }
  }
  return [...sourceUris];
}

/**
 * Resolve the same persisted DFS order used by the tree UI without trusting
 * the optimistic Zustand tree. Invalid/orphaned/cyclic subtrees are omitted,
 * which makes the caller fail closed when a requested Scene cannot be reached.
 */
export function derivePersistedNarrativeSceneScope(
  nodes: readonly PersistedNarrativeTreeNode[],
  folderId: string,
): PersistedNarrativeSceneScopeResult {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const requestedFolder = nodesById.get(folderId);
  if (!requestedFolder || requestedFolder.nodeType !== "folder") {
    return { ok: false, reason: "folder-unavailable" };
  }

  const ancestorIds = new Set<string>();
  let ancestor: PersistedNarrativeTreeNode | undefined = requestedFolder;
  while (ancestor) {
    if (ancestorIds.has(ancestor.id)) {
      return { ok: false, reason: "invalid-tree" };
    }
    ancestorIds.add(ancestor.id);
    if (ancestor.parentId === null) break;
    const parent: PersistedNarrativeTreeNode | undefined = nodesById.get(
      ancestor.parentId,
    );
    if (!parent || parent.nodeType !== "folder") {
      return { ok: false, reason: "invalid-tree" };
    }
    ancestor = parent;
  }

  const childrenByParent = new Map<
    string | null,
    PersistedNarrativeTreeNode[]
  >();
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => cmpKeys(left.sortOrder, right.sortOrder));
  }

  const orderedSceneIds: string[] = [];
  const visitedFolders = new Set<string>();
  const visitingFolders = new Set<string>();
  let invalidSubtree = false;
  const walkFolder = (folderId: string) => {
    if (visitingFolders.has(folderId)) {
      invalidSubtree = true;
      return;
    }
    if (visitedFolders.has(folderId)) return;
    visitingFolders.add(folderId);
    const children = childrenByParent.get(folderId) ?? [];
    for (let index = 1; index < children.length; index += 1) {
      if (
        cmpKeys(children[index - 1].sortOrder, children[index].sortOrder) === 0
      ) {
        invalidSubtree = true;
        visitingFolders.delete(folderId);
        return;
      }
    }
    for (const child of children) {
      if (
        child.nodeType !== "folder" &&
        (childrenByParent.get(child.id)?.length ?? 0) > 0
      ) {
        invalidSubtree = true;
        break;
      }
      if (child.nodeType === "scene") {
        orderedSceneIds.push(child.id);
      } else if (child.nodeType === "folder") {
        walkFolder(child.id);
      }
    }
    visitingFolders.delete(folderId);
    visitedFolders.add(folderId);
  };

  walkFolder(requestedFolder.id);
  return invalidSubtree
    ? { ok: false, reason: "invalid-tree" }
    : { ok: true, sceneIds: orderedSceneIds };
}

export const defaultProjectSnapshotAdapterServices: ProjectSnapshotAdapterServices =
  {
    canFlushCompleteScope: async () => {
      if (isPanelWindow()) return false;
      // These panels own tree-node draft participants in another renderer.
      // Until cross-window flush acknowledgements land, an open panel is
      // conservatively treated as potentially dirty.
      for (const panelId of [
        "scenes",
        "grid",
        "map",
        "timeline",
        "chronicle",
      ] as const) {
        if (await getPanelWindowHandle(panelId)) return false;
      }
      return true;
    },
    isAuthorityCurrent: isCurrentMutationAuthority,
    hasExternalConflict: (sceneId) =>
      hasExternalEditConflictForId(sceneId) ||
      hasExternalMountReloadConflictForScene(sceneId),
    hasPendingAutoSave: hasPendingSceneAutoSave,
    hasPendingDraft: (sceneId) =>
      hasPendingQuiescenceParticipantsForScopes([treeNodeScope(sceneId)]),
    hasPendingWriteBack,
    hasPendingDocumentMutation: (sceneId) =>
      sceneDocumentKeys(sceneId).some(hasPendingCoordinatedDocumentMutation),
    flushAutoSaves: (sceneId) => flushAutoSavesForEntity("tree", sceneId),
    flushDrafts: (sceneId) =>
      flushQuiescenceParticipantsForScopes([treeNodeScope(sceneId)]),
    flushWriteBacks: flushWriteBacksForScenes,
    flushDocumentMutations: (sceneIds) =>
      awaitCoordinatedDocumentMutationsForDocuments(
        sceneIds.flatMap(sceneDocumentKeys),
      ),
    loadSourceRows: loadProjectNarrativeSourceRows,
    settleExternalSourceMutations: async (projectId, folderId, sourceRows) => {
      const nodes = await listNodes(projectId);
      const folder = nodes.find(
        (node) => node.id === folderId && node.nodeType === "folder",
      );
      if (!folder) {
        throw new Error("Narrative source folder is unavailable");
      }
      await settleExternalMountMutationsForSourceUris(
        collectNarrativeExternalSourceUris(nodes, folder.id, sourceRows),
        sourceRows.flatMap((row) =>
          row.sourceUri === null
            ? []
            : [{ sourceUri: row.sourceUri, content: row.content }],
        ),
      );
    },
    validateSceneScope: async (projectId, folderId) => {
      await awaitPendingAuthoritativeMutations();
      await waitForTreeTopologyMutationsIdle();
      const initialNodes = await listNodes(projectId);
      const initialScope = derivePersistedNarrativeSceneScope(
        initialNodes,
        folderId,
      );
      if (!initialScope.ok) return initialScope;
      const initialFolder = initialNodes.find(
        (node) => node.id === folderId && node.nodeType === "folder",
      );
      if (!initialFolder) {
        return { ok: false, reason: "folder-unavailable" };
      }
      const initialRows = await loadProjectNarrativeSourceRows(
        projectId,
        initialScope.sceneIds,
      );
      await settleExternalMountMutationsForSourceUris(
        collectNarrativeExternalSourceUris(
          initialNodes,
          initialFolder.id,
          initialRows,
        ),
        initialRows.flatMap((row) =>
          row.sourceUri === null ? [] : [{ sourceUri: row.sourceUri }],
        ),
      );
      const persistedScope = derivePersistedNarrativeSceneScope(
        await listNodes(projectId),
        folderId,
      );
      if (!persistedScope.ok) return persistedScope;
      const availableRows = await loadProjectNarrativeSourceRows(
        projectId,
        persistedScope.sceneIds,
      );
      const available = new Set(availableRows.map((row) => row.nodeId));
      return {
        ok: true,
        sceneIds: persistedScope.sceneIds.filter((sceneId) =>
          available.has(sceneId),
        ),
      };
    },
    getScopeRevision: () =>
      `${getAutoSaveRegistryRevision()}:${getQuiescenceParticipantRegistryRevision()}`,
    acquireSourceReadLease: async () => {
      const lease =
        await acquireQuiescenceLeaseAfterTimelapseGenesis("narrative-snapshot");
      return {
        openReadPhase: lease.openControlledReadPhase,
        release: () => lease.release(),
      };
    },
    createSnapshotId: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
  };

const MAX_SCOPE_DRAIN_ROUNDS = 50;

async function canFlushCompleteSnapshotScope(
  services: ProjectSnapshotAdapterServices,
): Promise<boolean> {
  try {
    return (await services.canFlushCompleteScope?.()) ?? true;
  } catch {
    return false;
  }
}

/**
 * Drain every dirty Scene persistence surface in the selected corpus.
 * One failure blocks the whole snapshot, but the remaining targets are still
 * attempted so the review UI can report every blocked document at once.
 */
export async function flushProjectNarrativeScope(
  request: {
    projectId?: string;
    sceneIds: readonly string[];
    authority: MutationAuthority;
  },
  services: ProjectSnapshotAdapterServices = defaultProjectSnapshotAdapterServices,
): Promise<ScopeFlushResult> {
  if (
    (request.projectId !== undefined &&
      request.projectId !== request.authority.projectId) ||
    !services.isAuthorityCurrent(request.authority)
  ) {
    return {
      status: "blocked",
      blockedDocuments: request.sceneIds.map((sceneId) => ({
        sceneId,
        reason: "authority-changed" as const,
      })),
    };
  }

  let hadDirtyDocument = false;
  for (let round = 0; round < MAX_SCOPE_DRAIN_ROUNDS; round += 1) {
    const blockedDocuments: ScopeFlushResult["blockedDocuments"] = [];
    const revisionAtStart = services.getScopeRevision?.();
    let authorityStillCurrent = true;

    for (const sceneId of request.sceneIds) {
      if (!authorityStillCurrent) {
        blockedDocuments.push({ sceneId, reason: "authority-changed" });
        continue;
      }
      if (services.hasExternalConflict(sceneId)) {
        blockedDocuments.push({ sceneId, reason: "external-conflict" });
        continue;
      }

      const hasAutoSave = services.hasPendingAutoSave(sceneId);
      const hasDraft = services.hasPendingDraft(sceneId);
      const hasWriteBack = services.hasPendingWriteBack(sceneId);
      const hasDocumentMutation = services.hasPendingDocumentMutation(sceneId);
      if (!hasAutoSave && !hasDraft && !hasWriteBack && !hasDocumentMutation) {
        continue;
      }
      hadDirtyDocument = true;

      try {
        if (hasDocumentMutation) {
          await services.flushDocumentMutations([sceneId]);
        }
        if (hasAutoSave) await services.flushAutoSaves(sceneId);
        if (
          hasAutoSave &&
          hasDraft &&
          !services.isAuthorityCurrent(request.authority)
        ) {
          authorityStillCurrent = false;
          blockedDocuments.push({ sceneId, reason: "authority-changed" });
          continue;
        }
        if (hasDraft) await services.flushDrafts(sceneId);
        if (
          (hasWriteBack || services.hasPendingWriteBack(sceneId)) &&
          services.isAuthorityCurrent(request.authority)
        ) {
          await services.flushWriteBacks([sceneId]);
        }
      } catch {
        authorityStillCurrent = services.isAuthorityCurrent(request.authority);
        blockedDocuments.push({
          sceneId,
          reason: !authorityStillCurrent
            ? "authority-changed"
            : services.hasExternalConflict(sceneId)
              ? "external-conflict"
              : "save-failed",
        });
        continue;
      }

      authorityStillCurrent = services.isAuthorityCurrent(request.authority);
      if (!authorityStillCurrent) {
        blockedDocuments.push({ sceneId, reason: "authority-changed" });
      }
    }

    if (blockedDocuments.length > 0) {
      return { status: "blocked", blockedDocuments };
    }
    const conflictsAfterFlush = request.sceneIds.filter((sceneId) =>
      services.hasExternalConflict(sceneId),
    );
    if (conflictsAfterFlush.length > 0) {
      return {
        status: "blocked",
        blockedDocuments: conflictsAfterFlush.map((sceneId) => ({
          sceneId,
          reason: "external-conflict" as const,
        })),
      };
    }
    if (!services.getScopeRevision) {
      return {
        status: hadDirtyDocument ? "flushed" : "already-clean",
        blockedDocuments: [],
      };
    }

    const revisionAfterFlush = services.getScopeRevision();
    const stillPending = request.sceneIds.some(
      (sceneId) =>
        services.hasPendingAutoSave(sceneId) ||
        services.hasPendingDraft(sceneId) ||
        services.hasPendingWriteBack(sceneId) ||
        services.hasPendingDocumentMutation(sceneId),
    );
    if (revisionAtStart === revisionAfterFlush && !stillPending) {
      return {
        status: hadDirtyDocument ? "flushed" : "already-clean",
        blockedDocuments: [],
      };
    }
  }

  return {
    status: "blocked",
    blockedDocuments: request.sceneIds.map((sceneId) => ({
      sceneId,
      reason: "scope-not-quiescent" as const,
    })),
  };
}

function diagnostic(
  code: string,
  message: string,
  documentSourceKey?: string,
): NarrativeSnapshotDiagnostic {
  return {
    code,
    message,
    ...(documentSourceKey ? { documentSourceKey } : {}),
  };
}

const NARRATIVE_SOURCE_ROW_FIELDS = [
  "nodeId",
  "parentId",
  "title",
  "content",
  "sortOrder",
  "storyTimeOrder",
  "orderIndex",
  "version",
  "updatedAt",
  "sourceUri",
] as const satisfies readonly (keyof ProjectNarrativeSourceRow)[];

function sourceRowsMatch(
  before: readonly ProjectNarrativeSourceRow[],
  after: readonly ProjectNarrativeSourceRow[],
): boolean {
  return (
    before.length === after.length &&
    before.every((row, index) => {
      const candidate = after[index];
      return (
        candidate !== undefined &&
        NARRATIVE_SOURCE_ROW_FIELDS.every(
          (field) => row[field] === candidate[field],
        )
      );
    })
  );
}

/** Build an immutable corpus only after every Scene in the scope is durable. */
export async function buildProjectNarrativeSnapshot(
  untrustedRequest: ProjectNarrativeSnapshotRequest,
  services: ProjectSnapshotAdapterServices = defaultProjectSnapshotAdapterServices,
): Promise<ProjectNarrativeSnapshotResult> {
  const request = freezeDeep<ProjectNarrativeSnapshotRequest>({
    projectId: untrustedRequest.projectId,
    folderId: untrustedRequest.folderId,
    language: untrustedRequest.language,
    sceneIds: [...untrustedRequest.sceneIds],
    authority: {
      projectId: untrustedRequest.authority.projectId,
      currentProjectId: untrustedRequest.authority.currentProjectId,
      workspacePath: untrustedRequest.authority.workspacePath,
      workspaceOpenRevision: untrustedRequest.authority.workspaceOpenRevision,
    },
  });
  if (!(await canFlushCompleteSnapshotScope(services))) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "SNAPSHOT_SCOPE_NOT_FLUSHED",
          "Close detached Scene-related panels and retry from the primary window so every dirty Scene can be flushed",
        ),
      ],
    };
  }
  if (request.projectId !== request.authority.projectId) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "SNAPSHOT_AUTHORITY_MISMATCH",
          "Requested Project does not match the captured mutation authority",
        ),
      ],
    };
  }
  if (!services.isAuthorityCurrent(request.authority)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "SNAPSHOT_AUTHORITY_CHANGED",
          "Project or workspace authority changed before snapshot creation",
        ),
      ],
    };
  }

  const uniqueSceneIds = new Set(request.sceneIds);
  if (uniqueSceneIds.size !== request.sceneIds.length) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "SNAPSHOT_DUPLICATE_SOURCE_KEY",
          "The requested Project scope contains a duplicate Scene identity",
        ),
      ],
    };
  }

  let sourceReadLease:
    | { openReadPhase: () => void; release: () => void }
    | undefined;
  try {
    sourceReadLease = await services.acquireSourceReadLease?.();
  } catch {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "SNAPSHOT_ADMISSION_BUSY",
          "Another lifecycle operation is currently changing the workspace",
        ),
      ],
    };
  }

  try {
    sourceReadLease?.openReadPhase();

    if (services.validateSceneScope) {
      let validation: PersistedNarrativeSceneScopeResult;
      try {
        validation = await services.validateSceneScope(
          request.projectId,
          request.folderId,
          request.sceneIds,
        );
      } catch {
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SCOPE_VALIDATION_FAILED",
              "The requested Project scope could not be validated",
            ),
          ],
        };
      }
      if (!validation.ok) {
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SCOPE_UNAVAILABLE",
              "The requested folder is unavailable or has an invalid persisted hierarchy",
            ),
          ],
        };
      }
      const availableSceneIds = validation.sceneIds;
      if (!services.isAuthorityCurrent(request.authority)) {
        return {
          ok: false,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_AUTHORITY_CHANGED",
              "Project or workspace authority changed during scope validation",
            ),
          ],
        };
      }

      const available = new Set(availableSceneIds);
      const unavailable = request.sceneIds.filter(
        (sceneId) => !available.has(sceneId),
      );
      const unexpected = availableSceneIds.filter(
        (sceneId) => !uniqueSceneIds.has(sceneId),
      );
      if (
        unavailable.length > 0 ||
        available.size !== availableSceneIds.length ||
        available.size !== uniqueSceneIds.size
      ) {
        const unavailableIds = [...new Set([...unavailable, ...unexpected])];
        const blockedSceneIds =
          unavailableIds.length > 0 ? unavailableIds : [...uniqueSceneIds];
        const flush: ScopeFlushResult = {
          status: "blocked",
          blockedDocuments: blockedSceneIds.map((sceneId) => ({
            sceneId,
            reason: "document-unavailable",
          })),
        };
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SCOPE_NOT_FLUSHED",
              "One or more requested Scenes are unavailable in this Project",
            ),
          ],
        };
      }
      if (
        availableSceneIds.some(
          (sceneId, index) => sceneId !== request.sceneIds[index],
        )
      ) {
        const flush: ScopeFlushResult = {
          status: "blocked",
          blockedDocuments: request.sceneIds.map((sceneId) => ({
            sceneId,
            reason: "scope-not-quiescent",
          })),
        };
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SCOPE_ORDER_MISMATCH",
              "The requested Scene order does not match the persisted Project tree",
            ),
          ],
        };
      }
    }

    const flush = await flushProjectNarrativeScope(request, services);
    if (flush.status === "blocked") {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SCOPE_NOT_FLUSHED",
            "One or more Scene drafts could not be persisted",
          ),
        ],
      };
    }
    if (!services.isAuthorityCurrent(request.authority)) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_AUTHORITY_CHANGED",
            "Project or workspace authority changed before source read",
          ),
        ],
      };
    }

    let rows: ProjectNarrativeSourceRow[];
    try {
      rows = await services.loadSourceRows(request.projectId, request.sceneIds);
    } catch {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SOURCE_READ_FAILED",
            "Persisted Scene sources could not be read",
          ),
        ],
      };
    }
    if (!services.isAuthorityCurrent(request.authority)) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_AUTHORITY_CHANGED",
            "Project or workspace authority changed during source read",
          ),
        ],
      };
    }

    const requestedIds = new Set(request.sceneIds);
    const rowsById = new Map<string, ProjectNarrativeSourceRow>();
    const rowDiagnostics: NarrativeSnapshotDiagnostic[] = [];
    for (const row of rows) {
      if (!requestedIds.has(row.nodeId)) {
        rowDiagnostics.push(
          diagnostic(
            "SNAPSHOT_SOURCE_UNEXPECTED",
            `Scene ${row.nodeId} was not part of the requested Project scope`,
            `project:scene:${row.nodeId}`,
          ),
        );
        continue;
      }
      if (rowsById.has(row.nodeId)) {
        rowDiagnostics.push(
          diagnostic(
            "SNAPSHOT_SOURCE_DUPLICATE",
            `Scene ${row.nodeId} appeared more than once in the source read`,
            `project:scene:${row.nodeId}`,
          ),
        );
        continue;
      }
      rowsById.set(row.nodeId, row);
    }
    rowDiagnostics.push(
      ...request.sceneIds.flatMap((sceneId) =>
        rowsById.has(sceneId)
          ? []
          : [
              diagnostic(
                "SNAPSHOT_SOURCE_MISSING",
                `Scene ${sceneId} was unavailable in the persisted Project scope`,
                `project:scene:${sceneId}`,
              ),
            ],
      ),
    );
    if (rowDiagnostics.length > 0) {
      return { ok: false, flush, diagnostics: rowDiagnostics };
    }

    const sourceKeys = new Set(
      request.sceneIds.map((id) => `project:scene:${id}`),
    );
    let buildResult: Awaited<ReturnType<typeof buildNarrativeCorpusSnapshot>>;
    try {
      buildResult = await buildNarrativeCorpusSnapshot({
        snapshotId: services.createSnapshotId(),
        language: request.language,
        origin: { kind: "grimodex-project", projectId: request.projectId },
        documents: request.sceneIds.map((sceneId, orderIndex) => {
          const row = rowsById.get(sceneId);
          if (!row) {
            throw new Error(`Validated Scene row disappeared: ${sceneId}`);
          }
          const parentSourceKey = row.parentId
            ? `project:scene:${row.parentId}`
            : null;
          return {
            sourceKey: `project:scene:${row.nodeId}`,
            parentSourceKey:
              parentSourceKey && sourceKeys.has(parentSourceKey)
                ? parentSourceKey
                : null,
            title: row.title,
            // The resolved DFS scope is authoritative; SQL and injected loaders
            // are never allowed to redefine corpus ordering.
            orderIndex,
            proseMirrorJson: row.content,
            origin: {
              kind: "project-node" as const,
              projectId: request.projectId,
              nodeId: row.nodeId,
              sourceVersion: row.version,
              sourceUpdatedAt: row.updatedAt,
              sourceUri: row.sourceUri,
            },
          };
        }),
        omissions: [],
        createdAt: services.now(),
      });
    } catch {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SEAL_FAILED",
            "The persisted Scene corpus could not be sealed",
          ),
        ],
      };
    }
    if (!services.isAuthorityCurrent(request.authority)) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_AUTHORITY_CHANGED",
            "Project or workspace authority changed while sealing the snapshot",
          ),
        ],
      };
    }
    if (!buildResult.ok) {
      return { ok: false, diagnostics: buildResult.diagnostics, flush };
    }

    if (services.validateSceneScope) {
      let validation: PersistedNarrativeSceneScopeResult;
      try {
        validation = await services.validateSceneScope(
          request.projectId,
          request.folderId,
          request.sceneIds,
        );
      } catch {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SOURCE_CHANGED",
              "The persisted folder scope could not be verified after sealing",
            ),
          ],
        };
      }
      if (!validation.ok) {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SOURCE_CHANGED",
              "The persisted folder became unavailable while the corpus was being sealed",
            ),
          ],
        };
      }
      const verifiedSceneIds = validation.sceneIds;
      if (
        verifiedSceneIds.length !== request.sceneIds.length ||
        verifiedSceneIds.some(
          (sceneId, index) => sceneId !== request.sceneIds[index],
        )
      ) {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SOURCE_CHANGED",
              "The persisted folder scope changed while the corpus was being sealed",
            ),
          ],
        };
      }
    }

    let verificationRows: ProjectNarrativeSourceRow[];
    try {
      verificationRows = await services.loadSourceRows(
        request.projectId,
        request.sceneIds,
      );
    } catch {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SOURCE_READ_FAILED",
            "Persisted Scene sources could not be verified after sealing",
          ),
        ],
      };
    }
    if (!services.isAuthorityCurrent(request.authority)) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_AUTHORITY_CHANGED",
            "Project or workspace authority changed during source verification",
          ),
        ],
      };
    }
    if (!sourceRowsMatch(rows, verificationRows)) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SOURCE_CHANGED",
            "One or more persisted Scenes changed while the corpus was being sealed",
          ),
        ],
      };
    }

    // This async cross-renderer capability check must precede the final
    // external/scope/source fences. Any fact arriving while it runs is then
    // either drained or observed by the checks below before publication.
    if (!(await canFlushCompleteSnapshotScope(services))) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SCOPE_NOT_FLUSHED",
            "Close detached Scene-related panels and retry so every dirty Scene can be flushed",
          ),
        ],
      };
    }

    if (services.settleExternalSourceMutations) {
      try {
        await services.settleExternalSourceMutations(
          request.projectId,
          request.folderId,
          verificationRows,
        );
      } catch {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SOURCE_CHANGED",
              "An external Scene source changed while the corpus was being sealed",
            ),
          ],
        };
      }
      if (!services.isAuthorityCurrent(request.authority)) {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_AUTHORITY_CHANGED",
              "Project or workspace authority changed during final source settlement",
            ),
          ],
        };
      }
      if (request.sceneIds.some(services.hasExternalConflict)) {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SOURCE_CHANGED",
              "An external Scene conflict was discovered during final source settlement",
            ),
          ],
        };
      }
    }

    if (services.validateSceneScope) {
      let publishedScope: PersistedNarrativeSceneScopeResult;
      try {
        publishedScope = await services.validateSceneScope(
          request.projectId,
          request.folderId,
          request.sceneIds,
        );
      } catch {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SOURCE_CHANGED",
              "The persisted folder scope could not be fenced before publication",
            ),
          ],
        };
      }
      if (
        !publishedScope.ok ||
        publishedScope.sceneIds.length !== request.sceneIds.length ||
        publishedScope.sceneIds.some(
          (sceneId, index) => sceneId !== request.sceneIds[index],
        )
      ) {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_SOURCE_CHANGED",
              "The persisted folder scope changed before snapshot publication",
            ),
          ],
        };
      }
      if (!services.isAuthorityCurrent(request.authority)) {
        return {
          ok: false,
          flush,
          diagnostics: [
            diagnostic(
              "SNAPSHOT_AUTHORITY_CHANGED",
              "Project or workspace authority changed before snapshot publication",
            ),
          ],
        };
      }
    }

    let publicationRows: ProjectNarrativeSourceRow[];
    try {
      publicationRows = await services.loadSourceRows(
        request.projectId,
        request.sceneIds,
      );
    } catch {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SOURCE_READ_FAILED",
            "Persisted Scene sources could not be fenced before publication",
          ),
        ],
      };
    }
    if (!services.isAuthorityCurrent(request.authority)) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_AUTHORITY_CHANGED",
            "Project or workspace authority changed before snapshot publication",
          ),
        ],
      };
    }
    if (!sourceRowsMatch(verificationRows, publicationRows)) {
      return {
        ok: false,
        flush,
        diagnostics: [
          diagnostic(
            "SNAPSHOT_SOURCE_CHANGED",
            "One or more persisted Scenes changed before snapshot publication",
          ),
        ],
      };
    }
    const publicationRowsBySourceKey = new Map<
      string,
      ProjectNarrativeSourceRow
    >(
      publicationRows.map(
        (row) => [`project:scene:${row.nodeId}`, row] as const,
      ),
    );
    const scopeAuthorityDocuments = buildResult.snapshot.documents.map(
      (document): NarrativeScopeAuthorityDocumentInputV2 => {
        const row = publicationRowsBySourceKey.get(document.sourceKey);
        if (!row) {
          throw new Error(
            `Published snapshot document has no fenced source row: ${document.sourceKey}`,
          );
        }
        return {
          documentRef: document.ref,
          sourceKey: `project:scene:${row.nodeId}`,
          rawStoryKey: row.storyTimeOrder,
        };
      },
    );
    return {
      ok: true,
      snapshot: buildResult.snapshot,
      scopeAuthorityDocuments: freezeDeep(scopeAuthorityDocuments),
      flush,
    };
  } finally {
    sourceReadLease?.release();
  }
}
