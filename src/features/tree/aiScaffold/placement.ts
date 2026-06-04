/**
 * 検証済み AiTreePlan から、create / move 対象ノードの最終配置
 * ({parentId, sortOrder}) を算出する pure ロジック。
 *
 * 方針 = 最小再採番(moveNode 哲学): 既存の不変な兄弟(anchor)の sortOrder は
 * 触らず、新規 create と move 対象だけに、anchor の隙間(gap)ごとに
 * `generateNKeysBetween` で連番キーを割り当てる(Codex High-2 後半: gap ごとに
 * 1 連番 run で key 衝突を回避)。
 */
import {
  generateKeyBetween,
  generateNKeysBetween,
  cmpKeys,
} from "../fractionalIndex";
import type { TreeNodeData } from "../treeStore";
import { type AiTreePlan, type NodeRef, TEMP_ID_PREFIX } from "./types";

export interface NodePlacement {
  parentId: string | null;
  sortOrder: string;
}

/** treeStore の同名 private 関数と同義: 不正な fractional-indexing キーを除外する。 */
function isValidOrderKey(key: string): boolean {
  try {
    generateKeyBetween(key, null);
    return true;
  } catch {
    return false;
  }
}

interface Inserted {
  id: string; // 解決済み UUID (create は idMap, move は nodeId)
  after: string | null | undefined; // 解決済み afterRef(UUID) | null(prepend) | undefined(append)
  order: number; // plan index — 同一 gap 内の安定順序
}

/**
 * @param idMap tempId → 採番済み UUID
 * @returns nodeId(UUID) → {parentId, sortOrder}。create と move 対象のみ含む。
 */
export function assignNodePlacements(
  plan: AiTreePlan,
  nodes: TreeNodeData[],
  idMap: Map<string, string>,
): Map<string, NodePlacement> {
  const resolve = (ref: NodeRef | null): string | null => {
    if (ref == null) return null;
    if (ref.startsWith(TEMP_ID_PREFIX)) return idMap.get(ref) ?? null;
    return ref;
  };

  const movedNodeIds = new Set<string>();
  for (const op of plan.ops) if (op.op === "move") movedNodeIds.add(op.nodeId);

  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const arr = childrenByParent.get(n.parentId) ?? [];
    arr.push(n);
    childrenByParent.set(n.parentId, arr);
  }

  // 最終 parent bucket ごとに inserted を集める。
  const bucketInserted = new Map<string | null, Inserted[]>();
  const addInserted = (parent: string | null, ins: Inserted) => {
    const arr = bucketInserted.get(parent) ?? [];
    arr.push(ins);
    bucketInserted.set(parent, arr);
  };
  const resolveAfter = (pos: { afterRef?: NodeRef | null } | undefined) => {
    if (!pos || pos.afterRef === undefined) return undefined;
    if (pos.afterRef === null) return null;
    return resolve(pos.afterRef);
  };

  plan.ops.forEach((op, i) => {
    if (op.op === "create") {
      const id = idMap.get(op.tempId);
      if (id == null) return;
      addInserted(resolve(op.parentRef), {
        id,
        after: resolveAfter(op.pos),
        order: i,
      });
    } else if (op.op === "move") {
      addInserted(resolve(op.newParentRef), {
        id: op.nodeId,
        after: resolveAfter(op.pos),
        order: i,
      });
    }
  });

  const placements = new Map<string, NodePlacement>();

  for (const [parent, inserted] of bucketInserted) {
    const insertedIds = new Set(inserted.map((x) => x.id));
    const anchors = (childrenByParent.get(parent) ?? [])
      .filter((n) => !movedNodeIds.has(n.id) && isValidOrderKey(n.sortOrder))
      .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder))
      .map((n) => ({ id: n.id, key: n.sortOrder }));
    const anchorIds = new Set(anchors.map((a) => a.id));

    // emit 構造を組む: prepend / append / afterMap(target → items)
    const afterMap = new Map<string, Inserted[]>();
    const prepend: Inserted[] = [];
    const append: Inserted[] = [];
    const sortedInserted = [...inserted].sort((a, b) => a.order - b.order);
    for (const it of sortedInserted) {
      if (it.after === undefined) {
        append.push(it);
      } else if (it.after === null) {
        prepend.push(it);
      } else if (anchorIds.has(it.after) || insertedIds.has(it.after)) {
        const arr = afterMap.get(it.after) ?? [];
        arr.push(it);
        afterMap.set(it.after, arr);
      } else {
        // afterRef が anchor でも同 bucket inserted でもない(bad-key anchor 等)
        // → 末尾フォールバック。
        append.push(it);
      }
    }

    // anchor は key を保持、inserted は anchorKey=null で並べる。
    const ordered: { id: string; anchorKey: string | null }[] = [];
    const placed = new Set<string>();
    const emitInserted = (it: Inserted) => {
      if (placed.has(it.id)) return;
      placed.add(it.id);
      ordered.push({ id: it.id, anchorKey: null });
      for (const child of afterMap.get(it.id) ?? []) emitInserted(child);
    };
    for (const p of prepend) emitInserted(p);
    for (const a of anchors) {
      ordered.push({ id: a.id, anchorKey: a.key });
      for (const child of afterMap.get(a.id) ?? []) emitInserted(child);
    }
    for (const ap of append) emitInserted(ap);

    // inserted の連続 run(anchor の隙間)ごとに generateNKeysBetween。
    let i = 0;
    while (i < ordered.length) {
      if (ordered[i].anchorKey !== null) {
        i++;
        continue;
      }
      let j = i;
      while (j < ordered.length && ordered[j].anchorKey === null) j++;
      const beforeKey = i > 0 ? ordered[i - 1].anchorKey : null;
      const afterKey = j < ordered.length ? ordered[j].anchorKey : null;
      const keys = generateNKeysBetween(beforeKey, afterKey, j - i);
      for (let k = i; k < j; k++) {
        placements.set(ordered[k].id, {
          parentId: parent,
          sortOrder: keys[k - i],
        });
      }
      i = j;
    }
  }

  return placements;
}
