import { useEffect, useMemo, useRef, useState } from "react";
import {
  getCurrentProjectId,
  useCurrentProjectId,
} from "@/features/project/projectStore";
import {
  getAllProjectScenesInOrder,
  useTreeStore,
} from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { captureMutationAuthority } from "@/features/concurrency/mutationAuthority";
import type { CodexEntry } from "./api";
import { listCodexRelations, type CodexRelationRow } from "./codexRelationApi";
import { useCodexStore } from "./codexStore";
import { CodexEntityRelationReviewDialogContent } from "./CodexEntityRelationReviewDialogContent";
import { useCodexEntityRelationReview } from "./useCodexEntityRelationReview";

interface CodexEntityRelationReviewDialogProps {
  readonly entry: CodexEntry;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialRelationId?: string | null;
}

type ProposalAttemptKind = "selection" | "recovery";

let fallbackProposalAttemptSequence = 0;

export function buildCodexEntityRelationSelectionIdentity({
  projectId,
  sceneId,
  entityIds,
  relationIds,
}: {
  readonly projectId: string;
  readonly sceneId: string;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
}): string {
  return JSON.stringify({
    projectId,
    sceneId,
    entityIds: [...entityIds].sort(),
    relationIds: [...relationIds].sort(),
  });
}

export function getOrCreateCodexEntityRelationAttemptId(
  attempts: Map<string, string>,
  identity: string,
): string {
  const existing = attempts.get(identity);
  if (existing) return existing;
  const attemptId =
    globalThis.crypto?.randomUUID?.() ??
    `fallback-${Date.now().toString(36)}-${++fallbackProposalAttemptSequence}`;
  attempts.set(identity, attemptId);
  return attemptId;
}

export function buildBoundedCodexEntityRelationProposalKey(
  kind: ProposalAttemptKind,
  attemptId: string,
): string {
  const prefix = `codex-ui:${kind}:`;
  const normalizedAttemptId = attemptId.trim();
  const proposalKey = `${prefix}${normalizedAttemptId}`;
  if (
    normalizedAttemptId.length === 0 ||
    normalizedAttemptId !== attemptId ||
    proposalKey.length > 256
  ) {
    throw new Error("NIR1_ENTITY_RELATION_PROPOSAL_KEY_INVALID");
  }
  return proposalKey;
}

