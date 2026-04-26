import { db } from "@/db/client";
import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { invoke } from "@/lib/tauri";
import {
  foreshadows,
  foreshadowSetups,
  foreshadowCodexLinks,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { NewForeshadow, NewForeshadowSetup } from "@/db/schema";
import type { ForeshadowRow, ForeshadowSetupRow } from "./types";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") return new Date(value);
  return new Date(0);
}

function toNullableDate(value: unknown): Date | null {
  if (value == null) return null;
  return toDate(value);
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return false;
}

function normalizeForeshadowRow(raw: unknown): ForeshadowRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    projectId: String(row.projectId ?? row.project_id ?? ""),
    title: String(row.title ?? ""),
    intent: (row.intent as string | null | undefined) ?? null,
    notes: (row.notes as string | null | undefined) ?? null,
    payoffSceneId:
      (row.payoffSceneId as string | null | undefined) ??
      (row.payoff_scene_id as string | null | undefined) ??
      null,
    payoffFromPos:
      (row.payoffFromPos as number | null | undefined) ??
      (row.payoff_from_pos as number | null | undefined) ??
      null,
    payoffToPos:
      (row.payoffToPos as number | null | undefined) ??
      (row.payoff_to_pos as number | null | undefined) ??
      null,
    payoffConfirmed: toBool(row.payoffConfirmed ?? row.payoff_confirmed),
    abandoned: toBool(row.abandoned),
    createdAt: toDate(row.createdAt ?? row.created_at),
    updatedAt: toDate(row.updatedAt ?? row.updated_at),
  };
}

function normalizeSetupRow(raw: unknown): ForeshadowSetupRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id ?? ""),
    foreshadowId: String(row.foreshadowId ?? row.foreshadow_id ?? ""),
    sceneId: String(row.sceneId ?? row.scene_id ?? ""),
    fromPos: Number(row.fromPos ?? row.from_pos ?? 0),
    toPos: Number(row.toPos ?? row.to_pos ?? 0),
    kind: String(row.kind ?? "designated_existing") as ForeshadowSetupRow["kind"],
    strength: (row.strength as ForeshadowSetupRow["strength"] | undefined) ?? null,
    aiStrength:
      (row.aiStrength as ForeshadowSetupRow["aiStrength"] | undefined) ??
      (row.ai_strength as ForeshadowSetupRow["aiStrength"] | undefined) ??
      null,
    aiReasoning:
      (row.aiReasoning as string | null | undefined) ??
      (row.ai_reasoning as string | null | undefined) ??
      null,
    attribution:
      (row.attribution as ForeshadowSetupRow["attribution"] | undefined) ??
      "human",
    aiRationale:
      (row.aiRationale as string | null | undefined) ??
      (row.ai_rationale as string | null | undefined) ??
      null,
    lastEvaluatedAt: toNullableDate(
      row.lastEvaluatedAt ?? row.last_evaluated_at,
    ),
    isOrphan: toBool(row.isOrphan ?? row.is_orphan),
    createdAt: toDate(row.createdAt ?? row.created_at),
    updatedAt: toDate(row.updatedAt ?? row.updated_at),
  };
}

// ── Foreshadow CRUD ───────────────────────────────────────────────

export async function createForeshadow(
  data: Omit<NewForeshadow, "createdAt" | "updatedAt">,
): Promise<ForeshadowRow> {
  if (isTauriRuntime()) {
    const created = await invoke("foreshadow_create", {
      payload: {
        projectId: data.projectId,
        title: data.title,
        intent: data.intent ?? null,
      },
    });
    return normalizeForeshadowRow(created);
  }

  const now = new Date();
  const row: NewForeshadow = { ...data, createdAt: now, updatedAt: now };
  await db.insert(foreshadows).values(row);
  const [created] = await db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.id, data.id));
  return created as ForeshadowRow;
}

export async function getForeshadow(id: string): Promise<ForeshadowRow | null> {
  if (isTauriRuntime()) {
    const detail = await invoke<{ foreshadow: unknown | null }>(
      "foreshadow_get",
      { id },
    );
    return detail.foreshadow ? normalizeForeshadowRow(detail.foreshadow) : null;
  }

  const [row] = await db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.id, id));
  return (row as ForeshadowRow) ?? null;
}

export async function listForeshadows(
  projectId: string,
): Promise<ForeshadowRow[]> {
  if (isTauriRuntime()) {
    const rows = await invoke<unknown[]>("foreshadow_list", {
      projectId,
      filter: null,
    });
    return rows.map(normalizeForeshadowRow);
  }

  return db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.projectId, projectId)) as Promise<ForeshadowRow[]>;
}

