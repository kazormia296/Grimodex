import i18next from "@/lib/i18n";
import * as treeApi from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { generateNKeysBetween } from "@/features/tree/fractionalIndex";
import {
  countTemplateNodes,
  findTemplate,
  type StructureNode,
  type StructureTemplate,
} from "./structureTemplates";

export interface ApplyStructureTemplateResult {
  folders: number;
  scenes: number;
}

/**
 * 構造テンプレートを適用する。
 *
 * - `containerId` 直下にテンプレートの `rootChildren` を直置きで展開する
 *   （構造名のラッパーフォルダは作らない）
 * - 既存構造は破壊しない（新規ノードは末尾に追加）
 * - 各 placeholder scene の synopsis にはテンプレート由来の説明文を初期値として埋める
 *
 * 履歴は捕捉していない（一括適用 = atomic な1操作とみなす）。
 */
export async function applyStructureTemplate(
  projectId: string,
  templateKey: string,
  containerId: string | null,
): Promise<ApplyStructureTemplateResult> {
  const template = findTemplate(templateKey);
  if (!template) throw new Error(`Unknown template key: ${templateKey}`);

  const allNodes = await treeApi.listNodes(projectId);
  const siblings = allNodes.filter((n) => (n.parentId ?? null) === containerId);
  const lastSibling = sortBySortOrder(siblings).at(-1);
  const startKey = lastSibling ? lastSibling.sortOrder : null;

  await createChildren(
    projectId,
    template,
    containerId,
    template.rootChildren,
    startKey,
    null,
  );

  await useTreeStore.getState().loadTree(projectId);

  return countTemplateNodes(template);
}

async function createChildren(
  projectId: string,
  template: StructureTemplate,
  parentId: string | null,
  children: StructureNode[],
  startKey: string | null = null,
  endKey: string | null = null,
): Promise<void> {
  if (children.length === 0) return;

  const keys = generateNKeysBetween(startKey, endKey, children.length);

  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    const sortOrder = keys[i];
    const id = crypto.randomUUID();
    const stageBase = `grid.structureTemplates.${template.key}.stages.${node.stage}`;
    const name = i18next.t(`${stageBase}.name`, { defaultValue: node.stage });

    if (node.kind === "folder") {
      await treeApi.createNode({
        id,
        projectId,
        parentId: parentId ?? undefined,
        nodeType: "folder",
        title: name,
        sortOrder,
      });
      if (node.children) {
        await createChildren(projectId, template, id, node.children);
      }
    } else {
      const synopsis = i18next.t(`${stageBase}.synopsis`, {
        defaultValue: "",
      });
      await treeApi.createNode({
        id,
        projectId,
        parentId: parentId ?? undefined,
        nodeType: "scene",
        title: name,
        sortOrder,
        synopsis: synopsis || undefined,
      });
    }
  }
}

function sortBySortOrder<T extends { sortOrder: string }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0,
  );
}
