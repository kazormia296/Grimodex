import { db } from "@/db/client";
import { labels, treeNodeLabels } from "@/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { recordChangeEvent } from "@/features/timelapse/recorder";

export type Label = typeof labels.$inferSelect;

export async function listLabels(projectId: string): Promise<Label[]> {
  return db
    .select()
    .from(labels)
    .where(eq(labels.projectId, projectId))
    .orderBy(asc(labels.sortOrder), asc(labels.name));
}

export async function createLabel(data: {
  id: string;
  projectId: string;
  name: string;
  color: string;
  sortOrder?: number;
}): Promise<Label> {
  const rows = await db
    .insert(labels)
    .values({
      id: data.id,
      projectId: data.projectId,
      name: data.name,
      color: data.color,
      sortOrder: data.sortOrder ?? 0.0,
      createdAt: new Date().toISOString(),
    })
    .returning();
  recordChangeEvent({
    domain: "labels",
    opType: "label.create",
    entityType: "label",
    entityId: data.id,
    payload: { labelId: data.id, name: data.name, color: data.color },
  });
  return rows[0];
}

export async function updateLabel(
  id: string,
  data: { name?: string; color?: string; sortOrder?: number },
): Promise<Label | undefined> {
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.color !== undefined) updateData.color = data.color;
  if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
  const rows = await db
    .update(labels)
    .set(updateData)
    .where(eq(labels.id, id))
    .returning();
  recordChangeEvent({
    domain: "labels",
    opType: "label.update",
    entityType: "label",
    entityId: id,
    payload: { labelId: id, fields: Object.keys(updateData) },
  });
  return rows[0];
}

export async function deleteLabel(id: string): Promise<void> {
  await db.delete(labels).where(eq(labels.id, id));
  recordChangeEvent({
    domain: "labels",
    opType: "label.delete",
    entityType: "label",
    entityId: id,
    payload: { labelId: id },
  });
}

export async function listNodeLabels(nodeId: string): Promise<Label[]> {
  const rows = await db
    .select({ label: labels })
    .from(treeNodeLabels)
    .innerJoin(labels, eq(treeNodeLabels.labelId, labels.id))
    .where(eq(treeNodeLabels.nodeId, nodeId))
    .orderBy(asc(labels.sortOrder), asc(labels.name));
  return rows.map((r) => r.label);
}

export async function listNodeLabelIds(nodeId: string): Promise<string[]> {
  const rows = await db
    .select({ labelId: treeNodeLabels.labelId })
    .from(treeNodeLabels)
    .where(eq(treeNodeLabels.nodeId, nodeId));
  return rows.map((r) => r.labelId);
}

export async function setNodeLabels(
  nodeId: string,
  labelIds: string[],
): Promise<void> {
  await db.delete(treeNodeLabels).where(eq(treeNodeLabels.nodeId, nodeId));
  if (labelIds.length > 0) {
    await db
      .insert(treeNodeLabels)
      .values(labelIds.map((labelId) => ({ nodeId, labelId })));
  }
  recordChangeEvent({
    domain: "labels",
    opType: "node.labels.set",
    entityType: "tree_node",
    entityId: nodeId,
    // sceneId left null: nodeId may be a chapter/folder, not necessarily a
    // scene FK — a bad FK would wedge the flush loop.
    payload: { nodeId, labelIds },
  });
}

export async function reorderLabels(orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await db
      .update(labels)
      .set({ sortOrder: i * 1.0 })
      .where(eq(labels.id, orderedIds[i]));
  }
  recordChangeEvent({
    domain: "labels",
    opType: "label.reorder",
    payload: { orderedIds },
  });
}

export async function countNodesWithLabel(labelId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(treeNodeLabels)
    .where(eq(treeNodeLabels.labelId, labelId));
  return rows[0]?.count ?? 0;
}

export async function listAllNodeLabels(
  projectId: string,
): Promise<Record<string, string[]>> {
  const rows = await db
    .select({
      nodeId: treeNodeLabels.nodeId,
      labelId: treeNodeLabels.labelId,
    })
    .from(treeNodeLabels)
    .innerJoin(labels, eq(treeNodeLabels.labelId, labels.id))
    .where(eq(labels.projectId, projectId));

  const result: Record<string, string[]> = {};
  for (const { nodeId, labelId } of rows) {
    (result[nodeId] ??= []).push(labelId);
  }
  return result;
}
