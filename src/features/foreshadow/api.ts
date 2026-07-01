import { db } from "@/db/client";
import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { useCodexStore } from "@/features/codex/codexStore";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import { invoke } from "@/lib/tauri";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
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
import { prosemirrorToText } from "@/lib/prosemirror";

/** Max chars of a scene-prefix excerpt used when `foreshadows.notes` is empty. */
const SETUP_EXCERPT_FALLBACK_MAX_CHARS = 200;

function getForeshadowCustomInstruction(): string {
  return useSettingsStore.getState().get("aiPrompt.custom.foreshadow", "");
}

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
    secret: toBool(row.secret ?? false),
    loadBearing:
      ((row.loadBearing ?? row.load_bearing) as
        | ForeshadowLoadBearing
        | null
        | undefined) ?? null,
    codexLinkDirtyAt: toNullableDate(
      row.codexLinkDirtyAt ?? row.codex_link_dirty_at,
    ),
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

/**
 * Timelapse record for a foreshadow (伏線) UI mutation. Uses the SAME
 * `foreshadow` domain the Rust AI path emits via its undo journal
 * (`agent_writes.rs`) — the plain `foreshadow.rs` UI commands do NOT append
 * change_events, so the UI path and AI path are disjoint (no double-record).
 */
function recordForeshadow(
  opType: string,
  entityId: string | null,
  payload: Record<string, unknown>,
): void {
  recordChangeEvent({
    domain: "foreshadow",
    opType,
    entityType: "foreshadow",
    entityId,
    payload,
  });
}

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
    const norm = normalizeForeshadowRow(created);
    recordForeshadow("create", norm.id, {
      foreshadowId: norm.id,
      title: norm.title,
    });
    return norm;
  }

  const now = new Date();
  const row: NewForeshadow = { ...data, createdAt: now, updatedAt: now };
  await db.insert(foreshadows).values(row);
  const [created] = await db
    .select()
    .from(foreshadows)
    .where(eq(foreshadows.id, data.id));
  recordForeshadow("create", data.id, {
    foreshadowId: data.id,
    title: data.title,
  });
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

type SetupLabelInput = Pick<
  ForeshadowSetupRow,
  "foreshadowId" | "isOrphan" | "strength" | "aiStrength" | "aiReasoning"
> & {
  sceneId?: string;
};

/** Grid カード等が per-scene IPC なしで参照する scene → 伏線 ID 索引。 */
export function buildSceneForeshadowInfoIndex(
  rows: ForeshadowRow[],
  setups: Array<{ foreshadowId: string; sceneId?: string }>,
): Record<string, SceneForeshadowInfo> {
  const index: Record<string, SceneForeshadowInfo> = {};
  const ensure = (sceneId: string): SceneForeshadowInfo => {
    if (!index[sceneId]) {
      index[sceneId] = { setupForeshadowIds: [], payoffForeshadowIds: [] };
    }
    return index[sceneId];
  };

  for (const setup of setups) {
    if (!setup.sceneId) continue;
    const info = ensure(setup.sceneId);
    if (!info.setupForeshadowIds.includes(setup.foreshadowId)) {
      info.setupForeshadowIds.push(setup.foreshadowId);
    }
  }

  for (const row of rows) {
    if (!row.payoffSceneId) continue;
    const info = ensure(row.payoffSceneId);
    if (!info.payoffForeshadowIds.includes(row.id)) {
      info.payoffForeshadowIds.push(row.id);
    }
  }

  return index;
}

/**
 * 各伏線の「本文に生きている (非孤立) Setup シーン ID」索引。
 * レーダー等が earliest-setup の読書順位置を引くために使う。
 * 注意: `buildSceneForeshadowInfoIndex` は孤立 setup も含む (scene→ID 逆引き用)
 * のに対し、こちらは setupCount と同じく `isOrphan` を除外する。
 */
export function buildSetupScenesByForeshadowId(
  setups: Array<{ foreshadowId: string; sceneId?: string; isOrphan?: boolean }>,
): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const s of setups) {
    if (s.isOrphan) continue;
    if (!s.sceneId) continue;
    const list = index[s.foreshadowId] ?? (index[s.foreshadowId] = []);
    if (!list.includes(s.sceneId)) list.push(s.sceneId);
  }
  return index;
}

