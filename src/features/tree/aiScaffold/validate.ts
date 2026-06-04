/**
 * AiTreePlan のバリデーション層。`getState().nodes` の単一スナップショットに対して
 * 全 op を検証し、1 件でも失敗したら `{ok:false}` を返す(executor は何も適用しない)。
 *
 * tempId は実 UUID に解決せず、tempId のまま mixed namespace (existing-UUID ∪ tempId)
 * で検証する — UUID 採番は applyPlan 側が行うため、validate は決定論的に保てる。
 *
 * 検証項目:
 *  (g) IR サイズ/形式上限   — ops 件数 / title・synopsis 長 / tempId 形式 / 重複 move·rename
 *  (e) scope               — allowedOps / editableIds / 親の到達範囲 (Codex High-1)
 *  (a) 参照存在 + projectId
 *  (b) 親子型ルール          — folder のみ子を持てる (treeStore.canHaveChildren と同義)
 *  (f) afterRef 厳格化       — 最終 parent の sibling である / self でない (Codex High-2)
 *  (c)(d) 最終 forest 非循環
 */
import { generateKeyBetween } from "../fractionalIndex";
import type { TreeNodeData } from "../treeStore";
import {
  type AiTreePlan,
  type AiTreeOp,
  type CreateOp,
  type NodeRef,
  type AiTreeScope,
  MAX_OPS,
  MAX_TITLE_LEN,
  MAX_SYNOPSIS_LEN,
  TEMP_ID_PREFIX,
} from "./types";

export interface ValidationError {
  code: string;
  message: string;
  opIndex?: number;
}

export type ValidateResult =
  | { ok: true; orderedCreates: CreateOp[]; tempIds: string[] }
  | { ok: false; errors: ValidationError[] };

function isTempRef(ref: NodeRef): boolean {
  return ref.startsWith(TEMP_ID_PREFIX);
}

/** treeStore.canHaveChildren と同義(folder のみ)。pure 化のため再宣言。 */
function typeAllowsChildren(nodeType: string): boolean {
  return nodeType === "folder";
}

/** placement.isValidOrderKey と同義: 不正な fractional-indexing キーを検出。pure 化のため再宣言。 */
function isValidOrderKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

/**
 * rootId 配下(自身は除く)の既存ノード id 集合を BFS で収集。rootId=null は
 * 「プロジェクト全体(= 全ノード)」を意味する。scope 判定(validate)と editableIds
 * 構築(runAiTreeGeneration)で同一ロジックを共有するため export する(N2: 二重実装の解消)。
 */
export function collectDescendants(
  nodes: TreeNodeData[],
  rootId: string | null,
): Set<string> {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const arr = childrenByParent.get(n.parentId) ?? [];
    arr.push(n);
    childrenByParent.set(n.parentId, arr);
  }
  const out = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of childrenByParent.get(cur) ?? []) {
      if (out.has(child.id)) continue;
      out.add(child.id);
      queue.push(child.id);
    }
  }
  return out;
}

