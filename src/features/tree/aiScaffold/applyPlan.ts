/**
 * AiTreePlan のアトミック適用 executor。
 *
 *   validate → stable request/domain IDs → typed Native apply (one tx)
 *   → best-effort projection reload → single composite HistoryCommand
 *
 * Forward/undo/redo all cross the typed Native writer boundary. The renderer
 * never materializes tree_nodes DML, and unresolved Native outcomes retain the
 * exact request identity so retries are idempotent.
 */
import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { createPendingCreateRequestRegistry } from "@/lib/pendingCreateRequestRegistry";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useTabStore } from "@/features/editor/tabStore";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { useTreeStore } from "../treeStore";
import { validateAiTreePlan, type ValidationError } from "./validate";
import { assignNodePlacements } from "./placement";
import type { AiTreePlan, ApplyContext, ApplyResult } from "./types";
import { runTreeTopologyMutation } from "@/application/tree/treeTopologyMutationRegistry";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";

export class AiTreePlanError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(
      `AiTreePlan validation failed: ${errors.map((e) => e.code).join(", ")}`,
    );
    this.name = "AiTreePlanError";
  }
}

interface BeforeState {
  id: string;
  parentId: string | null;
  sortOrder: string;
  title: string;
  version: number;
}

interface InitialTreePlanAttempt {
  requestId: string;
  updatedAt: string;
  createdIds: Array<[string, string]>;
}

const pendingInitialTreePlanAttempts =
  createPendingCreateRequestRegistry<InitialTreePlanAttempt>();

function initialTreePlanSignature(plan: AiTreePlan, ctx: ApplyContext): string {
  return JSON.stringify({
    projectId: ctx.projectId,
    plan,
    model: ctx.model,
    traceId: ctx.traceId,
    scope: {
      allowedOps: [...ctx.scope.allowedOps].sort(),
      rootRef: ctx.scope.rootRef,
      editableIds: [...ctx.scope.editableIds].sort(),
    },
  });
}

function isDefiniteIpcFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcome" in error &&
    error.outcome === "failed"
  );
}

interface NativeTreePlanReceipt {
  versions: Array<{ id: string; version: number }>;
  changeEventUid: string;
  maintenanceTransactionId: string;
  undoJournalId: string;
}

function readNativeTreePlanReceipt(value: unknown): NativeTreePlanReceipt {
  if (value === null || typeof value !== "object") {
    throw new Error("AI tree plan Native receipt is missing");
  }
  const receipt = value as Partial<NativeTreePlanReceipt>;
  if (
    !Array.isArray(receipt.versions) ||
    !receipt.versions.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.id.length > 0 &&
        typeof entry.version === "number" &&
        Number.isSafeInteger(entry.version) &&
        entry.version >= 0,
    ) ||
    typeof receipt.changeEventUid !== "string" ||
    receipt.changeEventUid.length === 0 ||
    typeof receipt.maintenanceTransactionId !== "string" ||
    receipt.maintenanceTransactionId.length === 0 ||
    typeof receipt.undoJournalId !== "string" ||
    receipt.undoJournalId.length === 0
  ) {
    throw new Error("AI tree plan Native receipt is incomplete");
  }
  return receipt as NativeTreePlanReceipt;
}

export async function applyAiTreePlan(
  plan: AiTreePlan,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  return runTreeTopologyMutation(() => applyAiTreePlanWithAuthority(plan, ctx));
}