export function buildForeshadowsWithLabels(
  rows: ForeshadowRow[],
  setups: SetupLabelInput[],
): ForeshadowWithLabel[] {
  if (rows.length === 0) return [];

  const countMap = new Map<string, number>();
  const weakMap = new Map<string, boolean>();

  for (const s of setups) {
    if (s.isOrphan) continue;
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
    const evaluation = safeParseAiEvaluation(s.aiReasoning);
    const effectiveStrength =
      s.strength ?? evaluation?.careful?.strength ?? s.aiStrength;
    if (effectiveStrength === "subtle") {
      weakMap.set(s.foreshadowId, true);
    }
  }

  return rows.map((r) => {
    const setupCount = countMap.get(r.id) ?? 0;
    const anyWeak = weakMap.get(r.id) ?? false;
    return { ...r, setupCount, label: deriveLabel(r, setupCount, anyWeak) };
  });
}

function normalizeSetupLabelInput(raw: unknown): SetupLabelInput {
  const row = normalizeSetupRow(raw);
  return {
    foreshadowId: row.foreshadowId,
    sceneId: row.sceneId,
    isOrphan: row.isOrphan,
    strength: row.strength,
    aiStrength: row.aiStrength,
    aiReasoning: row.aiReasoning,
  };
}

async function invokeForeshadowListWithLabels(
  command: string,
  args: Record<string, unknown>,
): Promise<{ rows: ForeshadowRow[]; setups: SetupLabelInput[] }> {
  const res = await invoke<{
    foreshadows: unknown[];
    setups: unknown[];
  }>(command, args);
  return {
    rows: (res.foreshadows ?? []).map(normalizeForeshadowRow),
    setups: (res.setups ?? []).map(normalizeSetupLabelInput),
  };
}

function buildOpenForeshadowsForContext(
  rows: Array<{
    id: string;
    title: string;
    intent: string | null;
    loadBearing: ForeshadowLoadBearing | null;
    payoffConfirmed: boolean;
    abandoned: boolean;
    updatedAt: unknown;
  }>,
  setups: SetupLabelInput[],
): OpenForeshadowForContext[] {
  if (rows.length === 0) return [];

  const labeled = buildForeshadowsWithLabels(
    rows.map(
      (r): ForeshadowRow => ({
        id: r.id,
        projectId: "",
        title: r.title,
        intent: r.intent,
        notes: null,
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        payoffConfirmed: r.payoffConfirmed,
        abandoned: r.abandoned,
        secret: false,
        loadBearing: r.loadBearing,
        codexLinkDirtyAt: null,
        createdAt: new Date(),
        updatedAt:
          r.updatedAt instanceof Date
            ? r.updatedAt
            : new Date(String(r.updatedAt ?? Date.now())),
      }),
    ),
    setups,
  );
  const labelById = new Map(labeled.map((l) => [l.id, l.label]));

  const countMap = new Map<string, number>();
  for (const s of setups) {
    if (s.isOrphan) continue;
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
  }

  const priority: Record<string, number> = {
    critical: 0,
    supporting: 1,
    optional: 2,
  };
  const toMs = (v: unknown): number => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") return new Date(v).getTime();
    if (typeof v === "number") return v;
    return 0;
  };
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      intent: r.intent,
      loadBearing: r.loadBearing,
      setupCount: countMap.get(r.id) ?? 0,
      derivedLabel: labelById.get(r.id),
      _updatedMs: toMs(r.updatedAt),
    }))
    .sort((a, b) => {
      const pa = priority[a.loadBearing ?? ""] ?? 3;
      const pb = priority[b.loadBearing ?? ""] ?? 3;
      if (pa !== pb) return pa - pb;
      return b._updatedMs - a._updatedMs;
    })
    .map(({ _updatedMs: _ms, ...rest }) => rest);
}

