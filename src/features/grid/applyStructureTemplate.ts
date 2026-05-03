import i18next from "@/lib/i18n";
import * as treeApi from "@/features/tree/api";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  generateKeyBetween,
  generateNKeysBetween,
} from "@/features/tree/fractionalIndex";
import {
  countTemplateNodes,
  findTemplate,
  type StructureNode,
  type StructureTemplate,
} from "./structureTemplates";

export interface ApplyStructureTemplateResult {
  folders: number;
  scenes: number;
  rootFolderId: string;
}

/**
 * 構造テンプレートを適用する。
 *
 * - `containerId` 直下に新規 root folder を 1 つ作り、その配下にテンプレートの骨格を展開する
 * - 既存構造は破壊しない（root folder の sortOrder は末尾に置く）
 * - 各 placeholder scene の synopsis にはテンプレート由来の説明文を初期値として埋める
 *
 * 履歴は捕捉していない（一括適用 = atomic な1操作とみなす。
 * undo したい場合は root folder ごと削除する操作で代替できる）。
 */
export async function applyStructureTemplate(
  projectId: string,
  templateKey: string,
  containerId: string | null,
): Promise<ApplyStructureTemplateResult> {
  const template = findTemplate(templateKey);
  if (!template) throw new Error(`Unknown template key: ${templateKey}`);

  // 1. Compute root folder name (auto-numbered: "{templateName} - {N}")
  const templateName = i18next.t(
    `grid.structureTemplates.${template.key}.name`,
    { defaultValue: template.key },
  );
  const allNodes = await treeApi.listNodes(projectId);
  const siblingsOfRoot = allNodes.filter(
    (n) => (n.parentId ?? null) === containerId,
  );
  const rootFolderName = computeRootFolderName(templateName, siblingsOfRoot);

  // 2. Compute sortOrder for the new root folder (end of siblings)
  const lastSibling = sortBySortOrder(siblingsOfRoot).at(-1);
  const rootSortOrder = generateKeyBetween(
    lastSibling ? lastSibling.sortOrder : null,
    null,
  );

  // 3. Create the root folder
  const rootFolderId = crypto.randomUUID();
  await treeApi.createNode({
    id: rootFolderId,
    projectId,
    parentId: containerId ?? undefined,
    nodeType: "folder",
    title: rootFolderName,
    sortOrder: rootSortOrder,
  });

  // 4. Recursively create children
  await createChildren(
    projectId,
    template,
    rootFolderId,
    template.rootChildren,
  );

  // 5. Reload tree store so UI reflects the new nodes
  await useTreeStore.getState().loadTree(projectId);

  // 6. Report counts
  const counts = countTemplateNodes(template);
  return {
    folders: counts.folders,
    scenes: counts.scenes,
    rootFolderId,
  };
}

async function createChildren(
  projectId: string,
  template: StructureTemplate,
  parentId: string,
  children: StructureNode[],
): Promise<void> {
  if (children.length === 0) return;

  // Generate fractional-index sortOrder keys for all siblings at this level
  const keys = generateNKeysBetween(null, null, children.length);

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
        parentId,
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
        parentId,
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

/**
 * "{templateName}", "{templateName} 2", "{templateName} 3" ... と auto-numbering する。
 * 同名の root folder が既に存在する場合は次の番号を付与。
 */
function computeRootFolderName(
  templateName: string,
  siblings: { title: string }[],
): string {
  const existingNames = new Set(siblings.map((s) => s.title));
  if (!existingNames.has(templateName)) return templateName;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${templateName} ${n}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `${templateName} ${Date.now()}`;
}
