/**
 * AiTreePlan のアトミック適用 executor。
 *
 *   validate → idMap 採番 → placement 算出 → forward statements(.toSQL())
 *   → db_execute_batch(1 tx) → throwing reload → recordChangeEvent
 *   → 単一 composite HistoryCommand を push
 *
 * 正準パターンは attribution/api.ts:replaceAuthorshipSpansAtomic
 * (drizzle .toSQL() を statements[] に積み invoke('db_execute_batch'))。
 *
 * undo は ON DELETE CASCADE による既存ノード巻き添え削除を防ぐため
 * 「(先) 既存ノードの parentId/sortOrder/title を復元 → (後) 作成ノードを
 * leaf-first で削除」の非対称順序を厳守する(Codex/Plan agent 指摘の最重要点)。
 */
import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useTabStore } from "@/features/editor/tabStore";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { useTreeStore } from "../treeStore";
import { validateAiTreePlan, type ValidationError } from "./validate";
import { assignNodePlacements, type NodePlacement } from "./placement";
import type { AiTreePlan, ApplyContext, ApplyResult, CreateOp } from "./types";

export class AiTreePlanError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(
      `AiTreePlan validation failed: ${errors.map((e) => e.code).join(", ")}`,
    );
    this.name = "AiTreePlanError";
  }
}

type BatchStatement = { sql: string; params: unknown[]; method: string };

interface BeforeState {
  id: string;
  parentId: string | null;
  sortOrder: string;
  title: string;
}

function toStatement(query: {
  sql: string;
  params: unknown[];
}): BatchStatement {
  return { sql: query.sql, params: query.params, method: "run" };
}