export async function updateForeshadow(
  id: string,
  patch: Partial<
    Pick<
      ForeshadowRow,
      | "title"
      | "intent"
      | "notes"
      | "payoffConfirmed"
      | "abandoned"
      | "payoffSceneId"
      | "payoffFromPos"
      | "payoffToPos"
    >
  >,
): Promise<void> {
  if (isTauriRuntime()) {
    const tauriPatch: Record<string, unknown> = {};
    if (patch.title !== undefined) tauriPatch.title = patch.title;
    if (patch.intent !== undefined) tauriPatch.intent = patch.intent;
    if (patch.notes !== undefined) tauriPatch.notes = patch.notes;
    if (patch.payoffSceneId !== undefined) {
      tauriPatch.payoffSceneId = patch.payoffSceneId;
    }
    if (patch.payoffFromPos !== undefined) {
      tauriPatch.payoffFromPos = patch.payoffFromPos;
    }
    if (patch.payoffToPos !== undefined) tauriPatch.payoffToPos = patch.payoffToPos;
    if (patch.payoffConfirmed !== undefined) {
      tauriPatch.payoffConfirmed = patch.payoffConfirmed;
    }
    if (patch.abandoned !== undefined) tauriPatch.abandoned = patch.abandoned;

    await invoke("foreshadow_update", {
      id,
      patch: tauriPatch,
    });
    return;
  }

  await db
    .update(foreshadows)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(foreshadows.id, id));
}

export async function deleteForeshadow(id: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("foreshadow_delete", { id });
    return;
  }
  await db.delete(foreshadows).where(eq(foreshadows.id, id));
}

// ── ForeshadowSetup CRUD ──────────────────────────────────────────

export async function createForeshadowSetup(
  data: Omit<NewForeshadowSetup, "createdAt" | "updatedAt">,
): Promise<ForeshadowSetupRow> {
  const now = new Date();
  const row: NewForeshadowSetup = { ...data, createdAt: now, updatedAt: now };
  await db.insert(foreshadowSetups).values(row);
  const [created] = await db
    .select()
    .from(foreshadowSetups)
    .where(eq(foreshadowSetups.id, data.id));
  return created as ForeshadowSetupRow;
}

export async function listSetups(
  foreshadowId: string,
): Promise<ForeshadowSetupRow[]> {
  if (isTauriRuntime()) {
    const detail = await invoke<{ setups: unknown[] }>(
      "foreshadow_get",
      { id: foreshadowId },
    );
    return (detail.setups ?? []).map(normalizeSetupRow);
  }

  return db
    .select()
    .from(foreshadowSetups)
    .where(eq(foreshadowSetups.foreshadowId, foreshadowId)) as Promise<
    ForeshadowSetupRow[]
  >;
}

export async function updateSetup(
  id: string,
  patch: Partial<
    Pick<
      ForeshadowSetupRow,
      "strength" | "aiStrength" | "aiReasoning" | "isOrphan"
    >
  >,
): Promise<void> {
  await db
    .update(foreshadowSetups)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(foreshadowSetups.id, id));
}

export async function deleteSetup(id: string): Promise<void> {
  await db.delete(foreshadowSetups).where(eq(foreshadowSetups.id, id));
}

export async function reanchorOrphanSetup(
  setupId: string,
  anchor: { sceneId: string; fromPos: number; toPos: number },
): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("foreshadow_resolve_orphan", {
      payload: {
        setupId,
        action: "reanchor",
        sceneId: anchor.sceneId,
        fromPos: anchor.fromPos,
        toPos: anchor.toPos,
      },
    });
    return;
  }

  await db
    .update(foreshadowSetups)
    .set({
      sceneId: anchor.sceneId,
      fromPos: anchor.fromPos,
      toPos: anchor.toPos,
      isOrphan: false,
      updatedAt: new Date(),
    })
    .where(eq(foreshadowSetups.id, setupId));
}

export async function reinsertOrphanSetup(
  setupId: string,
  anchor: { sceneId: string; fromPos: number; toPos: number },
): Promise<ForeshadowSetupRow> {
  if (isTauriRuntime()) {
    const newId = await invoke<string | null>("foreshadow_resolve_orphan", {
      payload: {
        setupId,
        action: "reinsert",
        sceneId: anchor.sceneId,
        fromPos: anchor.fromPos,
        toPos: anchor.toPos,
      },
    });
    if (!newId) {
      throw new Error(`reinserted setup not found for: ${setupId}`);
    }
    const [created] = await db
      .select()
      .from(foreshadowSetups)
      .where(eq(foreshadowSetups.id, newId));
    if (!created) {
      throw new Error(`reinserted setup row missing: ${newId}`);
    }
    return normalizeSetupRow(created);
  }

  const [existing] = await db
    .select()
    .from(foreshadowSetups)
    .where(eq(foreshadowSetups.id, setupId));
  if (!existing) {
    throw new Error(`setup not found: ${setupId}`);
  }

  const now = new Date();
  const newId = crypto.randomUUID();
  const row: NewForeshadowSetup = {
    ...existing,
    id: newId,
    sceneId: anchor.sceneId,
    fromPos: anchor.fromPos,
    toPos: anchor.toPos,
    kind: "inserted_new",
    isOrphan: false,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(foreshadowSetups).values(row);
  await db.delete(foreshadowSetups).where(eq(foreshadowSetups.id, setupId));

  const [created] = await db
    .select()
    .from(foreshadowSetups)
    .where(eq(foreshadowSetups.id, newId));
  return created as ForeshadowSetupRow;
}

// ── Codex link CRUD ───────────────────────────────────────────────

export async function addCodexLink(
  foreshadowId: string,
  codexEntryId: string,
): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("foreshadow_link_codex", {
      foreshadowId,
      codexId: codexEntryId,
    });
    return;
  }

  await db
    .insert(foreshadowCodexLinks)
    .values({ foreshadowId, codexEntryId })
    .onConflictDoNothing();
}