function buildSceneForeshadowContextFromBundle(res: {
  setups: unknown[];
  payoffs: unknown[];
  setupSceneRows: unknown[];
}): SceneForeshadowContext {
  const setupSceneByForeshadow: Record<string, string> = {};
  for (const raw of res.setupSceneRows ?? []) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const foreshadowId = String(row.foreshadowId ?? row.foreshadow_id ?? "");
    const sceneTitle = String(row.sceneTitle ?? row.scene_title ?? "");
    if (foreshadowId && !(foreshadowId in setupSceneByForeshadow)) {
      setupSceneByForeshadow[foreshadowId] = sceneTitle;
    }
  }

  const setups = (res.setups ?? []).map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    return {
      title: String(row.title ?? ""),
      intent: (row.intent as string | null | undefined) ?? null,
    };
  });

  const payoffs = (res.payoffs ?? []).map((raw) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const id = String(row.id ?? "");
    return {
      title: String(row.title ?? ""),
      intent: (row.intent as string | null | undefined) ?? null,
      setupSceneTitle: setupSceneByForeshadow[id] ?? null,
    };
  });

  return { setups, payoffs };
}

function computeChapterForeshadowStats(
  chapterId: string,
  scenes: Array<{ id: string; content: string }>,
  relatedForeshadows: ForeshadowRow[],
  relatedSetups: SetupLabelInput[],
): ChapterForeshadowStats {
  const scenesWithBody = scenes.filter((s) => {
    try {
      const doc = JSON.parse(s.content) as { content?: unknown[] };
      return Array.isArray(doc.content) && doc.content.length > 0;
    } catch {
      return false;
    }
  }).length;

  if (scenes.length === 0) {
    return {
      chapterId,
      totalScenes: 0,
      scenesWithBody: 0,
      byLabel: {},
      orphanCount: 0,
      needsStrengtheningCount: 0,
    };
  }

  if (relatedForeshadows.length === 0) {
    return {
      chapterId,
      totalScenes: scenes.length,
      scenesWithBody,
      byLabel: {},
      orphanCount: 0,
      needsStrengtheningCount: 0,
    };
  }

  const countMap = new Map<string, number>();
  const weakMap = new Map<string, boolean>();
  for (const s of relatedSetups) {
    if (s.isOrphan) continue;
    countMap.set(s.foreshadowId, (countMap.get(s.foreshadowId) ?? 0) + 1);
    const evaluation = safeParseAiEvaluation(s.aiReasoning);
    const effectiveStrength =
      s.strength ?? evaluation?.careful?.strength ?? s.aiStrength;
    if (effectiveStrength === "subtle") {
      weakMap.set(s.foreshadowId, true);
    }
  }

  const byLabel: Partial<Record<DerivedLabel, number>> = {};
  let orphanCount = 0;
  let needsStrengtheningCount = 0;

  for (const row of relatedForeshadows) {
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

/** Load foreshadow rows with derived labels. Uses a single IPC in Tauri mode. */
export async function listForeshadowsWithLabels(projectId: string): Promise<{
  items: ForeshadowWithLabel[];
  sceneInfoBySceneId: Record<string, SceneForeshadowInfo>;
  setupScenesByForeshadowId: Record<string, string[]>;
}> {
  if (isTauriRuntime()) {
    const { rows, setups } = await invokeForeshadowListWithLabels(
      "foreshadow_list_with_labels",
      { projectId },
    );
    return {
      items: buildForeshadowsWithLabels(rows, setups),
      sceneInfoBySceneId: buildSceneForeshadowInfoIndex(rows, setups),
      setupScenesByForeshadowId: buildSetupScenesByForeshadowId(setups),
    };
  }

  const rows = await listForeshadows(projectId);
  if (rows.length === 0) {
    return { items: [], sceneInfoBySceneId: {}, setupScenesByForeshadowId: {} };
  }

  const ids = rows.map((r) => r.id);
  const setups = await db
    .select({
      foreshadowId: foreshadowSetups.foreshadowId,
      sceneId: foreshadowSetups.sceneId,
      isOrphan: foreshadowSetups.isOrphan,
      strength: foreshadowSetups.strength,
      aiStrength: foreshadowSetups.aiStrength,
      aiReasoning: foreshadowSetups.aiReasoning,
    })
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.foreshadowId, ids));

  return {
    items: buildForeshadowsWithLabels(rows, setups as SetupLabelInput[]),
    sceneInfoBySceneId: buildSceneForeshadowInfoIndex(rows, setups),
    setupScenesByForeshadowId: buildSetupScenesByForeshadowId(setups),
  };
}