/** create=INSERT(topo順) → move=UPDATE → rename=UPDATE。FK 安全順。 */
export function buildForwardStatements(
  plan: AiTreePlan,
  orderedCreates: CreateOp[],
  idMap: Map<string, string>,
  placements: Map<string, NodePlacement>,
  projectId: string,
): BatchStatement[] {
  const now = new Date().toISOString();
  const stmts: BatchStatement[] = [];

  for (const c of orderedCreates) {
    const id = idMap.get(c.tempId);
    const pl = id ? placements.get(id) : undefined;
    if (!id || !pl) continue;
    const q = db
      .insert(treeNodes)
      .values({
        id,
        projectId,
        parentId: pl.parentId,
        nodeType: c.nodeType,
        title: c.title,
        sortOrder: pl.sortOrder,
        ...(c.synopsis != null ? { synopsis: c.synopsis } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .toSQL();
    stmts.push(toStatement(q));
  }

  for (const op of plan.ops) {
    if (op.op !== "move") continue;
    const pl = placements.get(op.nodeId);
    if (!pl) continue;
    // parentId は解決値を直接渡す。`?? undefined` 禁止(undefined は SET から
    // 落ち move-to-root が黙って無効化される — moveNode の教訓)。
    const q = db
      .update(treeNodes)
      .set({ parentId: pl.parentId, sortOrder: pl.sortOrder, updatedAt: now })
      .where(eq(treeNodes.id, op.nodeId))
      .toSQL();
    stmts.push(toStatement(q));
  }

  for (const op of plan.ops) {
    if (op.op !== "rename") continue;
    const q = db
      .update(treeNodes)
      .set({ title: op.title, updatedAt: now })
      .where(eq(treeNodes.id, op.nodeId))
      .toSQL();
    stmts.push(toStatement(q));
  }

  return stmts;
}

/** (先) 既存ノード復元 → (後) 作成ノードを leaf-first で削除。順序が cascade 防止の要。 */
export function buildUndoStatements(
  beforeStates: BeforeState[],
  createdIdsTopo: string[],
): BatchStatement[] {
  const now = new Date().toISOString();
  const stmts: BatchStatement[] = [];

  for (const bs of beforeStates) {
    const q = db
      .update(treeNodes)
      .set({
        parentId: bs.parentId,
        sortOrder: bs.sortOrder,
        title: bs.title,
        updatedAt: now,
      })
      .where(eq(treeNodes.id, bs.id))
      .toSQL();
    stmts.push(toStatement(q));
  }

  for (let i = createdIdsTopo.length - 1; i >= 0; i--) {
    const q = db
      .delete(treeNodes)
      .where(eq(treeNodes.id, createdIdsTopo[i]))
      .toSQL();
    stmts.push(toStatement(q));
  }

  return stmts;
}

export async function applyAiTreePlan(
  plan: AiTreePlan,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const nodes = useTreeStore.getState().nodes;
  const v = validateAiTreePlan(plan, nodes, ctx.projectId, ctx.scope);
  if (!v.ok) throw new AiTreePlanError(v.errors);

  // tempId → UUID 採番(validate は mixed namespace のため、ここで一括採番)。
  const idMap = new Map<string, string>();
  for (const tempId of v.tempIds) idMap.set(tempId, crypto.randomUUID());

  const placements = assignNodePlacements(plan, nodes, idMap);

  // before-state capture(apply 前のスナップショットから)。move/rename 対象の
  // parentId/sortOrder/title をまとめて保持し、undo で一括復元する。
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const affected = new Set<string>();
  for (const op of plan.ops) {
    if (op.op === "move" || op.op === "rename") affected.add(op.nodeId);
  }
  const beforeStates: BeforeState[] = [...affected].flatMap((id) => {
    const n = byId.get(id);
    return n
      ? [{ id, parentId: n.parentId, sortOrder: n.sortOrder, title: n.title }]
      : [];
  });

  const createdIds = v.orderedCreates.flatMap((c) => {
    const id = idMap.get(c.tempId);
    return id ? [id] : [];
  });
  const movedIds = plan.ops.flatMap((o) => (o.op === "move" ? [o.nodeId] : []));
  const renamedIds = plan.ops.flatMap((o) =>
    o.op === "rename" ? [o.nodeId] : [],
  );

  const runForwardBatch = async () => {
    const stmts = buildForwardStatements(
      plan,
      v.orderedCreates,
      idMap,
      placements,
      ctx.projectId,
    );
    await invoke("db_execute_batch", { statements: stmts });
    // throwing reload: 失敗時はここで throw し、record/push へ進まない(Medium-3)。
    await useTreeStore.getState().reloadTreeOrThrow(ctx.projectId);
  };

  const runUndoBatch = async () => {
    const stmts = buildUndoStatements(beforeStates, createdIds);
    await invoke("db_execute_batch", { statements: stmts });
    await useTreeStore.getState().reloadTreeOrThrow(ctx.projectId);
    const tab = useTabStore.getState();
    for (const id of createdIds) {
      tab.closeTab(id);
      tab.closeSecondaryTab(id);
    }
  };

  // ── forward 適用 ─────────────────────────────────────────────────
  await runForwardBatch();

  recordChangeEvent({
    domain: "grid",
    opType: plan.kind === "scaffold" ? "tree.aiScaffold" : "tree.aiReorganize",
    entityType: "tree_batch",
    entityId: ctx.traceId,
    sceneId: null,
    payload: {
      source: ctx.source,
      model: ctx.model,
      traceId: ctx.traceId,
      createdIds,
      movedIds,
      renamedIds,
      synopsisGenerated: plan.ops.some(
        (o) => o.op === "create" && o.synopsis != null,
      ),
    },
  });

  // ── 単一 composite undo を push(redo は forward を直接再実行=二重 push 回避) ──
  if (!useGlobalHistoryStore.getState().isReplaying) {
    useGlobalHistoryStore.getState().push({
      kind: "scenes",
      label: plan.kind === "scaffold" ? "AI 構成生成" : "AI 再編成",
      undo: runUndoBatch,
      redo: runForwardBatch,
    });
  }

  return { createdIds, movedIds, renamedIds };
}