export async function removeCodexLink(
  foreshadowId: string,
  codexEntryId: string,
): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("foreshadow_unlink_codex", {
      foreshadowId,
      codexId: codexEntryId,
    });
    return;
  }

  await db
    .delete(foreshadowCodexLinks)
    .where(
      and(
        eq(foreshadowCodexLinks.foreshadowId, foreshadowId),
        eq(foreshadowCodexLinks.codexEntryId, codexEntryId),
      ),
    );
}

// ── AI propose stub ───────────────────────────────────────────────

export interface ProposedSetup {
  sceneId: string;
  kind: "designated_existing" | "inserted_new";
  existingExcerpt?: string;
  fromPosHint?: number;
  toPosHint?: number;
  suggestedInsertionPoint?: string;
  suggestedText?: string;
  rationale: string;
  predictedStrength: "subtle" | "moderate" | "overt";
}

export interface ProposeRequest {
  intent: string;
  payoffSceneId: string;
  payoffExcerpt: string;
  pastScenes: Array<{
    sceneId: string;
    title: string;
    excerpt: string;
    orderIndex: number;
  }>;
  relatedCodex: Array<{
    id: string;
    name: string;
    summary: string;
  }>;
}

interface ProposeResponse {
  candidates: ProposedSetup[];
}

function isValidCandidate(candidate: unknown): candidate is ProposedSetup {
  const c = candidate as Partial<ProposedSetup>;
  return (
    typeof c.sceneId === "string" &&
    (c.kind === "designated_existing" || c.kind === "inserted_new") &&
    typeof c.rationale === "string" &&
    (c.predictedStrength === "subtle" ||
      c.predictedStrength === "moderate" ||
      c.predictedStrength === "overt")
  );
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

export async function proposePastSetups(
  req: ProposeRequest,
): Promise<ProposedSetup[]> {
  if (isTauriRuntime()) {
    const res = await invoke<{ candidates: ProposedSetup[] }>(
      "foreshadow_propose_past_setups",
      { req },
    );
    if (!Array.isArray(res?.candidates)) return [];
    return res.candidates.filter(isValidCandidate);
  }

  const sceneSummary = req.pastScenes
    .slice(0, 30)
    .map(
      (scene) =>
        `- sceneId=${scene.sceneId}, title=${scene.title}, order=${scene.orderIndex}\n  excerpt: ${scene.excerpt}`,
    )
    .join("\n");
  const codexSummary = req.relatedCodex
    .slice(0, 20)
    .map((entry) => `- ${entry.name}: ${entry.summary}`)
    .join("\n");

  const prompt = [
    "あなたは小説編集アシスタントです。",
    "回収シーンを成立させるために、過去シーンに置く setup 候補を提案してください。",
    "必ず JSON のみを返してください（前置き・解説禁止）。",
    "JSON 形式:",
    '{"candidates":[{"sceneId":"...","kind":"designated_existing|inserted_new","existingExcerpt":"...","fromPosHint":1,"toPosHint":2,"suggestedInsertionPoint":"...","suggestedText":"...","rationale":"...","predictedStrength":"subtle|moderate|overt"}]}',
    "",
    `intent: ${req.intent}`,
    `payoffSceneId: ${req.payoffSceneId}`,
    `payoffExcerpt: ${req.payoffExcerpt}`,
    "",
    "[pastScenes]",
    sceneSummary || "(none)",
    "",
    "[relatedCodex]",
    codexSummary || "(none)",
  ].join("\n");

  const response = await sendChatMessageWithThinking([
    { role: "user", content: prompt },
  ]);
  const jsonText = extractJsonObject(response.text);
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText) as ProposeResponse;
    if (!Array.isArray(parsed.candidates)) return [];
    return parsed.candidates.filter(isValidCandidate);
  } catch {
    return [];
  }
}
