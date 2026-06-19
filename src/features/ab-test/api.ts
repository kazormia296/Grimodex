/**
 * A/B 比較履歴 (③) の永続化 CRUD。Drizzle ORM のみ (生 SQL 禁止)。
 * テーブルは src/db/schema.ts abComparisons / migrate.rs ab_comparisons。
 */

import { db } from "@/db/client";
import { abComparisons } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { AbComparison } from "@/db/schema";
import type { AbSurface } from "./abHarness";

export type AbComparisonRow = AbComparison;
export type AbChoice = "a" | "b";

export interface CreateAbComparisonInput {
  projectId: string;
  surface: AbSurface;
  /** 基底プロンプト要旨 (表示・あとで何を比べたか分かる程度)。 */
  prompt: string;
  modelA?: string | null;
  modelB?: string | null;
  promptVariantA?: string | null;
  promptVariantB?: string | null;
  responseA: string;
  responseB: string;
  /** 作成時点で採用が確定していれば。通常は後から setChosen。 */
  chosen?: AbChoice | null;
}

export async function createAbComparison(
  input: CreateAbComparisonInput,
): Promise<AbComparison> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = await db
    .insert(abComparisons)
    .values({
      id,
      projectId: input.projectId,
      surface: input.surface,
      prompt: input.prompt,
      modelA: input.modelA ?? null,
      modelB: input.modelB ?? null,
      promptVariantA: input.promptVariantA ?? null,
      promptVariantB: input.promptVariantB ?? null,
      responseA: input.responseA,
      responseB: input.responseB,
      chosen: input.chosen ?? null,
      createdAt: now,
    })
    .returning();
  return rows[0];
}

/** プロジェクトの A/B 履歴を新しい順に取得する。 */
export async function listAbComparisons(
  projectId: string,
): Promise<AbComparison[]> {
  return db
    .select()
    .from(abComparisons)
    .where(eq(abComparisons.projectId, projectId))
    .orderBy(desc(abComparisons.createdAt));
}

/** 単一 A/B 履歴を取得 (project スコープで fail-closed)。 */
export async function getAbComparison(
  projectId: string,
  id: string,
): Promise<AbComparison | undefined> {
  const rows = await db
    .select()
    .from(abComparisons)
    .where(
      and(eq(abComparisons.id, id), eq(abComparisons.projectId, projectId)),
    );
  return rows[0];
}

/** 採用したカラム ("a" | "b") を記録する。project スコープで限定。 */
export async function setAbChosen(
  projectId: string,
  id: string,
  chosen: AbChoice,
): Promise<void> {
  await db
    .update(abComparisons)
    .set({ chosen })
    .where(
      and(eq(abComparisons.id, id), eq(abComparisons.projectId, projectId)),
    );
}
