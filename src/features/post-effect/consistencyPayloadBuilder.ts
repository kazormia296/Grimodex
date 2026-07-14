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
import { getCodexSemanticLinkEntryIds } from "@/features/codex/semanticLinks";
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
export const CONSISTENCY_PROMPT_VERSION = "consistency_v1.4";
export const INTRA_CONSISTENCY_PROMPT_VERSION = "intra_scene_consistency_v1.2";
// impact_review (影響度レビュー): 変更された Codex 設定 (old→new) と本文の矛盾を
// 指摘する。Rust 側 IMPACT_REVIEW_PROMPT_VERSION と必ず同値であること。
export const IMPACT_REVIEW_PROMPT_VERSION = "impact_review_v1.1";

// Codex data shares the model context with the scene and the prompt. Keep the
// serialized Codex array bounded even when a scene contains many explicit
// semantic links or an entry stores a very large rich-text body.
const CONSISTENCY_CODEX_PAYLOAD_MAX_CHARS = 24_000;
const CONSISTENCY_CODEX_ENTRY_MAX_CHARS = 6_000;
const CONSISTENCY_CODEX_ID_MAX_CHARS = 128;
const CONSISTENCY_CODEX_NAME_MAX_CHARS = 256;
const CONSISTENCY_CODEX_TYPE_MAX_CHARS = 64;
const CONSISTENCY_CODEX_SUMMARY_MAX_CHARS = 1_024;
const CONSISTENCY_CODEX_CONTENT_MAX_CHARS = 4_096;
const CONSISTENCY_CODEX_DETAIL_NAME_MAX_CHARS = 160;
const CONSISTENCY_CODEX_DETAIL_VALUE_MAX_CHARS = 768;
const PAYLOAD_TRUNCATION_SUFFIX = "…";