export interface SceneForeshadowInfo {
  setupForeshadowIds: string[];
  payoffForeshadowIds: string[];
}

/**
 * Phase 2 (chat context): プロジェクト全体の未回収伏線（payoffConfirmed=false
 * かつ abandoned=false）を loadBearing 優先度（critical > supporting > optional
 * > null）→ updatedAt DESC でソートして返す。setupCount は orphan を除いた件数。
 * L2 にバルク表示するための軽量フォーマットで、内容(notes)等は含めない。
 */
export interface OpenForeshadowForContext {
  id: string;
  title: string;
  intent: string | null;
  loadBearing: ForeshadowLoadBearing | null;
  setupCount: number;
  /** Derived lifecycle label from setup count + strength evaluation. */
  derivedLabel?: DerivedLabel;
}

export async function listOpenForeshadowsForContext(
  projectId: string,
): Promise<OpenForeshadowForContext[]> {
  if (isTauriRuntime()) {
    const { rows, setups } = await invokeForeshadowListWithLabels(
      "foreshadow_list_open_for_context",
      { projectId },
    );
    return buildOpenForeshadowsForContext(rows, setups);
  }

  const rows = (await db
    .select({
      id: foreshadows.id,
      title: foreshadows.title,
      intent: foreshadows.intent,
      loadBearing: foreshadows.loadBearing,
      payoffConfirmed: foreshadows.payoffConfirmed,
      abandoned: foreshadows.abandoned,
      updatedAt: foreshadows.updatedAt,
    })
    .from(foreshadows)
    .where(
      and(
        eq(foreshadows.projectId, projectId),
        eq(foreshadows.payoffConfirmed, false),
        eq(foreshadows.abandoned, false),
        eq(foreshadows.secret, false),
      ),
    )) as Array<{
    id: string;
    title: string;
    intent: string | null;
    loadBearing: ForeshadowLoadBearing | null;
    payoffConfirmed: boolean;
    abandoned: boolean;
    updatedAt: unknown;
  }>;

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const setups = await db
    .select({
      foreshadowId: foreshadowSetups.foreshadowId,
      sceneId: foreshadowSetups.sceneId,
      isOrphan: foreshadowSetups.isOrphan,
      strength: foreshadowSetups.strength,
      aiStrength: foreshadowSetups.aiStrength,
      aiReasoning: foreshadowSetups.aiReasoning,
    })
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.foreshadowId, ids));

  return buildOpenForeshadowsForContext(rows, setups as SetupLabelInput[]);
}

export async function getSceneForeshadowInfo(
  sceneId: string,
): Promise<SceneForeshadowInfo> {
  if (isTauriRuntime()) {
    const res = await invoke<{
      setupForeshadowIds: string[];
      payoffForeshadowIds: string[];
    }>("foreshadow_get_scene_info", { sceneId });
    return {
      setupForeshadowIds: res.setupForeshadowIds ?? [],
      payoffForeshadowIds: res.payoffForeshadowIds ?? [],
    };
  }

  const [setupRows, payoffRows] = await Promise.all([
    db
      .selectDistinct({ foreshadowId: foreshadowSetups.foreshadowId })
      .from(foreshadowSetups)
      .where(eq(foreshadowSetups.sceneId, sceneId)),
    db
      .select({ id: foreshadows.id })
      .from(foreshadows)
      .where(eq(foreshadows.payoffSceneId, sceneId)),
  ]);
  return {
    setupForeshadowIds: setupRows.map((r) => r.foreshadowId),
    payoffForeshadowIds: payoffRows.map((r) => r.id),
  };
}

