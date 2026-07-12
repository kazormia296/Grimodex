/**
 * consistencyPayloadBuilder.ts
 * consistency / intra_scene_consistency の AI 呼び出し用ペイロードを組み立てる。
 * chat の contextBuilder.ts とは別実装 — 全エントリで full content + DetailValues が必要。
 * 設計書 §整合性チェック詳細設計 §Codex payload を参照。
 */

import { db } from "@/db/client";
import {
  codexEntries,
  treeNodes,
  codexDetailValues,
  codexDetailDefinitions,
} from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  listPhasesByEntryIds,
  listDetailOverridesByPhaseIds,
} from "@/features/codex/phaseApi";
import {
  canIncludeResolvedCodexContext,
  materializeResolvedCodexContext,
  resolveCodexContexts,
} from "@/features/codex/context/resolvedCodexContext";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type {
  PhaseResolutionMode,
  SceneTimeIndex,
} from "@/features/codex/phaseResolver";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { detailValueToPlainText } from "@/features/codex/detailCleanup";
import { prosemirrorToText } from "@/lib/prosemirror";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import {
  computeInputHash,
  normalizeText,
  type HashRoute,
} from "./canonicalize";
import { kouetsuScopeSuffix } from "./customInstruction";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexPayloadEntry } from "./types";
import { TYPO_PROMPT_VERSION } from "./typoPayloadBuilder";
import { REVIEW_PROMPT_VERSION } from "./reviewPayloadBuilder";
import { META_STRUCTURE_PROMPT_VERSION } from "./metaStructurePayloadBuilder";

// ---------------------------------------------------------------------------
// Prompt versions (semver 定数)
// プロンプトの本質的変更時に minor/major を上げる。
// ---------------------------------------------------------------------------
export const CONSISTENCY_PROMPT_VERSION = "consistency_v1.3";
export const INTRA_CONSISTENCY_PROMPT_VERSION = "intra_scene_consistency_v1.2";
// impact_review (影響度レビュー): 変更された Codex 設定 (old→new) と本文の矛盾を
// 指摘する。Rust 側 IMPACT_REVIEW_PROMPT_VERSION と必ず同値であること。
export const IMPACT_REVIEW_PROMPT_VERSION = "impact_review_v1.1";

// ---------------------------------------------------------------------------
// Codex payload builder (consistency のみ使用)
// ---------------------------------------------------------------------------

/**
 * プロジェクトの Codex エントリを選定し、フェーズ解決済みの payload 配列を返す。
 * 選定: Always-mode + sceneText に mention されたエントリ全件。
 * 除外: Notes（検査対象外、設計書参照）、context_mode='suppress'|'hidden'。
 *
 * // TODO: SemanticLink 統合ポイント（将来: payload builder の選定にエディタ上の明示リンクを追加）
 */