export function CodexEntityRelationReviewDialog({
  entry,
  open,
  onOpenChange,
  initialRelationId = null,
}: CodexEntityRelationReviewDialogProps) {
  const projectId = useCurrentProjectId();
  const entries = useCodexStore((state) => state.entries);
  const nodes = useTreeStore((state) => state.nodes);
  const activeWorkspacePath = useWorkspaceStore(
    (state) => state.activeWorkspacePath,
  );
  const [relations, setRelations] = useState<CodexRelationRow[]>([]);
  const [sceneId, setSceneId] = useState("");
  const [selectedEntityIds, setSelectedEntityIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedRelationIds, setSelectedRelationIds] = useState<Set<string>>(
    new Set(),
  );
  const selectionAttemptIdsRef = useRef(new Map<string, string>());
  const recoveryAttemptIdsRef = useRef(new Map<string, string>());
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const {
    typedReview,
    typedDecisionBusy,
    typedPrepareBusy,
    typedDecisionError,
    prepareTypedReview,
    handleTypedDecision,
    replaceTypedReview,
    clearTypedReview,
  } = useCodexEntityRelationReview(open, {
    entityId: entry.id,
    relationId: initialRelationId,
  });

  const scenes = useMemo(
    () =>
      getAllProjectScenesInOrder(nodes).filter(
        (node) => node.projectId === entry.projectId,
      ),
    [entry.projectId, nodes],
  );
  const selectableEntries = useMemo(
    () =>
      entries
        .filter((candidate) => candidate.projectId === entry.projectId)
        .sort((left, right) => left.name.localeCompare(right.name)),
    [entries, entry.projectId],
  );
  const projectMatches = projectId === entry.projectId;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSelectionError(null);
    if (!projectMatches) {
      setRelations([]);
      setSelectionError("Project bindingが一致しないため準備できません");
      return () => {
        cancelled = true;
      };
    }
    setSelectedEntityIds(new Set([entry.id]));
    setSelectedRelationIds(
      initialRelationId ? new Set([initialRelationId]) : new Set(),
    );
    setSceneId((current) =>
      scenes.some((scene) => scene.id === current)
        ? current
        : (scenes[0]?.id ?? ""),
    );
    void listCodexRelations(entry.projectId)
      .then((rows) => {
        if (!cancelled) setRelations(rows);
      })
      .catch((error) => {
        if (!cancelled) {
          setRelations([]);
          setSelectionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    entry.id,
    entry.projectId,
    initialRelationId,
    open,
    projectMatches,
    scenes,
  ]);

  const prepare = async () => {
    if (!projectMatches) {
      setSelectionError("Project bindingが一致しないため準備できません");
      return;
    }
    if (!sceneId) {
      setSelectionError("対象 Scene Scope を選択してください");
      return;
    }
    if (selectedEntityIds.size === 0 && selectedRelationIds.size === 0) {
      setSelectionError("Entity または Relationを1件以上選択してください");
      return;
    }
    if (!activeWorkspacePath) {
      setSelectionError("Workspace が未選択です");
      return;
    }
    setSelectionError(null);
    const selectionIdentity = buildCodexEntityRelationSelectionIdentity({
      projectId,
      sceneId,
      entityIds: [...selectedEntityIds],
      relationIds: [...selectedRelationIds],
    });
    let proposalKey = buildBoundedCodexEntityRelationProposalKey(
      "selection",
      getOrCreateCodexEntityRelationAttemptId(
        selectionAttemptIdsRef.current,
        selectionIdentity,
      ),
    );
    if (typedReview?.status === "unavailable" && typedReview.result === null) {
      // A denied/unavailable cold read has already identified an old Run. An
      // explicit Prepare from the selectors must create one new Revision, but
      // repeated clicks for the same selection must share that durable
      // preparation rather than minting more Runs.
      const recoveryIdentity = `${selectionIdentity}\u0000${typedReview.runId}`;
      proposalKey = buildBoundedCodexEntityRelationProposalKey(
        "recovery",
        getOrCreateCodexEntityRelationAttemptId(
          recoveryAttemptIdsRef.current,
          recoveryIdentity,
        ),
      );
    }
    try {
      await prepareTypedReview({
        projectId,
        workspacePath: activeWorkspacePath,
        authority: captureMutationAuthority(projectId, getCurrentProjectId),
        sceneId,
        entityIds: [...selectedEntityIds],
        relationIds: [...selectedRelationIds],
        proposalKey,
      });
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) clearTypedReview();
    onOpenChange(next);
  };

  return (
    <CodexEntityRelationReviewDialogContent
      open={open}
      onOpenChange={handleOpenChange}
      entries={selectableEntries}
      scenes={scenes}
      relations={relations}
      sceneId={sceneId}
      setSceneId={setSceneId}
      selectedEntityIds={selectedEntityIds}
      setSelectedEntityIds={setSelectedEntityIds}
      selectedRelationIds={selectedRelationIds}
      setSelectedRelationIds={setSelectedRelationIds}
      selectionError={selectionError}
      projectMatches={projectMatches}
      typedReview={typedReview}
      typedDecisionBusy={typedDecisionBusy}
      typedPrepareBusy={typedPrepareBusy}
      typedDecisionError={typedDecisionError}
      onDecision={(decision) => void handleTypedDecision(decision)}
      onReplace={() => void replaceTypedReview()}
      onStartNew={() => clearTypedReview()}
      onPrepare={() => void prepare()}
    />
  );
}