async function applyAiTreePlanWithAuthority(
  plan: AiTreePlan,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const nodes = useTreeStore.getState().nodes;
  const v = validateAiTreePlan(plan, nodes, ctx.projectId, ctx.scope);
  if (!v.ok) throw new AiTreePlanError(v.errors);

  // A deterministic placeholder pass proves that every placement is resolvable
  // before reserving a durable request identity. No Native call can have run at
  // this point, so validation failures must not leave a pending retry lease.
  const preflightIdMap = new Map(
    [...v.tempIds].map((tempId) => [tempId, `preflight:${tempId}`]),
  );
  const preflightPlacements = assignNodePlacements(plan, nodes, preflightIdMap);

  // before-state capture(apply 前のスナップショットから)。move/rename 対象の
  // parentId/sortOrder/title をまとめて保持し、undo で一括復元する。
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const affected = new Set<string>();
  for (const op of plan.ops) {
    if (op.op === "move" || op.op === "rename") affected.add(op.nodeId);
  }
  const beforeStates: BeforeState[] = [...affected].flatMap((id) => {
    const n = byId.get(id);
    if (!n) return [];
    if (
      typeof n.version !== "number" ||
      !Number.isSafeInteger(n.version) ||
      n.version < 0
    ) {
      throw new AiTreePlanError([
        {
          code: "stale",
          message: `versionを取得できないnodeがあります: ${id}`,
        },
      ]);
    }
    return [
      {
        id,
        parentId: n.parentId,
        sortOrder: n.sortOrder,
        title: n.title,
        version: n.version,
      },
    ];
  });

  const preflightCreatedIds = v.orderedCreates.flatMap((c) => {
    const id = preflightIdMap.get(c.tempId);
    return id ? [id] : [];
  });
  const movedIds = plan.ops.flatMap((o) => (o.op === "move" ? [o.nodeId] : []));
  const renamedIds = plan.ops.flatMap((o) =>
    o.op === "rename" ? [o.nodeId] : [],
  );

  // placement 取りこぼし防御 (M2): validate を通っても afterRef 循環等で配置不能な
  // op が残れば、DB に触る前に弾く。validate.after_cycle が一次防壁だが、ここは
  // 「validate 通過 ⟺ 全 create/move が配置済み」を保証する belt-and-suspenders
  // (silent drop / dangling-parent による FK rollback を未然に防ぐ)。
  const unplaceable = [...preflightCreatedIds, ...movedIds].filter(
    (id) => !preflightPlacements.has(id),
  );
  if (unplaceable.length > 0) {
    throw new AiTreePlanError([
      {
        code: "unplaceable",
        message: `配置を解決できない op があります: ${unplaceable.join(", ")}`,
      },
    ]);
  }

  // Initial retries can outlive this function invocation. Preserve both the
  // request/event identity and every created domain ID until Native confirms
  // success or explicitly reports a definite failure.
  const initialSignature = initialTreePlanSignature(plan, ctx);
  const initialRequest = pendingInitialTreePlanAttempts.acquire(
    initialSignature,
    initialSignature,
    (requestId) => ({
      requestId,
      updatedAt: new Date().toISOString(),
      createdIds: [...v.tempIds].map((tempId) => [tempId, crypto.randomUUID()]),
    }),
  );
  const idMap = new Map(initialRequest.payload.createdIds);
  const placements = assignNodePlacements(plan, nodes, idMap);
  const createdIds = v.orderedCreates.flatMap((create) => {
    const id = idMap.get(create.tempId);
    return id ? [id] : [];
  });

  // store 再同期は cosmetic。commit 後の reload 失敗で確定変更や undo entry を失わない
  // よう best-effort で握りつぶす。isLoading は reloadTreeOrThrow の catch で解除される。
  const resyncTree = async () => {
    try {
      await useTreeStore.getState().reloadTreeOrThrow(ctx.projectId);
    } catch (e) {
      console.error(
        "[aiTree] reload after apply failed; change is committed and undoable",
        e,
      );
    }
  };

  const creates = v.orderedCreates.map((create) => {
    const id = idMap.get(create.tempId);
    const placement = id ? placements.get(id) : undefined;
    if (!id || !placement) {
      throw new Error("AI tree plan placement disappeared after validation");
    }
    return {
      id,
      parentId: placement.parentId,
      nodeType: create.nodeType,
      title: create.title,
      sortOrder: placement.sortOrder,
      synopsis: create.synopsis ?? null,
    };
  });
  const updateTemplates = [...affected].map((id) => {
    const move = plan.ops.find((op) => op.op === "move" && op.nodeId === id);
    const rename = plan.ops.find(
      (op) => op.op === "rename" && op.nodeId === id,
    );
    const placement = move ? placements.get(id) : undefined;
    if (move && !placement) {
      throw new Error(
        "AI tree plan move placement disappeared after validation",
      );
    }
    return {
      id,
      placement: placement
        ? { parentId: placement.parentId, sortOrder: placement.sortOrder }
        : null,
      title: rename?.op === "rename" ? rename.title : null,
    };
  });
  let currentVersions = new Map(
    beforeStates.map((state) => [state.id, state.version]),
  );
  let originalMaintenanceTransactionId: string | null = null;
  let originalUndoJournalId: string | null = null;
  const redoRequests =
    createPendingCreateRequestRegistry<Record<string, unknown>>();
  const undoRequests =
    createPendingCreateRequestRegistry<Record<string, unknown>>();

  const runForwardBatch = async () => {
    const redo = originalMaintenanceTransactionId !== null;
    const updates = updateTemplates.map((update) => {
      const baseVersion = currentVersions.get(update.id);
      if (baseVersion === undefined) {
        throw new Error(`AI tree plan OCC token is missing for ${update.id}`);
      }
      return { ...update, baseVersion };
    });
    const redoRequest = redo
      ? redoRequests.acquire("redo", "redo", (requestId) => ({
          requestId,
          projectId: ctx.projectId,
          sessionId: getRecorderSessionId(),
          surface: "in-app-agent",
          kind: plan.kind,
          updatedAt: new Date().toISOString(),
          model: ctx.model,
          traceId: ctx.traceId,
          creates,
          updates,
          redo: true,
          originalTransactionId: originalMaintenanceTransactionId,
          undoJournalId: originalUndoJournalId,
        }))
      : null;
    const payload = redoRequest?.payload ?? {
      requestId: initialRequest.payload.requestId,
      projectId: ctx.projectId,
      sessionId: getRecorderSessionId(),
      surface: "in-app-agent",
      kind: plan.kind,
      updatedAt: initialRequest.payload.updatedAt,
      model: ctx.model,
      traceId: ctx.traceId,
      creates,
      updates,
      redo: false,
      originalTransactionId: null,
      undoJournalId: null,
    };
    const authorityContext = createCanonicalWriteContext(
      redo ? "redo" : "ai-apply",
      redo
        ? {
            originalTransactionId: originalMaintenanceTransactionId!,
            undoJournalId: originalUndoJournalId!,
          }
        : undefined,
      typeof payload.requestId === "string"
        ? payload.requestId
        : initialRequest.payload.requestId,
      redo
        ? undefined
        : {
            provenance: {
              requestId:
                typeof payload.requestId === "string"
                  ? payload.requestId
                  : initialRequest.payload.requestId,
              traceId:
                ctx.traceId ??
                (typeof payload.requestId === "string"
                  ? payload.requestId
                  : initialRequest.payload.requestId),
            },
          },
    );
    Object.assign(payload, {
      eventUid: authorityContext.eventUid,
      authorityRoute: authorityContext.authorityRoute,
      caller: authorityContext.caller,
      controls: authorityContext.controls,
      provenance: authorityContext.provenance,
      writesAuthorityProtectedField:
        authorityContext.writesAuthorityProtectedField,
    });
    let nativeResponseReceived = false;
    try {
      const rawReceipt = await invoke("ai_tree_plan_apply", { payload });
      nativeResponseReceived = true;
      const receipt = readNativeTreePlanReceipt(rawReceipt);
      if (!redo) {
        originalMaintenanceTransactionId = receipt.maintenanceTransactionId;
        originalUndoJournalId = receipt.undoJournalId;
        pendingInitialTreePlanAttempts.release(initialRequest);
      } else if (redoRequest) {
        redoRequests.release(redoRequest);
      }
      currentVersions = new Map(
        receipt.versions.map((entry) => [entry.id, entry.version]),
      );
    } catch (error) {
      if (!nativeResponseReceived && isDefiniteIpcFailure(error)) {
        if (redoRequest) {
          redoRequests.release(redoRequest);
        } else {
          pendingInitialTreePlanAttempts.release(initialRequest);
        }
      }
      throw error;
    }
    await resyncTree();
  };

  const runUndoBatch = async () => {
    if (!originalMaintenanceTransactionId || !originalUndoJournalId) {
      throw new Error("AI tree plan Native lineage is unavailable");
    }
    const expectedVersions = [...createdIds, ...affected].map((id) => {
      const version = currentVersions.get(id);
      if (version === undefined) {
        throw new Error(`AI tree plan OCC token is missing for ${id}`);
      }
      return { id, version };
    });
    const undoRequest = undoRequests.acquire("undo", "undo", (requestId) => {
      const authorityContext = createCanonicalWriteContext(
        "undo",
        {
          originalTransactionId: originalMaintenanceTransactionId!,
          undoJournalId: originalUndoJournalId!,
        },
        requestId,
      );
      return {
        requestId,
        eventUid: authorityContext.eventUid,
        projectId: ctx.projectId,
        sessionId: getRecorderSessionId(),
        updatedAt: new Date().toISOString(),
        originalTransactionId: originalMaintenanceTransactionId,
        undoJournalId: originalUndoJournalId,
        authorityRoute: authorityContext.authorityRoute,
        caller: authorityContext.caller,
        controls: authorityContext.controls,
        provenance: authorityContext.provenance,
        writesAuthorityProtectedField:
          authorityContext.writesAuthorityProtectedField,
        expectedVersions,
      };
    });
    let nativeResponseReceived = false;
    try {
      const rawReceipt = await invoke("ai_tree_plan_undo", {
        payload: undoRequest.payload,
      });
      nativeResponseReceived = true;
      const receipt = readNativeTreePlanReceipt(rawReceipt);
      undoRequests.release(undoRequest);
      currentVersions = new Map(
        receipt.versions.map((entry) => [entry.id, entry.version]),
      );
    } catch (error) {
      if (!nativeResponseReceived && isDefiniteIpcFailure(error)) {
        undoRequests.release(undoRequest);
      }
      throw error;
    }
    await resyncTree();
    const tab = useTabStore.getState();
    for (const id of createdIds) {
      tab.closeTab(id);
      tab.closeSecondaryTab(id);
    }
  };

  // ── forward 適用 ─────────────────────────────────────────────────
  await runForwardBatch();

  // Domain更新 + change_event + undo_journal + Change Feed は Native writer で同一 tx 済み。
  // reload の成否に依存せず composite undo push を必ず行う(M1)。

  // ── 単一 composite undo を push(redo は forward を直接再実行=二重 push 回避) ──
  if (!useGlobalHistoryStore.getState().isReplaying) {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label:
        plan.kind === "scaffold"
          ? i18next.t("aiTree.historyScaffold")
          : i18next.t("aiTree.historyReorganize"),
      undo: () => runTreeTopologyMutation(runUndoBatch),
      redo: () => runTreeTopologyMutation(runForwardBatch),
    });
  }

  return { createdIds, movedIds, renamedIds };
}
