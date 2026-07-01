/**
 * A/B 比較履歴 (③) の永続化 CRUD。Drizzle ORM のみ (生 SQL 禁止)。
 * テーブルは src/db/schema.ts abComparisonRuns / migrate.rs ab_comparison_runs。
 *
 * N 枠 (スロット) 対応の正規化されていない監査ログ: 1 比較 = 1 行で、各枠の構成と
 * 応答を `slots` 列に JSON TEXT で持つ。採用した枠は `chosen` (slotId) で記録する。
 * 現状この履歴を読む UI は無く、best-effort 記録に徹する (失敗は比較体験を止めない)。
 */

import { db } from "@/db/client";
import { abComparisonRuns } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { AbComparisonRun } from "@/db/schema";
import type { AbSurface } from "./abHarness";
import { recordChangeEvent } from "@/features/timelapse/recorder";

/** 1 枠の記録 (構成 + 応答/エラー)。 */
export interface AbRunSlotRecord {
  /** 採用判定に使う安定 id (基準枠は "baseline")。 */
  slotId: string;
  /** プロバイダ override (基準枠 / 未指定なら null)。 */
  provider: string | null;
  /** モデル override (未指定なら null = 既定)。 */
  model: string | null;
  /** プロンプト追記指示 (なければ null)。 */
  promptVariant: string | null;
  /** 成功したか。 */
  ok: boolean;
  /** 応答本文 (ok=true) またはエラーメッセージ (ok=false)。 */
  response: string;
}

export interface CreateAbRunInput {
  projectId: string;
  surface: AbSurface;
  /** 基底プロンプト要旨 (表示・あとで何を比べたか分かる程度)。 */
  prompt: string;
  slots: AbRunSlotRecord[];
  /** 作成時点で採用が確定していれば slotId。通常は後から setAbRunChosen。 */
  chosen?: string | null;
}

export async function createAbRun(
  input: CreateAbRunInput,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(abComparisonRuns).values({
    id,
    projectId: input.projectId,
    surface: input.surface,
    prompt: input.prompt,
    slots: JSON.stringify(input.slots),
    chosen: input.chosen ?? null,
    createdAt: now,
  });
  recordChangeEvent({
    domain: "abtest",
    opType: "run.create",
    entityType: "ab_run",
    entityId: id,
    payload: {
      runId: id,
      surface: input.surface,
      slotCount: input.slots.length,
      chosen: input.chosen ?? null,
    },
  });
  return { id };
}

/** プロジェクトの A/B 履歴を新しい順に取得する。 */
export async function listAbRuns(
  projectId: string,
): Promise<AbComparisonRun[]> {
  return db
    .select()
    .from(abComparisonRuns)
    .where(eq(abComparisonRuns.projectId, projectId))
    .orderBy(desc(abComparisonRuns.createdAt));
}

/** 採用した枠 (slotId) を記録する。project スコープで限定 (fail-closed)。 */
export async function setAbRunChosen(
  projectId: string,
  id: string,
  chosenSlotId: string,
): Promise<void> {
  await db
    .update(abComparisonRuns)
    .set({ chosen: chosenSlotId })
    .where(
      and(
        eq(abComparisonRuns.id, id),
        eq(abComparisonRuns.projectId, projectId),
      ),
    );
  recordChangeEvent({
    domain: "abtest",
    opType: "run.chosen",
    entityType: "ab_run",
    entityId: id,
    payload: { runId: id, chosenSlotId },
  });
}
