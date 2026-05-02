import { db } from "@/db/client";
import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { invoke } from "@/lib/tauri";
import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { getProject } from "@/features/project/api";
import {
  foreshadows,
  foreshadowSetups,
  foreshadowCodexLinks,
  codexEntries,
  treeNodes,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { NewForeshadow, NewForeshadowSetup } from "@/db/schema";
import type { CodexEntry } from "@/features/codex/api";
import type {
  ForeshadowRow,
  ForeshadowSetupRow,
  ForeshadowStrength,
  ForeshadowLoadBearing,
  AiEvaluation,
  ForeshadowWithLabel,
  ChapterAuditRequest,
  AuditCandidate,
  ChapterForeshadowStats,
  DerivedLabel,
} from "./types";
import { safeParseAiEvaluation } from "./types";
import { deriveLabel } from "./deriveLabel";

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
    loadBearing:
      ((row.loadBearing ?? row.load_bearing) as
        | ForeshadowLoadBearing
        | null
        | undefined) ?? null,
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
    kind: String(
      row.kind ?? "designated_existing",
    ) as ForeshadowSetupRow["kind"],
    strength:
      (row.strength as ForeshadowSetupRow["strength"] | undefined) ?? null,
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
        loadBearing: data.loadBearing ?? null,
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
      | "loadBearing"
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
    if (patch.payoffToPos !== undefined)
      tauriPatch.payoffToPos = patch.payoffToPos;
    if (patch.payoffConfirmed !== undefined) {
      tauriPatch.payoffConfirmed = patch.payoffConfirmed;
    }
    if (patch.abandoned !== undefined) tauriPatch.abandoned = patch.abandoned;
    if (patch.loadBearing !== undefined)
      tauriPatch.loadBearing = patch.loadBearing;

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
  if (isTauriRuntime()) {
    await invoke("foreshadow_setup_create_ai", {
      id: data.id,
      foreshadowId: data.foreshadowId,
      sceneId: data.sceneId,
      fromPos: data.fromPos,
      toPos: data.toPos,
      kind: data.kind ?? "designated_existing",
      strength: data.strength ?? null,
      aiStrength: data.aiStrength ?? null,
      attribution: data.attribution ?? "human",
      aiRationale: data.aiRationale ?? null,
      aiReasoning: data.aiReasoning ?? null,
      lastEvaluatedAt: data.lastEvaluatedAt
        ? data.lastEvaluatedAt.getTime()
        : null,
    });
    const now = new Date();
    return {
      ...data,
      createdAt: now,
      updatedAt: now,
      sceneUpdatedAt: undefined,
    } as ForeshadowSetupRow;
  }
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
    const detail = await invoke<{ setups: unknown[] }>("foreshadow_get", {
      id: foreshadowId,
    });
    return (detail.setups ?? []).map(normalizeSetupRow);
  }

  const rows = await db
    .select({
      setup: foreshadowSetups,
      sceneUpdatedAt: treeNodes.updatedAt,
    })
    .from(foreshadowSetups)
    .leftJoin(treeNodes, eq(foreshadowSetups.sceneId, treeNodes.id))
    .where(eq(foreshadowSetups.foreshadowId, foreshadowId));

  return rows.map(({ setup, sceneUpdatedAt }) => ({
    ...(setup as ForeshadowSetupRow),
    sceneUpdatedAt: sceneUpdatedAt ?? undefined,
  }));
}

export async function updateSetup(
  id: string,
  patch: Partial<
    Pick<
      ForeshadowSetupRow,
      "strength" | "aiStrength" | "aiReasoning" | "isOrphan" | "lastEvaluatedAt"
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

type LinkedCodexEntry = Pick<CodexEntry, "id" | "name">;

/** 伏線に紐付いた Codex エントリを返す。id/name のみ保証。 */
export async function listCodexEntriesByForeshadow(
  foreshadowId: string,
): Promise<LinkedCodexEntry[]> {
  if (isTauriRuntime()) {
    return invoke<LinkedCodexEntry[]>("foreshadow_list_linked_codex", {
      foreshadowId,
    });
  }

  const links = await db
    .select({ codexEntryId: foreshadowCodexLinks.codexEntryId })
    .from(foreshadowCodexLinks)
    .where(eq(foreshadowCodexLinks.foreshadowId, foreshadowId));

  if (links.length === 0) return [];

  const ids = links.map((l) => l.codexEntryId);
  return db
    .select({ id: codexEntries.id, name: codexEntries.name })
    .from(codexEntries)
    .where(inArray(codexEntries.id, ids));
}

export async function setSetupStrength(
  setupId: string,
  strength: ForeshadowStrength | null,
): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("foreshadow_set_setup_strength", { setupId, strength });
    return;
  }

  await db
    .update(foreshadowSetups)
    .set({ strength })
    .where(eq(foreshadowSetups.id, setupId));
}

