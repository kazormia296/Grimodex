import { db } from "@/db/client";
import { promptTemplates } from "@/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { recordChangeEvent } from "@/features/timelapse/recorder";

export type PromptTemplate = typeof promptTemplates.$inferSelect;
export type NewPromptTemplate = typeof promptTemplates.$inferInsert;

/**
 * プロジェクトに属するプロンプトテンプレートを新しい順に返す。
 */
export async function listPromptTemplates(
  projectId: string,
): Promise<PromptTemplate[]> {
  return db
    .select()
    .from(promptTemplates)
    .where(eq(promptTemplates.projectId, projectId))
    .orderBy(desc(promptTemplates.createdAt));
}

/**
 * id 指定で 1 件取得。project_id スコープで cross-project read を塞ぐ。
 */
export async function getPromptTemplate(
  projectId: string,
  id: string,
): Promise<PromptTemplate | undefined> {
  const rows = await db
    .select()
    .from(promptTemplates)
    .where(
      and(eq(promptTemplates.id, id), eq(promptTemplates.projectId, projectId)),
    );
  return rows[0];
}

/**
 * 新規テンプレート作成。id は呼び出し側が crypto.randomUUID() で採番する。
 */
export async function createPromptTemplate(
  data: Pick<NewPromptTemplate, "id" | "projectId" | "title" | "content">,
): Promise<PromptTemplate> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(promptTemplates)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  recordChangeEvent({
    domain: "prompt",
    opType: "template.create",
    entityType: "prompt_template",
    entityId: data.id,
    payload: { templateId: data.id, title: data.title },
  });
  return rows[0];
}

/**
 * タイトル / 本文を更新。updated_at を必ず差し替える。
 */
export async function updatePromptTemplate(
  projectId: string,
  id: string,
  data: Partial<Pick<NewPromptTemplate, "title" | "content">>,
): Promise<PromptTemplate | undefined> {
  const rows = await db
    .update(promptTemplates)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(
      and(eq(promptTemplates.id, id), eq(promptTemplates.projectId, projectId)),
    )
    .returning();
  recordChangeEvent({
    domain: "prompt",
    opType: "template.update",
    entityType: "prompt_template",
    entityId: id,
    payload: { templateId: id, fields: Object.keys(data) },
  });
  return rows[0];
}

/**
 * テンプレートを削除。
 */
export async function deletePromptTemplate(
  projectId: string,
  id: string,
): Promise<void> {
  await db
    .delete(promptTemplates)
    .where(
      and(eq(promptTemplates.id, id), eq(promptTemplates.projectId, projectId)),
    );
  recordChangeEvent({
    domain: "prompt",
    opType: "template.delete",
    entityType: "prompt_template",
    entityId: id,
    payload: { templateId: id },
  });
}

/**
 * 挿入時に呼ぶ。使用回数を 1 増やす（よく使うテンプレを上位に出す素地）。
 */
export async function incrementPromptTemplateUsage(
  projectId: string,
  id: string,
): Promise<void> {
  await db
    .update(promptTemplates)
    .set({ usageCount: sql`${promptTemplates.usageCount} + 1` })
    .where(
      and(eq(promptTemplates.id, id), eq(promptTemplates.projectId, projectId)),
    );
  recordChangeEvent({
    domain: "prompt",
    opType: "template.use",
    entityType: "prompt_template",
    entityId: id,
    payload: { templateId: id },
  });
}