/**
 * Phase 1 (chat context): 当シーンで仕込みが置かれた / 回収される伏線の
 * 表示用情報。`getSceneForeshadowInfo` は ID のみを返すが、AI コンテキスト
 * 注入では title / intent と「対応する setup シーンタイトル」が要るため、
 * 一度の呼び出しで join 込みでまとめて返す。abandoned 伏線は除外する。
 */
export interface SceneForeshadowContextSetup {
  foreshadowId?: string;
  title: string;
  intent: string | null;
  derivedLabel?: DerivedLabel;
  strength?: ForeshadowStrength | null;
  excerpt?: string | null;
}
export interface SceneForeshadowContextPayoff {
  foreshadowId?: string;
  title: string;
  intent: string | null;
  setupSceneTitle: string | null;
  derivedLabel?: DerivedLabel;
  strength?: ForeshadowStrength | null;
  excerpt?: string | null;
}
export interface SceneForeshadowContext {
  setups: SceneForeshadowContextSetup[];
  payoffs: SceneForeshadowContextPayoff[];
}

export async function getSceneForeshadowContext(
  sceneId: string,
): Promise<SceneForeshadowContext> {
  if (isTauriRuntime()) {
    const res = await invoke<{
      setups: unknown[];
      payoffs: unknown[];
      setupSceneRows: unknown[];
    }>("foreshadow_get_scene_context", { sceneId });
    return buildSceneForeshadowContextFromBundle(res);
  }

  const [setupRows, payoffRows] = await Promise.all([
    db
      .select({
        foreshadowId: foreshadowSetups.foreshadowId,
        title: foreshadows.title,
        intent: foreshadows.intent,
        notes: foreshadows.notes,
        payoffConfirmed: foreshadows.payoffConfirmed,
        abandoned: foreshadows.abandoned,
        loadBearing: foreshadows.loadBearing,
        strength: foreshadowSetups.strength,
        aiStrength: foreshadowSetups.aiStrength,
        aiReasoning: foreshadowSetups.aiReasoning,
        isOrphan: foreshadowSetups.isOrphan,
      })
      .from(foreshadowSetups)
      .innerJoin(foreshadows, eq(foreshadowSetups.foreshadowId, foreshadows.id))
      .where(
        and(
          eq(foreshadowSetups.sceneId, sceneId),
          eq(foreshadows.abandoned, false),
        ),
      ),
    db
      .select({
        id: foreshadows.id,
        title: foreshadows.title,
        intent: foreshadows.intent,
        notes: foreshadows.notes,
        payoffConfirmed: foreshadows.payoffConfirmed,
        abandoned: foreshadows.abandoned,
        loadBearing: foreshadows.loadBearing,
      })
      .from(foreshadows)
      .where(
        and(
          eq(foreshadows.payoffSceneId, sceneId),
          eq(foreshadows.abandoned, false),
        ),
      ),
  ]);

  const foreshadowIds = [
    ...new Set([
      ...setupRows.map((r) => r.foreshadowId),
      ...payoffRows.map((r) => r.id),
    ]),
  ];
  let labelById = new Map<string, DerivedLabel>();
  let allSetups: Array<{
    foreshadowId: string;
    sceneId: string;
    isOrphan: boolean;
    strength: ForeshadowStrength | null;
    aiStrength: ForeshadowStrength | null;
    aiReasoning: string | null;
  }> = [];
  if (foreshadowIds.length > 0) {
    const [fRows, setupsRows] = await Promise.all([
      db
        .select()
        .from(foreshadows)
        .where(inArray(foreshadows.id, foreshadowIds)),
      db
        .select({
          foreshadowId: foreshadowSetups.foreshadowId,
          sceneId: foreshadowSetups.sceneId,
          isOrphan: foreshadowSetups.isOrphan,
          strength: foreshadowSetups.strength,
          aiStrength: foreshadowSetups.aiStrength,
          aiReasoning: foreshadowSetups.aiReasoning,
        })
        .from(foreshadowSetups)
        .where(inArray(foreshadowSetups.foreshadowId, foreshadowIds)),
    ]);
    allSetups = setupsRows as typeof allSetups;
    labelById = new Map(
      buildForeshadowsWithLabels(
        fRows as ForeshadowRow[],
        allSetups as SetupLabelInput[],
      ).map((l) => [l.id, l.label]),
    );
  }

  const effectiveStrength = (
    strength: ForeshadowStrength | null | undefined,
    aiStrength: ForeshadowStrength | null | undefined,
    aiReasoning: string | null | undefined,
  ): ForeshadowStrength | null => {
    const evaluation = safeParseAiEvaluation(aiReasoning ?? null);
    return strength ?? evaluation?.careful?.strength ?? aiStrength ?? null;
  };

  /** Pick the strongest strength from a foreshadow's non-orphan setups
   * (manual > careful eval > ai_strength), used as the payoff-side representative. */
  const representativeStrengthFor = (
    fid: string,
  ): ForeshadowStrength | null => {
    const candidates = allSetups.filter(
      (s) => s.foreshadowId === fid && !s.isOrphan,
    );
    for (const c of candidates) {
      const s = effectiveStrength(c.strength, c.aiStrength, c.aiReasoning);
      if (s) return s;
    }
    return null;
  };

  // 各 payoff foreshadow に対して、最初の setup シーンタイトルを 1 件取得する。
  const payoffIds = payoffRows.map((r) => r.id);
  const setupSceneByForeshadow: Record<string, string> = {};
  if (payoffIds.length > 0) {
    const setupSceneRows = await db
      .select({
        foreshadowId: foreshadowSetups.foreshadowId,
        sceneTitle: treeNodes.title,
      })
      .from(foreshadowSetups)
      .innerJoin(treeNodes, eq(foreshadowSetups.sceneId, treeNodes.id))
      .where(inArray(foreshadowSetups.foreshadowId, payoffIds));
    for (const row of setupSceneRows) {
      if (!(row.foreshadowId in setupSceneByForeshadow)) {
        setupSceneByForeshadow[row.foreshadowId] = row.sceneTitle;
      }
    }
  }

  const seenSetupForeshadowIds = new Set<string>();
  const dedupedSetupRows = setupRows.filter((r) => {
    if (seenSetupForeshadowIds.has(r.foreshadowId)) return false;
    seenSetupForeshadowIds.add(r.foreshadowId);
    return true;
  });

  // #14 fallback: when foreshadows.notes is empty for a setup in the current
  // scene, derive a short prefix from the scene body via prosemirrorToText.
  // PM position-based slicing would be more precise but requires Node-instantiation
  // outside the data layer; the prefix is good enough as last-resort context.
  let sceneExcerptFallback: string | null = null;
  const needsFallback = dedupedSetupRows.some((r) => !r.notes?.trim());
  if (needsFallback) {
    const sceneRows = await db
      .select({ content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, sceneId));
    const raw = sceneRows[0]?.content;
    if (raw) {
      const plain = prosemirrorToText(raw).trim();
      if (plain) {
        sceneExcerptFallback =
          plain.length > SETUP_EXCERPT_FALLBACK_MAX_CHARS
            ? plain.slice(0, SETUP_EXCERPT_FALLBACK_MAX_CHARS) + "…"
            : plain;
      }
    }
  }

  return {
    setups: dedupedSetupRows.map((r) => ({
      foreshadowId: r.foreshadowId,
      title: r.title,
      intent: r.intent,
      derivedLabel: labelById.get(r.foreshadowId),
      strength: effectiveStrength(
        r.strength as ForeshadowStrength | null,
        r.aiStrength as ForeshadowStrength | null,
        r.aiReasoning,
      ),
      excerpt: r.notes?.trim() || sceneExcerptFallback,
    })),
    payoffs: payoffRows.map((r) => ({
      foreshadowId: r.id,
      title: r.title,
      intent: r.intent,
      setupSceneTitle: setupSceneByForeshadow[r.id] ?? null,
      derivedLabel: labelById.get(r.id),
      strength: representativeStrengthFor(r.id),
      excerpt: r.notes?.trim() || null,
    })),
  };
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
      | "secret"
      | "loadBearing"
      | "payoffSceneId"
      | "payoffFromPos"
      | "payoffToPos"
    >
  >,
): Promise<void> {
  recordForeshadow("update", id, {
    foreshadowId: id,
    fields: Object.keys(patch),
  });
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
    if (patch.secret !== undefined) tauriPatch.secret = patch.secret;
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
  recordForeshadow("delete", id, { foreshadowId: id });
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
  if (isTauriRuntime()) {
    const tauriPatch: Record<string, unknown> = {};
    if (patch.strength !== undefined) tauriPatch.strength = patch.strength;
    if (patch.aiStrength !== undefined)
      tauriPatch.aiStrength = patch.aiStrength;
    if (patch.aiReasoning !== undefined) {
      tauriPatch.aiReasoning = patch.aiReasoning;
    }
    if (patch.isOrphan !== undefined) tauriPatch.isOrphan = patch.isOrphan;
    if (patch.lastEvaluatedAt !== undefined) {
      tauriPatch.lastEvaluatedAt = patch.lastEvaluatedAt
        ? patch.lastEvaluatedAt.getTime()
        : null;
    }
    await invoke("foreshadow_update_setup", { id, patch: tauriPatch });
    return;
  }

  await db
    .update(foreshadowSetups)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(foreshadowSetups.id, id));
}