/** Codex エントリに紐付いた伏線を、派生ラベル付きで返す。 */
export async function listForeshadowsByCodexEntry(
  codexEntryId: string,
): Promise<ForeshadowWithLabel[]> {
  const links = await db
    .select({ foreshadowId: foreshadowCodexLinks.foreshadowId })
    .from(foreshadowCodexLinks)
    .where(eq(foreshadowCodexLinks.codexEntryId, codexEntryId));

  if (links.length === 0) return [];

  const fids = links.map((l) => l.foreshadowId);
  const rows = await db
    .select()
    .from(foreshadows)
    .where(inArray(foreshadows.id, fids));

  const setups = await db
    .select()
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.foreshadowId, fids));

  const countMap = new Map<string, number>();
  const weakMap = new Map<string, boolean>();
  for (const s of setups) {
    if (s.isOrphan) continue;
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
    const evaluation = safeParseAiEvaluation(s.aiReasoning as string | null);
    const effectiveStrength =
      (s.strength as string | null) ??
      evaluation?.careful?.strength ??
      (s.aiStrength as string | null);
    if (effectiveStrength === "subtle") {
      weakMap.set(s.foreshadowId, true);
    }
  }

  return rows.map((r) => {
    const row = r as ForeshadowRow;
    const setupCount = countMap.get(row.id) ?? 0;
    const anyWeak = weakMap.get(row.id) ?? false;
    return { ...row, setupCount, label: deriveLabel(row, setupCount, anyWeak) };
  });
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

  let _project;
  try {
    _project = await getProject(useTreeStore.getState().projectId);
  } catch {
    // ignore
  }
  const _lang = _project?.language ?? "ja";

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

  const prompt = getPromptCatalog(
    _lang,
  ).foreshadow.buildProposePastSetupsPrompt({
    intent: req.intent,
    payoffSceneId: req.payoffSceneId,
    payoffExcerpt: req.payoffExcerpt,
    sceneSummary,
    codexSummary,
  });

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

// ── AI 強度評価 ───────────────────────────────────────────────────

export interface EvaluateStrengthRequest {
  setupId: string;
  setupExcerpt: string;
  foreshadowIntent: string;
}

export async function evaluateSetupStrength(
  req: EvaluateStrengthRequest,
): Promise<AiEvaluation | null> {
  let _project;
  try {
    _project = await getProject(useTreeStore.getState().projectId);
  } catch {
    // ignore
  }
  const prompt = getPromptCatalog(
    _project?.language ?? "ja",
  ).foreshadow.buildEvaluateSetupStrengthPrompt({
    foreshadowIntent: req.foreshadowIntent,
    setupExcerpt: req.setupExcerpt,
  });

  const response = await sendChatMessageWithThinking([
    { role: "user", content: prompt },
  ]);

  const jsonText = extractJsonObject(response.text);
  if (!jsonText) return null;

  try {
    const raw = JSON.parse(jsonText) as unknown;
    return safeParseAiEvaluation(JSON.stringify(raw));
  } catch {
    return null;
  }
}

// ── AI 監査パス ───────────────────────────────────────────────────

export type { ChapterAuditRequest, AuditCandidate, ChapterForeshadowStats };

interface AuditResponse {
  candidates: AuditCandidate[];
}

function isValidAuditCandidate(c: unknown): c is AuditCandidate {
  const o = c as Partial<AuditCandidate>;
  return (
    typeof o.suggestedTitle === "string" &&
    typeof o.suggestedIntent === "string" &&
    typeof o.evidenceSceneId === "string" &&
    typeof o.evidenceExcerpt === "string" &&
    typeof o.rationale === "string" &&
    (o.confidence === "low" ||
      o.confidence === "medium" ||
      o.confidence === "high")
  );
}