export function validateAiTreePlan(
  plan: AiTreePlan,
  nodes: TreeNodeData[],
  projectId: string,
  scope: AiTreeScope,
): ValidateResult {
  const errors: ValidationError[] = [];
  const push = (code: string, message: string, opIndex?: number) =>
    errors.push({ code, message, opIndex });

  // ── (g) IR サイズ/形式上限 ────────────────────────────────────────
  if (plan.ops.length === 0) {
    push("empty", "操作が空です");
    return { ok: false, errors };
  }
  if (plan.ops.length > MAX_OPS) {
    push("too_many_ops", `操作が多すぎます (${plan.ops.length} > ${MAX_OPS})`);
    return { ok: false, errors };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const createByTempId = new Map<string, CreateOp>();
  const movedNodeIds = new Set<string>();
  const renamedNodeIds = new Set<string>();

  // 形式・重複チェック + create の tempId 収集
  plan.ops.forEach((op, i) => {
    if (op.op === "create") {
      if (
        typeof op.tempId !== "string" ||
        !op.tempId.startsWith(TEMP_ID_PREFIX)
      ) {
        push("bad_temp_id", `tempId の形式が不正です: ${String(op.tempId)}`, i);
        return;
      }
      if (createByTempId.has(op.tempId)) {
        push("dup_temp_id", `tempId が重複しています: ${op.tempId}`, i);
        return;
      }
      if (!["folder", "scene", "note"].includes(op.nodeType)) {
        push("bad_node_type", `nodeType が不正です: ${op.nodeType}`, i);
      }
      if (!op.title || op.title.trim().length === 0) {
        push("empty_title", "title が空です", i);
      } else if (op.title.length > MAX_TITLE_LEN) {
        push("title_too_long", `title が長すぎます (>${MAX_TITLE_LEN})`, i);
      }
      if (op.synopsis != null && op.synopsis.length > MAX_SYNOPSIS_LEN) {
        push(
          "synopsis_too_long",
          `synopsis が長すぎます (>${MAX_SYNOPSIS_LEN})`,
          i,
        );
      }
      createByTempId.set(op.tempId, op);
    } else if (op.op === "move") {
      if (movedNodeIds.has(op.nodeId)) {
        push("dup_move", `同一ノードへの move が重複: ${op.nodeId}`, i);
      }
      movedNodeIds.add(op.nodeId);
    } else if (op.op === "rename") {
      if (renamedNodeIds.has(op.nodeId)) {
        push("dup_rename", `同一ノードへの rename が重複: ${op.nodeId}`, i);
      }
      renamedNodeIds.add(op.nodeId);
      if (!op.title || op.title.trim().length === 0) {
        push("empty_title", "title が空です", i);
      } else if (op.title.length > MAX_TITLE_LEN) {
        push("title_too_long", `title が長すぎます (>${MAX_TITLE_LEN})`, i);
      }
    }
  });

  const tempIds = [...createByTempId.keys()];

  // ── scope 用の到達範囲 ───────────────────────────────────────────
  const descendantsOfRoot =
    scope.rootRef != null ? collectDescendants(nodes, scope.rootRef) : null;

  /** 解決後の最終 parent ref が scope 内か。null = root。 */
  const parentInScope = (parentRef: NodeRef | null): boolean => {
    if (scope.rootRef == null) return true; // whole-project scope
    if (parentRef == null) return false; // subtree scope では root へ出せない
    if (parentRef === scope.rootRef) return true;
    if (isTempRef(parentRef) && createByTempId.has(parentRef)) return true;
    return descendantsOfRoot?.has(parentRef) ?? false;
  };

  /** ref(tempId|UUID|null) の存在を検証。null は許可。 */
  const refExists = (ref: NodeRef | null): boolean => {
    if (ref == null) return true;
    if (isTempRef(ref)) return createByTempId.has(ref);
    const node = byId.get(ref);
    return node != null && node.projectId === projectId;
  };

  /** op の最終 parent を返す(create=parentRef / move=newParentRef)。 */
  const finalParentOf = (op: AiTreeOp): NodeRef | null | undefined => {
    if (op.op === "create") return op.parentRef;
    if (op.op === "move") return op.newParentRef;
    return undefined; // rename は parent を変えない
  };

  // 各ノードの「最終 parent」を mixed namespace で持つ(既存 → create → move 上書き)。
  // afterRef の最終 sibling 判定 (f) と循環検出 (c)(d) の両方で使う。move 対象を
  // anchor にした自然な再編(新フォルダへ s1 を移動 → s2 を afterRef:s1 で同フォルダへ)
  // を弾かないよう、afterRef の親は「現在」ではなく「最終」を見る(placement.ts と整合)。
  const finalParentByRef = new Map<NodeRef, NodeRef | null>();
  for (const n of nodes) finalParentByRef.set(n.id, n.parentId);
  for (const c of createByTempId.values()) {
    finalParentByRef.set(c.tempId, c.parentRef);
  }
  for (const op of plan.ops) {
    if (op.op === "move") finalParentByRef.set(op.nodeId, op.newParentRef);
  }

  // ── op ごとの (e)(a)(b)(f) 検証 ──────────────────────────────────
  plan.ops.forEach((op, i) => {
    // (e) allowedOps
    if (!scope.allowedOps.includes(op.op)) {
      push("op_not_allowed", `この文脈では ${op.op} は許可されていません`, i);
    }

    if (op.op === "rename") {
      // (a) 存在 + (e) editable
      if (!refExists(op.nodeId)) {
        push("missing_node", `rename 対象が存在しません: ${op.nodeId}`, i);
      } else if (!scope.editableIds.has(op.nodeId)) {
        push("out_of_scope", `rename 対象が編集範囲外です: ${op.nodeId}`, i);
      }
      return;
    }

    // create / move
    if (op.op === "move") {
      if (!refExists(op.nodeId) || isTempRef(op.nodeId)) {
        push("missing_node", `move 対象が存在しません: ${op.nodeId}`, i);
      } else if (!scope.editableIds.has(op.nodeId)) {
        push("out_of_scope", `move 対象が編集範囲外です: ${op.nodeId}`, i);
      }
    }

    const parentRef = finalParentOf(op) ?? null;
    // (a) 親の存在
    if (!refExists(parentRef)) {
      push("missing_parent", `親ノードが存在しません: ${String(parentRef)}`, i);
    }
    // (e) 親が scope 内
    if (!parentInScope(parentRef)) {
      push(
        "parent_out_of_scope",
        `親が編集範囲外です: ${String(parentRef)}`,
        i,
      );
    }
    // (b) 親子型ルール
    if (parentRef != null && refExists(parentRef)) {
      const parentType = isTempRef(parentRef)
        ? createByTempId.get(parentRef)!.nodeType
        : byId.get(parentRef)!.nodeType;
      if (!typeAllowsChildren(parentType)) {
        push("bad_parent_type", `${parentType} は子を持てません`, i);
      }
    }

    // (f) afterRef 厳格化
    const afterRef = op.pos?.afterRef;
    if (afterRef != null) {
      const selfId = op.op === "create" ? op.tempId : op.nodeId;
      if (afterRef === selfId) {
        push("after_self", "afterRef が自分自身を指しています", i);
      } else if (!refExists(afterRef)) {
        push("missing_after", `afterRef が存在しません: ${afterRef}`, i);
      } else {
        const afterParent = finalParentByRef.get(afterRef) ?? null;
        if (afterParent !== parentRef) {
          push(
            "after_cross_parent",
            "afterRef が最終 parent の兄弟ではありません",
            i,
          );
        } else if (
          !isTempRef(afterRef) &&
          !movedNodeIds.has(afterRef) &&
          !isValidOrderKey(byId.get(afterRef)?.sortOrder ?? "")
        ) {
          // afterRef が既存 anchor だが sortOrder が壊れている。placement は無効キー
          // anchor を弾いて末尾 append に黙ってフォールバックし、位置指定が無言で
          // 無視される。validate で明示的に弾いて placement と整合させる(N3)。
          push("after_bad_anchor", "afterRef の兄弟の並び順キーが不正です", i);
        }
      }
    }
  });

  // ── (f2) afterRef 同士の循環検出 (M2) ────────────────────────────
  // inserted(create/move)同士が afterRef で閉路を作ると placement が「根」を emit
  // できず、その op を黙って drop する(createdIds/movedIds と実 INSERT/UPDATE が
  // 食い違い、undo が存在しない行を参照する)。parent graph の hasCycle では捕まらない
  // ため、afterRef の関数グラフを別途検査する。
  if (hasAfterRefCycle(plan, createByTempId, movedNodeIds)) {
    push("after_cycle", "afterRef の参照が循環しています");
  }

  // ── (c)(d) 最終 forest 非循環 ────────────────────────────────────
  if (hasCycle(finalParentByRef)) {
    push("cycle", "操作の結果ツリーに循環が生じます");
  }

  if (errors.length > 0) return { ok: false, errors };

  // ── 成功: create を topological 順(親が先)に並べて返す ───────────
  const orderedCreates = topoSortCreates([...createByTempId.values()]);
  return { ok: true, orderedCreates, tempIds };
}

/**
 * inserted(create/move)ops の afterRef は各 op 高々 1 辺の関数グラフ。閉路があると
 * placement が根を emit できず drop するため、ここで検出して reject する。
 */
function hasAfterRefCycle(
  plan: AiTreePlan,
  createByTempId: Map<string, CreateOp>,
  movedNodeIds: Set<string>,
): boolean {
  const insertedRefs = new Set<string>([
    ...createByTempId.keys(),
    ...movedNodeIds,
  ]);
  const edge = new Map<string, string>();
  for (const op of plan.ops) {
    if (op.op === "rename") continue; // rename は afterRef を持たない
    const self = op.op === "create" ? op.tempId : op.nodeId;
    const after = op.pos?.afterRef;
    // afterRef が別の inserted op を指すときだけ辺を張る(anchor 行きは placement の根)。
    if (after != null && insertedRefs.has(after)) edge.set(self, after);
  }
  const done = new Set<string>();
  for (const start of edge.keys()) {
    if (done.has(start)) continue;
    const path = new Set<string>();
    let cur: string | undefined = start;
    while (cur != null && !done.has(cur)) {
      if (path.has(cur)) return true; // back-edge → 閉路
      path.add(cur);
      cur = edge.get(cur);
    }
    for (const n of path) done.add(n);
  }
  return false;
}

/** colored DFS による閉路検出。parentOf は mixed namespace。 */
function hasCycle(parentOf: Map<NodeRef, NodeRef | null>): boolean {
  const state = new Map<NodeRef, 1 | 2>(); // 1=in-stack, 2=done
  const stack: { id: NodeRef; phase: 0 | 1 }[] = [];
  for (const start of parentOf.keys()) {
    if (state.get(start) === 2) continue;
    stack.push({ id: start, phase: 0 });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.phase === 0) {
        const s = state.get(frame.id);
        if (s === 1) return true; // back-edge
        if (s === 2) {
          stack.pop();
          continue;
        }
        state.set(frame.id, 1);
        frame.phase = 1;
        const parent = parentOf.get(frame.id);
        if (parent != null && parentOf.has(parent)) {
          stack.push({ id: parent, phase: 0 });
        }
      } else {
        state.set(frame.id, 2);
        stack.pop();
      }
    }
  }
  return false;
}

/** create を「親 tempId が先」になるよう topological sort。既存 UUID 親は依存辺なし。 */
function topoSortCreates(creates: CreateOp[]): CreateOp[] {
  const byTempId = new Map(creates.map((c) => [c.tempId, c]));
  const result: CreateOp[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (c: CreateOp) => {
    if (visited.has(c.tempId)) return;
    if (visiting.has(c.tempId)) return; // cycle (既に hasCycle で弾かれている)
    visiting.add(c.tempId);
    const p = c.parentRef;
    if (p != null && byTempId.has(p)) visit(byTempId.get(p)!);
    visiting.delete(c.tempId);
    visited.add(c.tempId);
    result.push(c);
  };
  for (const c of creates) visit(c);
  return result;
}