function truncatePayloadField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  if (maxChars === 1) return PAYLOAD_TRUNCATION_SUFFIX;

  let end = maxChars - PAYLOAD_TRUNCATION_SUFFIX.length;
  // Do not leave a dangling UTF-16 high surrogate before the suffix.
  const finalCodeUnit = value.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${PAYLOAD_TRUNCATION_SUFFIX}`;
}

function serializedLength(entry: CodexPayloadEntry): number {
  return JSON.stringify(entry).length;
}

/**
 * Shrink one already field-capped string just enough for the complete entry to
 * fit. Keeping this separate from the normal per-field caps means ordinary
 * short payloads remain byte-for-byte unchanged.
 */
function shrinkFieldToEntryBudget(
  value: string,
  entry: CodexPayloadEntry,
  charBudget: number,
  assign: (next: string) => void,
): void {
  if (serializedLength(entry) <= charBudget) return;

  assign("");
  // Other fields may also need shrinking before the entry fits.
  if (serializedLength(entry) > charBudget) return;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    assign(truncatePayloadField(value, mid));
    if (serializedLength(entry) <= charBudget) low = mid;
    else high = mid - 1;
  }
  assign(truncatePayloadField(value, low));
}

function boundCodexPayloadEntry(
  raw: CodexPayloadEntry,
  charBudget: number,
): CodexPayloadEntry | null {
  // IDs must remain exact so annotations can still refer back to the entry.
  // Invalid/hostile oversized identifiers are omitted instead of truncated.
  if (raw.id.length > CONSISTENCY_CODEX_ID_MAX_CHARS) return null;

  const entry: CodexPayloadEntry = {
    id: raw.id,
    name: truncatePayloadField(raw.name, CONSISTENCY_CODEX_NAME_MAX_CHARS),
    type: truncatePayloadField(raw.type, CONSISTENCY_CODEX_TYPE_MAX_CHARS),
    summary:
      raw.summary === null
        ? null
        : truncatePayloadField(
            raw.summary,
            CONSISTENCY_CODEX_SUMMARY_MAX_CHARS,
          ),
    content_plain: truncatePayloadField(
      raw.content_plain,
      CONSISTENCY_CODEX_CONTENT_MAX_CHARS,
    ),
    detail_values: [],
  };

  const content = entry.content_plain;
  shrinkFieldToEntryBudget(content, entry, charBudget, (next) => {
    entry.content_plain = next;
  });

  if (entry.summary !== null && serializedLength(entry) > charBudget) {
    const summary = entry.summary;
    shrinkFieldToEntryBudget(summary, entry, charBudget, (next) => {
      entry.summary = next;
    });
  }

  if (serializedLength(entry) > charBudget) {
    const name = entry.name;
    shrinkFieldToEntryBudget(name, entry, charBudget, (next) => {
      entry.name = next;
    });
  }

  if (serializedLength(entry) > charBudget) {
    const type = entry.type;
    shrinkFieldToEntryBudget(type, entry, charBudget, (next) => {
      entry.type = next;
    });
  }

  if (serializedLength(entry) > charBudget) return null;

  // Preserve detail ordering for normal payloads. Once the entry budget is
  // reached, lower-priority detail fields are simply omitted.
  for (const detail of raw.detail_values) {
    const boundedDetail = {
      name: truncatePayloadField(
        detail.name,
        CONSISTENCY_CODEX_DETAIL_NAME_MAX_CHARS,
      ),
      value: truncatePayloadField(
        detail.value,
        CONSISTENCY_CODEX_DETAIL_VALUE_MAX_CHARS,
      ),
    };
    const nextDetails = [...entry.detail_values, boundedDetail];
    entry.detail_values = nextDetails;
    if (serializedLength(entry) > charBudget) {
      entry.detail_values = nextDetails.slice(0, -1);
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Codex payload builder (consistency のみ使用)
// ---------------------------------------------------------------------------

/**
 * プロジェクトの Codex エントリを選定し、フェーズ解決済みの payload 配列を返す。
 * 選定: Always-mode + sceneText に mention されたエントリ全件。
 * 除外: Notes（検査対象外、設計書参照）、context_mode='suppress'|'hidden'。
 */
async function buildCodexPayload(
  projectId: string,
  sceneId: string,
  sceneText: string,
  semanticEntryIds: readonly string[],
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
    canIncludeResolvedCodexContext(entry.contextMode, "current-mention"),
  );
  const alwaysEntries = effectiveEntries.filter(
    (entry) => entry.contextMode === "always",
  );
  const mentioned = await findMentionedEntriesAsync(
    sceneText,
    detectableEntries,
  );
  const detectableIds = new Set(detectableEntries.map((entry) => entry.id));
  const semanticIds = new Set(
    semanticEntryIds.filter(
      (id) => detectableIds.has(id) && effectiveById.has(id),
    ),
  );
  const textualMentionIds = new Set(
    mentioned
      .map((entry) => entry.id)
      .filter((id) => detectableIds.has(id) && effectiveById.has(id)),
  );
  const selectedIds = new Set([
    ...semanticIds,
    ...textualMentionIds,
    ...alwaysEntries.map((entry) => entry.id),
  ]);
  const selectionPriority = (entryId: string): number => {
    if (semanticIds.has(entryId)) return 0;
    if (textualMentionIds.has(entryId)) return 1;
    return 2;
  };
  const selectedEntries = effectiveEntries
    .filter((entry) => selectedIds.has(entry.id))
    .sort((a, b) => {
      const priorityDelta = selectionPriority(a.id) - selectionPriority(b.id);
      if (priorityDelta !== 0) return priorityDelta;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });

  const result: CodexPayloadEntry[] = [];
  // JSON array brackets are present even for an empty payload.
  let payloadChars = 2;
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

    const rawEntry: CodexPayloadEntry = {
      id: entry.id,
      name: entry.name,
      type: entry.type,
      summary: resolved.summary,
      content_plain: extractPlainText(resolved.content),
      detail_values: detailValues,
    };

    const separatorChars = result.length > 0 ? 1 : 0;
    const remainingChars =
      CONSISTENCY_CODEX_PAYLOAD_MAX_CHARS - payloadChars - separatorChars;
    if (remainingChars <= 0) break;

    const boundedEntry = boundCodexPayloadEntry(
      rawEntry,
      Math.min(CONSISTENCY_CODEX_ENTRY_MAX_CHARS, remainingChars),
    );
    if (!boundedEntry) continue;

    const entryChars = serializedLength(boundedEntry);
    result.push(boundedEntry);
    payloadChars += separatorChars + entryChars;
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

interface SceneBodySnapshot {
  sceneText: string;
  semanticEntryIds: string[];
}

async function getSceneBodySnapshot(
  sceneId: string,
): Promise<SceneBodySnapshot> {
  const rows = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.id, sceneId));
  const contentJson = rows[0]?.content ?? "{}";
  return {
    sceneText: prosemirrorToText(contentJson),
    semanticEntryIds: getCodexSemanticLinkEntryIds(contentJson),
  };
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
  const { sceneText, semanticEntryIds } = await getSceneBodySnapshot(sceneId);
  const codexPayload = await buildCodexPayload(
    projectId,
    sceneId,
    sceneText,
    semanticEntryIds,
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
  const { sceneText } = await getSceneBodySnapshot(sceneId);
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
    const { sceneText, semanticEntryIds } = await getSceneBodySnapshot(sceneId);
    if (effectType === "consistency") {
      const codexPayload = await buildCodexPayload(
        projectId,
        sceneId,
        sceneText,
        semanticEntryIds,
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