export async function auditChapter(
  req: ChapterAuditRequest,
): Promise<AuditCandidate[]> {
  if (isTauriRuntime()) {
    const res = await invoke<{ candidates: AuditCandidate[] }>(
      "foreshadow_audit_chapter",
      {
        req,
      },
    );
    if (!Array.isArray(res?.candidates)) return [];
    return res.candidates.filter(isValidAuditCandidate);
  }

  let _auditProject;
  try {
    _auditProject = await getProject(useTreeStore.getState().projectId);
  } catch {
    // ignore
  }
  const _auditLang = _auditProject?.language ?? "ja";

  const nonEmptyScenes = req.scenes.filter((s) => s.bodyText.trim().length > 0);
  if (nonEmptyScenes.length === 0) return [];

  const sceneTexts = nonEmptyScenes
    .map(
      (s) =>
        `--- sceneId=${s.sceneId}, title=${s.title}, order=${s.orderIndex} ---\n${s.bodyText}`,
    )
    .join("\n\n");

  const existingList =
    req.existingForeshadows.length > 0
      ? req.existingForeshadows
          .map(
            (f) =>
              `- id=${f.id}, title=${f.title}, intent=${f.intent ?? "(未設定)"}`,
          )
          .join("\n")
      : "(なし)";

  const codexList =
    req.relatedCodex.length > 0
      ? req.relatedCodex.map((e) => `- ${e.name}: ${e.summary}`).join("\n")
      : "(なし)";

  const prompt = getPromptCatalog(
    _auditLang,
  ).foreshadow.buildAuditChapterPrompt({
    existingList,
    codexList,
    sceneTexts,
  });

  const response = await sendChatMessageWithThinking([
    { role: "user", content: prompt },
  ]);
  const jsonText = extractJsonObject(response.text);
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText) as AuditResponse;
    if (!Array.isArray(parsed.candidates)) return [];
    return parsed.candidates.filter(isValidAuditCandidate);
  } catch {
    return [];
  }
}

// ── 章別統計 ──────────────────────────────────────────────────────

export async function getChapterForeshadowStats(
  chapterId: string,
): Promise<ChapterForeshadowStats> {
  // 章配下のシーンを取得
  const scenes = await db
    .select({
      id: treeNodes.id,
      content: treeNodes.content,
    })
    .from(treeNodes)
    .where(
      and(eq(treeNodes.parentId, chapterId), eq(treeNodes.nodeType, "scene")),
    );

  const sceneIds = scenes.map((s) => s.id);
  const scenesWithBody = scenes.filter((s) => {
    try {
      const doc = JSON.parse(s.content) as { content?: unknown[] };
      return Array.isArray(doc.content) && doc.content.length > 0;
    } catch {
      return false;
    }
  }).length;

  if (sceneIds.length === 0) {
    return {
      chapterId,
      totalScenes: 0,
      scenesWithBody: 0,
      byLabel: {},
      orphanCount: 0,
      needsStrengtheningCount: 0,
    };
  }

  // 配下シーンに関連する foreshadow を取得（setup 経由）
  const setups = await db
    .select()
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.sceneId, sceneIds));

  // payoff が配下シーンにある foreshadow も取得
  const payoffForeshadows = await db
    .select()
    .from(foreshadows)
    .where(inArray(foreshadows.payoffSceneId, sceneIds));

  // 関連 foreshadow ID を集める
  const relatedFids = new Set<string>([
    ...setups.map((s) => s.foreshadowId),
    ...payoffForeshadows.map((f) => f.id),
  ]);

  if (relatedFids.size === 0) {
    return {
      chapterId,
      totalScenes: scenes.length,
      scenesWithBody,
      byLabel: {},
      orphanCount: 0,
      needsStrengtheningCount: 0,
    };
  }

  // foreshadow 本体を取得して派生ラベルを計算
  const fRows = await db
    .select()
    .from(foreshadows)
    .where(inArray(foreshadows.id, Array.from(relatedFids)));

  const allSetups = await db
    .select()
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.foreshadowId, Array.from(relatedFids)));

  const countMap = new Map<string, number>();
  const weakMap = new Map<string, boolean>();
  for (const s of allSetups) {
    if (s.isOrphan) {
      continue;
    }
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
    const evaluation = safeParseAiEvaluation(s.aiReasoning as string | null);
    const effectiveStrength =
      (s.strength as string | null) ??
      evaluation?.careful?.strength ??
      (s.aiStrength as string | null);
    if (effectiveStrength === "subtle") {
      weakMap.set(s.foreshadowId, true);
    }
  }

  const byLabel: Partial<Record<DerivedLabel, number>> = {};
  let orphanCount = 0;
  let needsStrengtheningCount = 0;

  for (const r of fRows) {
    const row = r as ForeshadowRow;
    const setupCount = countMap.get(row.id) ?? 0;
    const anyWeak = weakMap.get(row.id) ?? false;
    const label = deriveLabel(row, setupCount, anyWeak);
    byLabel[label] = (byLabel[label] ?? 0) + 1;
    if (label === "orphan_payoff") orphanCount++;
    if (label === "needs_strengthening") needsStrengtheningCount++;
  }

  return {
    chapterId,
    totalScenes: scenes.length,
    scenesWithBody,
    byLabel,
    orphanCount,
    needsStrengtheningCount,
  };
}