export async function deleteSetup(id: string): Promise<void> {
  if (isTauriRuntime()) {
    await invoke("foreshadow_resolve_orphan", {
      payload: { setupId: id, action: "delete" },
    });
    return;
  }
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
    const created = await invoke<unknown | null>("foreshadow_get_setup", {
      setupId: newId,
    });
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
  if (isTauriRuntime()) {
    const { rows, setups } = await invokeForeshadowListWithLabels(
      "foreshadow_list_by_codex_entry",
      { codexEntryId },
    );
    return buildForeshadowsWithLabels(rows, setups);
  }

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
    .select({
      foreshadowId: foreshadowSetups.foreshadowId,
      isOrphan: foreshadowSetups.isOrphan,
      strength: foreshadowSetups.strength,
      aiStrength: foreshadowSetups.aiStrength,
      aiReasoning: foreshadowSetups.aiReasoning,
    })
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.foreshadowId, fids));

  return buildForeshadowsWithLabels(
    rows as ForeshadowRow[],
    setups as SetupLabelInput[],
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

/** relatedCodex のエントリ数上限（prompt 側の slice(0, 20) と同じ）。 */
const RELATED_CODEX_MAX_ENTRIES = 20;
/** relatedCodex の合計文字数上限（inline AI の codexSummaries と同水準）。 */
const RELATED_CODEX_CHAR_LIMIT = 3000;

/**
 * シーン本文テキストから言及されている codex エントリを検出して
 * relatedCodex 形式（id/name/summary）に整形する。chat の auto-detect と
 * 同じ text ベースのマッチング（editor 非依存）。summary 空のエントリは
 * prompt で `- name: ` にしかならないため除外する。
 */
export async function detectRelatedCodex(
  text: string,
): Promise<ProposeRequest["relatedCodex"]> {
  if (!text.trim()) return [];
  const entries = useCodexStore.getState().entries;
  const detectable = entries.filter(
    (e) => e.contextMode !== "hidden" && e.contextMode !== "suppress",
  );
  const matched = await findMentionedEntriesAsync(text, detectable);
  const byId = new Map(detectable.map((e) => [e.id, e]));

  const result: ProposeRequest["relatedCodex"] = [];
  let total = 0;
  for (const m of matched) {
    const entry = byId.get(m.id);
    if (!entry) continue;
    const summary = (entry.summary ?? "").trim();
    if (!summary) continue;
    const line = `- ${entry.name}: ${summary}`;
    if (total + line.length + 1 > RELATED_CODEX_CHAR_LIMIT) break;
    result.push({ id: entry.id, name: entry.name, summary });
    if (result.length >= RELATED_CODEX_MAX_ENTRIES) break;
    total += line.length + 1;
  }
  return result;
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
  // 分析・提案系の LLM 呼び出し — kouetsu views と同じく analysis で gate する
  // (presentation から独立した correctness 層、policyGuard.ts 参照)。
  if (blockIfPolicyOff("analysis")) return [];
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
    customInstruction: getForeshadowCustomInstruction(),
  });

  const ovPropose = resolveRoleSendOverride("foreshadow_propose_past_setups");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    undefined, // thinkingParams
    undefined, // systemCacheSegments
    ovPropose.apiVariant, // apiVariant（横断割り当て時のみ）
    undefined, // systemVolatileTail
    ovPropose.model,
    ovPropose.provider,
    ovPropose.endpointId,
  );
  // N4: 伏線 setup 提案生成の usage を台帳に記録する。
  void recordAiUsage({
    surface: "foreshadow",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });
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
  if (blockIfPolicyOff("analysis")) return null;
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
    customInstruction: getForeshadowCustomInstruction(),
  });

  const ovEval = resolveRoleSendOverride("foreshadow_evaluate_setup_strength");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    undefined, // thinkingParams
    undefined, // systemCacheSegments
    ovEval.apiVariant, // apiVariant（横断割り当て時のみ）
    undefined, // systemVolatileTail
    ovEval.model,
    ovEval.provider,
    ovEval.endpointId,
  );
  // N4: 伏線 setup 評価生成の usage を台帳に記録する。
  void recordAiUsage({
    surface: "foreshadow",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

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
  if (blockIfPolicyOff("analysis")) return [];
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
    customInstruction: getForeshadowCustomInstruction(),
  });

  const ovAudit = resolveRoleSendOverride("foreshadow_audit_chapter");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    undefined, // thinkingParams
    undefined, // systemCacheSegments
    ovAudit.apiVariant, // apiVariant（横断割り当て時のみ）
    undefined, // systemVolatileTail
    ovAudit.model,
    ovAudit.provider,
    ovAudit.endpointId,
  );
  // N4: 章監査生成の usage を台帳に記録する。
  void recordAiUsage({
    surface: "foreshadow",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });
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
  if (isTauriRuntime()) {
    const bundle = await invoke<{
      scenes: unknown[];
      setupsOnScenes: unknown[];
      payoffForeshadows: unknown[];
      relatedForeshadows: unknown[];
      relatedSetups: unknown[];
    }>("foreshadow_get_chapter_stats", { chapterId });
    const scenes = (bundle.scenes ?? []).map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        id: String(row.id ?? ""),
        content: String(row.content ?? ""),
      };
    });
    return computeChapterForeshadowStats(
      chapterId,
      scenes,
      (bundle.relatedForeshadows ?? []).map(normalizeForeshadowRow),
      (bundle.relatedSetups ?? []).map(normalizeSetupLabelInput),
    );
  }

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

  if (sceneIds.length === 0) {
    return computeChapterForeshadowStats(chapterId, scenes, [], []);
  }

  const setups = await db
    .select()
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.sceneId, sceneIds));

  const payoffForeshadows = await db
    .select()
    .from(foreshadows)
    .where(inArray(foreshadows.payoffSceneId, sceneIds));

  const relatedFids = new Set<string>([
    ...setups.map((s) => s.foreshadowId),
    ...payoffForeshadows.map((f) => f.id),
  ]);

  if (relatedFids.size === 0) {
    return computeChapterForeshadowStats(chapterId, scenes, [], []);
  }

  const fRows = (await db
    .select()
    .from(foreshadows)
    .where(
      inArray(foreshadows.id, Array.from(relatedFids)),
    )) as ForeshadowRow[];

  const allSetups = await db
    .select({
      foreshadowId: foreshadowSetups.foreshadowId,
      isOrphan: foreshadowSetups.isOrphan,
      strength: foreshadowSetups.strength,
      aiStrength: foreshadowSetups.aiStrength,
      aiReasoning: foreshadowSetups.aiReasoning,
    })
    .from(foreshadowSetups)
    .where(inArray(foreshadowSetups.foreshadowId, Array.from(relatedFids)));

  return computeChapterForeshadowStats(
    chapterId,
    scenes,
    fRows,
    allSetups as SetupLabelInput[],
  );
}