async function buildCodexPayload(
  projectId: string,
  sceneId: string,
  sceneText: string,
  temporal: {
    sceneTimeIndex: SceneTimeIndex;
    resolutionMode: PhaseResolutionMode;
  },
): Promise<CodexPayloadEntry[]> {
  // プロジェクトの全 Codex エントリを取得
  const allEntries = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.projectId, projectId));

  if (allEntries.length === 0) return [];
  const entryIds = allEntries.map((entry) => entry.id);

  // Resolve the complete candidate set before mention/always selection. A
  // Base-hidden entry may become mentioned/always, while the reverse must be
  // removed before its summary/content reaches the matcher or payload.
  const allPhases = await listPhasesByEntryIds(entryIds);
  const phaseIds = allPhases.map((p) => p.id);
  const allOverrides = await listDetailOverridesByPhaseIds(phaseIds);

  // Context-enabled definitions applicable to each entry type, with an
  // optional Base value. Starting from codexEntries is important: a detail may
  // exist only as a Phase override and therefore have no codexDetailValues row.
  const rawDetails = await db
    .select({
      entryId: codexEntries.id,
      definitionId: codexDetailDefinitions.id,
      value: codexDetailValues.value,
      name: codexDetailDefinitions.name,
    })
    .from(codexEntries)
    .innerJoin(
      codexDetailDefinitions,
      and(
        eq(codexDetailDefinitions.projectId, codexEntries.projectId),
        eq(codexDetailDefinitions.typeSlug, codexEntries.type),
        eq(codexDetailDefinitions.includeInContext, 1),
      ),
    )
    .leftJoin(
      codexDetailValues,
      and(
        eq(codexDetailValues.entryId, codexEntries.id),
        eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
      ),
    )
    .where(inArray(codexEntries.id, entryIds));

  const detailsByEntry = new Map<
    string,
    Map<string, { value: string | null; name: string }>
  >();
  for (const row of rawDetails) {
    const m = detailsByEntry.get(row.entryId) ?? new Map();
    m.set(row.definitionId, { value: row.value, name: row.name });
    detailsByEntry.set(row.entryId, m);
  }

  // detailId→name マップ (base values, for resolveCodexState)
  const baseDetailValuesById = new Map<string, Map<string, string | null>>();
  for (const [entryId, dmap] of detailsByEntry) {
    const m = new Map<string, string | null>();
    for (const [defId, { value }] of dmap) m.set(defId, value);
    baseDetailValuesById.set(entryId, m);
  }

  const resolvedContexts = resolveCodexContexts({
    entries: allEntries,
    phases: allPhases,
    phaseDetailOverrides: allOverrides,
    baseDetailsByEntry: baseDetailValuesById,
    anchor: { kind: "scene", sceneId },
    sceneTimeIndex: temporal.sceneTimeIndex,
    resolutionMode: temporal.resolutionMode,
  });
  const effectiveEntries = allEntries.map((entry) => {
    const resolved = resolvedContexts.resolvedById.get(entry.id);
    return resolved ? materializeResolvedCodexContext(entry, resolved) : entry;
  });
  const effectiveById = new Map(
    effectiveEntries.map((entry) => [entry.id, entry]),
  );
  const detectableEntries = effectiveEntries.filter((entry) =>
    canIncludeResolvedCodexContext(entry.contextMode, "mention"),
  );
  const alwaysEntries = effectiveEntries.filter(
    (entry) => entry.contextMode === "always",
  );
  const mentioned = await findMentionedEntriesAsync(
    sceneText,
    detectableEntries,
  );
  const mentionedIds = new Set(
    mentioned.map((entry) => entry.id).filter((id) => effectiveById.has(id)),
  );
  const selectedIds = new Set([
    ...mentionedIds,
    ...alwaysEntries.map((entry) => entry.id),
  ]);
  const selectedEntries = effectiveEntries.filter((entry) =>
    selectedIds.has(entry.id),
  );

  const result: CodexPayloadEntry[] = [];
  for (const entry of selectedEntries) {
    const resolved = resolvedContexts.resolvedById.get(entry.id);
    if (!resolved) continue;

    const detailValues: Array<{ name: string; value: string }> = [];
    for (const [defId, resolvedVal] of resolved.detailValues) {
      const meta = detailsByEntry.get(entry.id)?.get(defId);
      const name = meta?.name ?? defId;
      // null is an explicit Phase clear. Only undefined means the resolved map
      // has no value and may fall back to Base metadata.
      const val =
        resolvedVal === undefined ? (meta?.value ?? null) : resolvedVal;
      // text 値は PM JSON で保存されている。生 JSON を payload に入れない
      const plain = detailValueToPlainText(val);
      if (plain.trim() !== "") detailValues.push({ name, value: plain });
    }

    result.push({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      summary: resolved.summary,
      content_plain: extractPlainText(resolved.content),
      detail_values: detailValues,
    });
  }

  return result;
}

function captureTemporalResolution(): {
  sceneTimeIndex: SceneTimeIndex;
  resolutionMode: PhaseResolutionMode;
} {
  const { sceneTimeIndex, resolutionMode } = usePhaseStore.getState();
  return {
    sceneTimeIndex: {
      ...sceneTimeIndex,
      readingOrder: new Map(sceneTimeIndex.readingOrder),
      explicitStoryOrder: new Map(sceneTimeIndex.explicitStoryOrder),
      inheritedStoryOrder: new Map(sceneTimeIndex.inheritedStoryOrder),
    },
    resolutionMode,
  };
}

// ---------------------------------------------------------------------------
// Scene text extractor
// ---------------------------------------------------------------------------

async function getScenePlainText(sceneId: string): Promise<string> {
  const rows = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  if (!rows[0]) return "";
  return prosemirrorToText(rows[0].content ?? "{}");
}

// ---------------------------------------------------------------------------
// Public: build payload for consistency check
// ---------------------------------------------------------------------------

export interface ConsistencyPayloadResult {
  codexPayload: CodexPayloadEntry[];
  codexPayloadJson: string;
  sceneText: string;
  inputHash: string;
}

