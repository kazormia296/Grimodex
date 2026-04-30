import type { Node as PMNode } from "@tiptap/pm/model";

type PMJsonNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMJsonNode[];
  [key: string]: unknown;
};

/**
 * ドキュメント内の sceneBeat.attrs.id を全て収集する。
 * ペースト前の既存 ID セット構築に使用。
 */
export function collectBeatIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "sceneBeat" && typeof node.attrs.id === "string") {
      ids.add(node.attrs.id);
    }
    return true;
  });
  return ids;
}

/**
 * ペーストされた JSON ツリーを走査し、existingIds と重複する sceneBeat の id を
 * 新 UUID に採番し直す。
 * 採番された beat に紐づく generatedProseBlock の beatId も追従更新する。
 * existingIds に含まれる beatId を持つ generatedProseBlock（対応 beat が input 内に
 * 存在しない孤立ブロック）の beatId を null にする。
 */
export function renumberDuplicateBeatIds(
  json: object,
  existingIds: Set<string>,
): object {
  const root = structuredClone(json) as PMJsonNode;

  // Pass 1: collect beat ids present in the pasted content and renumber duplicates
  const idMap = new Map<string, string>(); // oldId → newId (only for renamed ones)
  const pastedBeatIds = new Set<string>();

  walkNodes(root, (node) => {
    if (node.type !== "sceneBeat") return;
    const oldId = node.attrs?.id as string | undefined;
    if (!oldId) return;
    if (existingIds.has(oldId)) {
      const newId = crypto.randomUUID();
      idMap.set(oldId, newId);
      node.attrs = { ...node.attrs, id: newId };
      pastedBeatIds.add(newId);
    } else {
      pastedBeatIds.add(oldId);
    }
  });

  // Pass 2: update generatedProseBlock beatIds
  walkNodes(root, (node) => {
    if (node.type !== "generatedProseBlock") return;
    const beatId = node.attrs?.beatId as string | undefined;
    if (!beatId) return;
    if (idMap.has(beatId)) {
      // Renamed: follow the new id
      node.attrs = { ...node.attrs, beatId: idMap.get(beatId)! };
    } else if (!pastedBeatIds.has(beatId)) {
      // Orphan: corresponding beat is not in this paste → null to trigger unwrap
      node.attrs = { ...node.attrs, beatId: null };
    }
  });

  return root;
}

function walkNodes(node: PMJsonNode, visitor: (n: PMJsonNode) => void): void {
  visitor(node);
  for (const child of node.content ?? []) {
    walkNodes(child, visitor);
  }
}
