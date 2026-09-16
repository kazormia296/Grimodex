import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCurrentProjectId,
  getCurrentProjectId,
} from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import {
  prepareCodexEntityRelationReview,
  replacementPrepareInput,
  restoreCodexEntityRelationReview,
  type CodexEntityRelationReviewRestoreTarget,
} from "./codexEntityRelationReviewApi";
import {
  decideNir1EntityRelationRevision,
  readCurrentNir1EntityRelationRevision,
  type Nir1EntityRelationHumanDecision,
  type Nir1EntityRelationRevisionPrepareResult,
  type Nir1EntityRelationRevisionReadResult,
} from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";

export interface TypedReviewSession {
  readonly runId: string;
  readonly status: "draft" | "available" | "unavailable";
  readonly result: Nir1EntityRelationRevisionReadResult | null;
  readonly decision: Nir1EntityRelationHumanDecision | null;
  readonly receipt: Nir1EntityRelationRevisionPrepareResult["receipt"] | null;
  readonly unavailableReason?: string | null;
}

type TypedReviewResponse = Awaited<
  ReturnType<typeof readCurrentNir1EntityRelationRevision>
>;

export function typedReviewSessionFromResponse(
  runId: string,
  response: TypedReviewResponse,
  previous?: TypedReviewSession | null,
  decision?: Nir1EntityRelationHumanDecision | null,
): TypedReviewSession {
  if (response.status === "unavailable") {
    return {
      runId,
      status: "unavailable",
      result: previous?.result ?? null,
      decision: decision ?? previous?.decision ?? null,
      receipt: previous?.receipt ?? null,
      unavailableReason: response.result.reason,
    };
  }
  return {
    runId,
    status: response.status,
    result: response.result,
    decision: decision ?? (response.status === "available" ? "approved" : null),
    receipt: previous?.receipt ?? {
      proposalSetId: response.result.proposalSetId,
      proposalId: response.result.proposalId,
      revisionId: response.result.revisionId,
      status: "unreviewed",
    },
    unavailableReason: null,
  };
}

interface TypedReviewContext {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly workspaceOpenRevision: number;
  readonly authority: MutationAuthority;
}

function captureTypedReviewContext(
  projectId: string,
  workspacePath: string,
  authority: MutationAuthority,
): TypedReviewContext {
  return {
    projectId,
    workspacePath,
    workspaceOpenRevision: authority.workspaceOpenRevision ?? -1,
    authority,
  };
}

function isTypedReviewContextCurrent(
  context: TypedReviewContext,
  generation: number,
  currentGeneration: number,
): boolean {
  const workspace = useWorkspaceStore.getState();
  return (
    generation === currentGeneration &&
    getCurrentProjectId() === context.projectId &&
    workspace.activeWorkspacePath === context.workspacePath &&
    workspace.workspaceOpenRevision === context.workspaceOpenRevision &&
    isCurrentMutationAuthority(context.authority)
  );
}

type PrepareArgs = {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly authority: MutationAuthority;
  readonly sceneId: string;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly proposalKey: string;
};

export interface UseCodexEntityRelationReviewResult {
  readonly typedReview: TypedReviewSession | null;
  readonly typedDecisionBusy: boolean;
  readonly typedPrepareBusy: boolean;
  readonly typedDecisionError: string | null;
  readonly prepareTypedReview: (args: PrepareArgs) => Promise<void>;
  readonly handleTypedDecision: (
    decision: Nir1EntityRelationHumanDecision,
  ) => Promise<void>;
  readonly replaceTypedReview: () => Promise<void>;
  readonly clearTypedReview: () => void;
}