export async function buildConsistencyPayload(
  projectId: string,
  sceneId: string,
  model: string,
  customInstruction: string = "",
  route?: HashRoute,
): Promise<ConsistencyPayloadResult> {
  const temporal = captureTemporalResolution();
  const sceneText = await getScenePlainText(sceneId);
  const codexPayload = await buildCodexPayload(
    projectId,
    sceneId,
    sceneText,
    temporal,
  );
  const codexPayloadJson = JSON.stringify(codexPayload);
  const inputHash = await computeInputHash({
    promptVersion: CONSISTENCY_PROMPT_VERSION,
    model,
    effectType: "consistency",
    provider: route?.provider,
    endpointId: route?.endpointId,
    codex: codexPayload,
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}${kouetsuScopeSuffix(customInstruction)}`,
  });
  return { codexPayload, codexPayloadJson, sceneText, inputHash };
}

// ---------------------------------------------------------------------------
// Public: build payload for intra_scene_consistency check (Codex 不使用)
// ---------------------------------------------------------------------------

export interface IntraPayloadResult {
  sceneText: string;
  inputHash: string;
}

export async function buildIntraPayload(
  sceneId: string,
  model: string,
  customInstruction: string = "",
  route?: HashRoute,
): Promise<IntraPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: INTRA_CONSISTENCY_PROMPT_VERSION,
    model,
    effectType: "intra_scene_consistency",
    provider: route?.provider,
    endpointId: route?.endpointId,
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}${kouetsuScopeSuffix(customInstruction)}`,
  });
  return { sceneText, inputHash };
}

// ---------------------------------------------------------------------------
// Multi-scene payload builder (folder / project scope)
// ---------------------------------------------------------------------------

export interface MultiSceneEntry {
  scene_id: string;
  codex_payload_json: string;
  scene_text: string;
}

export interface MultiPayloadResult {
  scenes: MultiSceneEntry[];
  inputHash: string;
}

export function getSceneIdsForScope(
  nodes: TreeNodeData[],
  scopeType: "folder" | "project",
  scopeTargetId: string | null,
): string[] {
  if (scopeType === "project") {
    return nodes.filter((n) => n.nodeType === "scene").map((n) => n.id);
  }
  const result: string[] = [];
  function walk(parentId: string) {
    for (const n of nodes) {
      if (n.parentId !== parentId) continue;
      if (n.nodeType === "scene") result.push(n.id);
      else if (n.nodeType === "folder") walk(n.id);
    }
  }
  if (scopeTargetId) walk(scopeTargetId);
  return result;
}

export async function buildMultiPayload(
  projectId: string,
  scopeType: "folder" | "project",
  scopeTargetId: string | null,
  model: string,
  effectType:
    | "consistency"
    | "intra_scene_consistency"
    | "typo_detection"
    | "review"
    | "meta_structure" = "consistency",
  customInstruction: string = "",
  route?: HashRoute,
): Promise<MultiPayloadResult> {
  const temporal = captureTemporalResolution();
  const nodes = useTreeStore.getState().nodes.map((node) => ({ ...node }));
  const sceneIds = getSceneIdsForScope(nodes, scopeType, scopeTargetId);

  const scenes: MultiSceneEntry[] = [];
  for (const sceneId of sceneIds) {
    const sceneText = await getScenePlainText(sceneId);
    if (effectType === "consistency") {
      const codexPayload = await buildCodexPayload(
        projectId,
        sceneId,
        sceneText,
        temporal,
      );
      scenes.push({
        scene_id: sceneId,
        codex_payload_json: JSON.stringify(codexPayload),
        scene_text: sceneText,
      });
    } else {
      // intra_scene_consistency / typo_detection は Codex 不要
      scenes.push({
        scene_id: sceneId,
        codex_payload_json: "[]",
        scene_text: sceneText,
      });
    }
  }

  const promptVersion =
    effectType === "consistency"
      ? CONSISTENCY_PROMPT_VERSION
      : effectType === "typo_detection"
        ? TYPO_PROMPT_VERSION
        : effectType === "review"
          ? REVIEW_PROMPT_VERSION
          : effectType === "meta_structure"
            ? META_STRUCTURE_PROMPT_VERSION
            : INTRA_CONSISTENCY_PROMPT_VERSION;

  const inputHash = await computeInputHash({
    promptVersion,
    model,
    effectType,
    provider: route?.provider,
    endpointId: route?.endpointId,
    scene: scenes.map((s) => normalizeText(s.scene_text)).join("|"),
    scope: `${scopeType}:${scopeTargetId ?? "all"}${kouetsuScopeSuffix(customInstruction)}`,
  });

  return { scenes, inputHash };
}
