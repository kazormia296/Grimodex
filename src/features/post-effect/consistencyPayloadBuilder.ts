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
import { resolveCodexState } from "@/features/codex/phaseResolver";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { prosemirrorToText } from "@/lib/prosemirror";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import { computeInputHash, normalizeText } from "./canonicalize";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexPayloadEntry } from "./types";
import { TYPO_PROMPT_VERSION } from "./typoPayloadBuilder";
import { REVIEW_PROMPT_VERSION } from "./reviewPayloadBuilder";

// ---------------------------------------------------------------------------
// Prompt versions (semver 定数)
// プロンプトの本質的変更時に minor/major を上げる。
// ---------------------------------------------------------------------------
export const CONSISTENCY_PROMPT_VERSION = "consistency_v1.1";
export const INTRA_CONSISTENCY_PROMPT_VERSION = "intra_scene_consistency_v1.0";

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
  sceneText: string,
): Promise<CodexPayloadEntry[]> {
  // プロジェクトの全 Codex エントリを取得
  const allEntries = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.projectId, projectId));

  const allEntriesById = new Map(allEntries.map((e) => [e.id, e]));

  const detectableEntries = allEntries.filter(
    (e) => e.contextMode !== "hidden" && e.contextMode !== "suppress",
  );
  const alwaysEntries = allEntries.filter((e) => e.contextMode === "always");

  // mention 検出 (rustMatcher) — CodexMatchTarget[] を返すが ID のみを使用
  const mentioned = await findMentionedEntriesAsync(
    sceneText,
    detectableEntries,
  );
  const mentionedIds = new Set(mentioned.map((e) => e.id));
  const alwaysNotMentionedIds = alwaysEntries
    .filter((e) => !mentionedIds.has(e.id))
    .map((e) => e.id);

  const selectedIds = [...mentionedIds, ...alwaysNotMentionedIds];
  // フル entry を allEntries から解決 (CodexMatchTarget は id/name/type のみのため)
  const selectedEntries = selectedIds
    .map((id) => allEntriesById.get(id))
    .filter((e): e is NonNullable<typeof e> => e !== undefined);

  if (selectedEntries.length === 0) return [];

  const entryIds = selectedEntries.map((e) => e.id);

  // フェーズ解決
  const allPhases = await listPhasesByEntryIds(entryIds);
  const phaseIds = allPhases.map((p) => p.id);
  const allOverrides = await listDetailOverridesByPhaseIds(phaseIds);

  const overridesByPhase = new Map<string, (typeof allOverrides)[0][]>();
  for (const ov of allOverrides) {
    const arr = overridesByPhase.get(ov.phaseId) ?? [];
    arr.push(ov);
    overridesByPhase.set(ov.phaseId, arr);
  }
  const phasesByEntry = new Map<string, (typeof allPhases)[0][]>();
  for (const phase of allPhases) {
    const arr = phasesByEntry.get(phase.entryId) ?? [];
    arr.push(phase);
    phasesByEntry.set(phase.entryId, arr);
  }

  // ベース DetailValues (includeInContext=1 のみ)
  const rawDetails = await db
    .select({
      entryId: codexDetailValues.entryId,
      definitionId: codexDetailValues.definitionId,
      value: codexDetailValues.value,
      name: codexDetailDefinitions.name,
    })
    .from(codexDetailValues)
    .innerJoin(
      codexDetailDefinitions,
      and(
        eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
        eq(codexDetailDefinitions.includeInContext, 1),
      ),
    )
    .where(inArray(codexDetailValues.entryId, entryIds));

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

  const globalSceneOrder = usePhaseStore.getState().globalSceneOrder;

  // 対象 scene の ID は scope_target_id だが、ここでは引数で受け取った sceneText を
  // 使用して mention 検出しているため、sceneId を直接参照しない。
  // phase 解決には現在の sceneId が必要なため、呼び出し側 (buildConsistencyPayload) から渡す。
  // この関数は sceneId なしで呼ばれる場合は null（Phase Base のみ）として解決する。
  const result: CodexPayloadEntry[] = [];
  for (const entry of selectedEntries) {
    const phases = phasesByEntry.get(entry.id) ?? [];
    const phaseDetailsMap = new Map<string, (typeof allOverrides)[0][]>();
    for (const phase of phases) {
      phaseDetailsMap.set(phase.id, overridesByPhase.get(phase.id) ?? []);
    }
    const baseDetails = baseDetailValuesById.get(entry.id) ?? new Map();

    // NOTE: sceneId は buildConsistencyPayload から上書きされる。null = Base のみ。
    const resolved = resolveCodexState(
      {
        summary: entry.summary ?? null,
        content: entry.content,
        contextMode: entry.contextMode,
      },
      phases,
      phaseDetailsMap,
      baseDetails,
      null, // sceneId はここでは null; buildConsistencyPayload で再解決する場合は上書き可
      globalSceneOrder,
    );

    const detailValues: Array<{ name: string; value: string }> = [];
    for (const [defId, resolvedVal] of resolved.detailValues) {
      const meta = detailsByEntry.get(entry.id)?.get(defId);
      const name = meta?.name ?? defId;
      const val = resolvedVal ?? meta?.value ?? null;
      if (val !== null && val !== "") detailValues.push({ name, value: val });
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
): Promise<ConsistencyPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const codexPayload = await buildCodexPayload(projectId, sceneText);
  const codexPayloadJson = JSON.stringify(codexPayload);
  const inputHash = await computeInputHash({
    promptVersion: CONSISTENCY_PROMPT_VERSION,
    model,
    effectType: "consistency",
    codex: codexPayload,
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}`,
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
): Promise<IntraPayloadResult> {
  const sceneText = await getScenePlainText(sceneId);
  const inputHash = await computeInputHash({
    promptVersion: INTRA_CONSISTENCY_PROMPT_VERSION,
    model,
    effectType: "intra_scene_consistency",
    scene: normalizeText(sceneText),
    scope: `scene:${sceneId}`,
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
    | "review" = "consistency",
): Promise<MultiPayloadResult> {
  const { nodes } = useTreeStore.getState();
  const sceneIds = getSceneIdsForScope(nodes, scopeType, scopeTargetId);

  const scenes: MultiSceneEntry[] = [];
  for (const sceneId of sceneIds) {
    const sceneText = await getScenePlainText(sceneId);
    if (effectType === "consistency") {
      const codexPayload = await buildCodexPayload(projectId, sceneText);
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
          : INTRA_CONSISTENCY_PROMPT_VERSION;

  const inputHash = await computeInputHash({
    promptVersion,
    model,
    effectType,
    scene: scenes.map((s) => normalizeText(s.scene_text)).join("|"),
    scope: `${scopeType}:${scopeTargetId ?? "all"}`,
  });

  return { scenes, inputHash };
}