export function useCodexEntityRelationReview(
  open: boolean,
  restoreTarget?: CodexEntityRelationReviewRestoreTarget,
): UseCodexEntityRelationReviewResult {
  const projectId = useCurrentProjectId();
  const activeWorkspacePath = useWorkspaceStore(
    (state) => state.activeWorkspacePath,
  );
  const workspaceOpenRevision = useWorkspaceStore(
    (state) => state.workspaceOpenRevision,
  );
  const restoreEntityId = restoreTarget?.entityId ?? null;
  const restoreRelationId = restoreTarget?.relationId ?? null;
  const [typedReview, setTypedReview] = useState<TypedReviewSession | null>(
    null,
  );
  const [typedDecisionBusy, setTypedDecisionBusy] = useState(false);
  const [typedPrepareBusy, setTypedPrepareBusy] = useState(false);
  const [typedDecisionError, setTypedDecisionError] = useState<string | null>(
    null,
  );
  const generationRef = useRef(0);
  // A successful Native prepare is retained by selection/authority key. A
  // concurrent or re-entrant caller shares the same Promise and can never
  // mint a second durable Run. Failed prepares are removed for an intentional
  // retry; a later restore that proves that Run unavailable evicts only that
  // stale successful receipt so recovery can mint a new immutable revision.
  const preparedRunsRef = useRef(
    new Map<
      string,
      Promise<
        Pick<Nir1EntityRelationRevisionPrepareResult, "runId" | "receipt">
      >
    >(),
  );
  const preparedRunIdsRef = useRef(new Map<string, string>());

  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const clearTypedReview = useCallback(() => {
    nextGeneration();
    setTypedReview(null);
    setTypedDecisionBusy(false);
    setTypedPrepareBusy(false);
    setTypedDecisionError(null);
  }, [nextGeneration]);

  useEffect(() => {
    if (!open || !activeWorkspacePath) {
      setTypedReview(null);
      setTypedDecisionBusy(false);
      setTypedPrepareBusy(false);
      setTypedDecisionError(null);
      nextGeneration();
      return;
    }
    const authority = captureMutationAuthority(projectId, getCurrentProjectId);
    const context = captureTypedReviewContext(
      projectId,
      activeWorkspacePath,
      authority,
    );
    const generation = nextGeneration();
    setTypedReview(null);
    setTypedDecisionBusy(false);
    setTypedPrepareBusy(false);
    setTypedDecisionError(null);
    void restoreCodexEntityRelationReview(
      context.projectId,
      context.workspacePath,
      restoreEntityId
        ? {
            entityId: restoreEntityId,
            relationId: restoreRelationId,
          }
        : undefined,
    )
      .then((restored) => {
        if (!restored) return;
        if (
          !isTypedReviewContextCurrent(
            context,
            generation,
            generationRef.current,
          )
        ) {
          return;
        }
        if (restored.response.status === "unavailable") {
          for (const [receiptKey, preparedRunId] of preparedRunIdsRef.current) {
            if (preparedRunId !== restored.runId) continue;
            preparedRunIdsRef.current.delete(receiptKey);
            preparedRunsRef.current.delete(receiptKey);
          }
        }
        setTypedReview(
          typedReviewSessionFromResponse(restored.runId, restored.response),
        );
      })
      .catch(() => {
        // Missing or stale typed Runs leave the direct preparation surface empty.
      });
    return () => {
      nextGeneration();
    };
  }, [
    activeWorkspacePath,
    nextGeneration,
    open,
    projectId,
    restoreEntityId,
    restoreRelationId,
    workspaceOpenRevision,
  ]);

  const prepareTypedReview = useCallback(
    async (args: PrepareArgs) => {
      const context = captureTypedReviewContext(
        args.projectId,
        args.workspacePath,
        args.authority,
      );
      const generation = nextGeneration();
      const receiptKey = [
        args.projectId,
        args.workspacePath,
        String(args.authority.workspaceOpenRevision ?? -1),
        args.sceneId,
        args.entityIds.slice().sort().join(","),
        args.relationIds.slice().sort().join(","),
        args.proposalKey,
      ].join("\u0000");
      let preparation = preparedRunsRef.current.get(receiptKey);
      if (!preparation) {
        preparation = prepareCodexEntityRelationReview(args);
        preparedRunsRef.current.set(receiptKey, preparation);
        setTypedReview(null);
      }
      setTypedPrepareBusy(true);
      setTypedDecisionError(null);
      try {
        const prepared = await preparation;
        if (preparedRunsRef.current.get(receiptKey) === preparation) {
          preparedRunIdsRef.current.set(receiptKey, prepared.runId);
        }
        if (
          !isTypedReviewContextCurrent(
            context,
            generation,
            generationRef.current,
          )
        ) {
          return;
        }
        const preparedSession: TypedReviewSession = {
          runId: prepared.runId,
          status: "unavailable",
          result: null,
          decision: null,
          receipt: prepared.receipt,
          unavailableReason: "typed-review-evidence-unavailable",
        };
        // The Native write returns an opaque receipt. Evidence is a separate
        // D2a-gated current read; keep this receipt if publication is denied.
        setTypedReview(preparedSession);
        try {
          const current = await readCurrentNir1EntityRelationRevision({
            expectedWorkspacePath: context.workspacePath,
            projectId: context.projectId,
            runId: prepared.runId,
          });
          if (
            !isTypedReviewContextCurrent(
              context,
              generation,
              generationRef.current,
            )
          ) {
            return;
          }
          setTypedReview(
            typedReviewSessionFromResponse(
              prepared.runId,
              current,
              preparedSession,
            ),
          );
        } catch (error) {
          if (
            isTypedReviewContextCurrent(
              context,
              generation,
              generationRef.current,
            )
          ) {
            setTypedDecisionError(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      } catch (error) {
        if (preparedRunsRef.current.get(receiptKey) === preparation) {
          preparedRunsRef.current.delete(receiptKey);
        }
        if (
          isTypedReviewContextCurrent(
            context,
            generation,
            generationRef.current,
          )
        ) {
          setTypedReview(null);
          setTypedDecisionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        if (generationRef.current === generation) {
          setTypedPrepareBusy(false);
        }
      }
    },
    [nextGeneration],
  );

  const handleTypedDecision = useCallback(
    async (decision: Nir1EntityRelationHumanDecision) => {
      const session = typedReview;
      const result = session?.result;
      if (!session || !result || !activeWorkspacePath) return;
      const canDecideDraft =
        session.status === "draft" && session.decision === null;
      const canCancelApproved =
        session.status === "available" &&
        session.decision === "approved" &&
        decision === "rejected";
      if (!canDecideDraft && !canCancelApproved) return;

      const authority = captureMutationAuthority(
        projectId,
        getCurrentProjectId,
      );
      const context = captureTypedReviewContext(
        projectId,
        activeWorkspacePath,
        authority,
      );
      const generation = nextGeneration();
      setTypedDecisionBusy(true);
      setTypedDecisionError(null);
      let decisionPersisted = false;
      try {
        await decideNir1EntityRelationRevision({
          runId: session.runId,
          projectId,
          proposalId: result.proposalId,
          revisionId: result.revisionId,
          decision,
        });
        decisionPersisted = true;
        if (
          !isTypedReviewContextCurrent(
            context,
            generation,
            generationRef.current,
          )
        ) {
          return;
        }
        const current = await readCurrentNir1EntityRelationRevision({
          expectedWorkspacePath: context.workspacePath,
          projectId: context.projectId,
          runId: session.runId,
        });
        if (
          !isTypedReviewContextCurrent(
            context,
            generation,
            generationRef.current,
          )
        ) {
          return;
        }
        setTypedReview(
          typedReviewSessionFromResponse(
            session.runId,
            current,
            session,
            decision,
          ),
        );
      } catch (error) {
        if (
          isTypedReviewContextCurrent(
            context,
            generation,
            generationRef.current,
          )
        ) {
          if (decisionPersisted) {
            setTypedReview({
              ...session,
              status: "unavailable",
              decision,
              receipt: session.receipt ?? {
                proposalSetId: result.proposalSetId,
                proposalId: result.proposalId,
                revisionId: result.revisionId,
                status: "unreviewed",
              },
              unavailableReason: "typed-review-current-read-failed",
            });
          }
          setTypedDecisionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        if (generationRef.current === generation) {
          setTypedDecisionBusy(false);
        }
      }
    },
    [activeWorkspacePath, nextGeneration, projectId, typedReview],
  );

  const replaceTypedReview = useCallback(async () => {
    const result = typedReview?.result;
    if (
      !result ||
      typedReview?.status !== "unavailable" ||
      !activeWorkspacePath
    ) {
      return;
    }
    const authority = captureMutationAuthority(projectId, getCurrentProjectId);
    await prepareTypedReview(
      replacementPrepareInput({
        projectId,
        workspacePath: activeWorkspacePath,
        authority,
        result,
      }),
    );
  }, [activeWorkspacePath, prepareTypedReview, projectId, typedReview]);

  return {
    typedReview,
    typedDecisionBusy,
    typedPrepareBusy,
    typedDecisionError,
    prepareTypedReview,
    handleTypedDecision,
    replaceTypedReview,
    clearTypedReview,
  };
}
