/**
 * impact-review オーケストレーション（手動トリガ）。
 * 現在スナップショット ↔ baseline 差分 → stage-a 候補シーン絞り → impact_review effect 実行
 * → 完了時に baseline を現在へ更新。注釈は post_effect_annotations に入り Kouetsu が表示する。
 */

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  runPostEffectMulti,
  type PostEffectRunCallbacks,
} from "@/features/post-effect/api";
import type {
  SqliteSourceRevisionGuard,
  StartPostEffectRunMultiRequest,
} from "@/features/post-effect/types";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import {
  computeInputHash,
  normalizeText,
  stableStringify,
} from "@/features/post-effect/canonicalize";
import { IMPACT_REVIEW_PROMPT_VERSION } from "@/features/post-effect/consistencyPayloadBuilder";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  computeCodexDiff,
  summarizeChanges,
  computeChangeId,
  type CodexSnapshot,
  type ImpactChange,
} from "./diff";
import { buildCodexSnapshot, type CodexSnapshotResult } from "./snapshot";
import { getBaseline, saveBaseline } from "./baseline";
import { narrowCandidateScenes, type SceneCandidate } from "./narrowing";
import { canIncludeResolvedCodexContext } from "@/features/codex/context/codexVisibilityPolicy";

/** Rust の process_impact_review_scene が読む per-scene 差分ペイロード（契約固定）。 */
interface ImpactDiffPayload {
  change_id: string;
  entry_id: string;
  entry_name: string;
  entry_type: string;
  change_summary: string;
  changes: ImpactChange[];
}

export type ImpactReviewStatus =
  | "no-change" // baseline と差分なし
  | "no-candidates" // 差分はあるが影響候補シーン 0
  | "source-changed" // 候補確定後に入力が変化したため再実行が必要
  | "started"; // 実行開始（注釈は完了後に Kouetsu へ）

export interface ImpactReviewResult {
  status: ImpactReviewStatus;
  changeCount: number;
  changeSummary: string;
  candidateSceneCount: number;
  runId?: string;
  cleanup?: () => void;
}

const CANDIDATE_LIMIT = 30;
const IMPACT_SOURCE_CHANGED_MARKER = "IMPACT_SOURCE_CHANGED";
const BASELINE_CONTENT_HASH_SYMBOL = Symbol.for(
  "grimodex.impactReviewBaseline.contentHash",
);
type BaselineHashExpectation = string | null | undefined;

class ImpactReviewSourceChangedError extends Error {
  constructor() {
    super("Codex source changed before impact-review dispatch");
    this.name = "ImpactReviewSourceChangedError";
  }
}

function isImpactSourceChangedError(error: unknown): boolean {
  if (error instanceof ImpactReviewSourceChangedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(IMPACT_SOURCE_CHANGED_MARKER);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortDetails(
  details: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  return [...details].sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.value, b.value),
  );
}

/** Order-insensitive fingerprint of every source value used by this run. */
function impactSourceFingerprint(source: CodexSnapshotResult): string {
  const snapshot = source.snapshot;
  return stableStringify({
    projectId: source.projectId,
    entryType: source.entryType,
    entryName: source.entryName,
    contextMode: source.contextMode ?? "mentioned",
    hasRestrictedPhases: source.hasRestrictedPhases ?? false,
    snapshot: {
      ...snapshot,
      aliases: [...snapshot.aliases].sort(compareText),
      details: sortDetails(snapshot.details),
      phases: [...(snapshot.phases ?? [])]
        .map((phase) => ({
          ...phase,
          details: sortDetails(phase.details),
        }))
        .sort((a, b) => compareText(a.phaseId, b.phaseId)),
      allPhaseIds: [...(snapshot.allPhaseIds ?? [])].sort(compareText),
      restrictedPhaseIds: [...(snapshot.restrictedPhaseIds ?? [])].sort(
        compareText,
      ),
      visibleDeletedPhaseIds: [...(snapshot.visibleDeletedPhaseIds ?? [])].sort(
        compareText,
      ),
    },
  });
}

function baselineHashExpectation(
  baseline: CodexSnapshot | null,
): BaselineHashExpectation {
  if (baseline === null) return null;
  const value = Reflect.get(baseline, BASELINE_CONTENT_HASH_SYMBOL);
  return typeof value === "string" ? value : undefined;
}

async function persistBaseline(
  entryId: string,
  projectId: string,
  snapshot: CodexSnapshot,
  expectedContentHash: BaselineHashExpectation,
  sourceGuard?: SqliteSourceRevisionGuard,
): Promise<string> {
  return expectedContentHash === undefined
    ? saveBaseline(projectId, entryId, snapshot, undefined, sourceGuard)
    : saveBaseline(
        projectId,
        entryId,
        snapshot,
        expectedContentHash,
        sourceGuard,
      );
}

async function saveBaselineIfSourceCurrent(
  entryId: string,
  projectId: string,
  snapshot: CodexSnapshot,
  sourceFingerprint: string,
  expectedContentHash: BaselineHashExpectation,
): Promise<boolean> {
  const latest = await buildCodexSnapshot(entryId);
  if (!latest || impactSourceFingerprint(latest) !== sourceFingerprint) {
    return false;
  }
  await persistBaseline(entryId, projectId, snapshot, expectedContentHash);
  return true;
}

function phaseIds(snapshot: CodexSnapshot): Set<string> {
  return new Set(
    snapshot.allPhaseIds ??
      snapshot.phases?.map((phase) => phase.phaseId) ??
      [],
  );
}

function redactRestrictedPhases(
  snapshot: CodexSnapshot | null,
  restrictedPhaseIds: ReadonlySet<string>,
): CodexSnapshot | null {
  if (!snapshot || restrictedPhaseIds.size === 0) return snapshot;
  return {
    ...snapshot,
    phases: (snapshot.phases ?? []).filter(
      (phase) => !restrictedPhaseIds.has(phase.phaseId),
    ),
  };
}

function emptyBaselineWithRestrictionMetadata(
  snapshot: CodexSnapshot,
  restrictedPhaseIds: string[],
): CodexSnapshot {
  return {
    name: "",
    aliases: [],
    summary: "",
    contentPlain: "",
    details: [],
    phases: [],
    visibilityProvenanceVersion: 1,
    allPhaseIds: snapshot.allPhaseIds ?? [],
    restrictedPhaseIds,
  };
}

/** 候補シーンの本文プレーンテキストを 1 クエリで一括取得する（sceneId → text）。 */
async function getScenePlainTexts(
  projectId: string,
  sceneIds: string[],
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (sceneIds.length === 0) return texts;
  const rows = await db
    .select({ id: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, projectId),
        eq(treeNodes.nodeType, "scene"),
        inArray(treeNodes.id, sceneIds),
      ),
    );
  for (const row of rows) {
    texts.set(row.id, prosemirrorToText(row.content ?? "{}"));
  }
  return texts;
}

interface ImpactSceneSource {
  scene_id: string;
  scene_text: string;
}

async function getCandidateSceneSources(
  projectId: string,
  candidates: SceneCandidate[],
): Promise<ImpactSceneSource[]> {
  const texts = await getScenePlainTexts(
    projectId,
    candidates.map((candidate) => candidate.sceneId),
  );
  return candidates.flatMap((candidate) => {
    const sceneText = texts.get(candidate.sceneId) ?? "";
    return sceneText.trim() === ""
      ? []
      : [{ scene_id: candidate.sceneId, scene_text: sceneText }];
  });
}

function sameSceneSourceSet(
  expected: readonly ImpactSceneSource[],
  actual: readonly ImpactSceneSource[],
): boolean {
  if (expected.length !== actual.length) return false;
  const actualById = new Map(
    actual.map((scene) => [scene.scene_id, scene.scene_text]),
  );
  if (actualById.size !== actual.length) return false;
  return expected.every(
    (scene) => actualById.get(scene.scene_id) === scene.scene_text,
  );
}

function baselineIsCurrent(
  latest: CodexSnapshot | null,
  expectedFingerprint: string,
  expectedContentHash: BaselineHashExpectation,
): boolean {
  if (stableStringify(latest) !== expectedFingerprint) return false;
  return (
    expectedContentHash === undefined ||
    baselineHashExpectation(latest) === expectedContentHash
  );
}

interface ImpactInputValidation {
  entryId: string;
  projectId: string;
  sourceFingerprint: string;
  baselineFingerprint: string;
  baselineExpectedContentHash: BaselineHashExpectation;
  queryText: string;
  mentionTerms: string[];
  expectedScenes: readonly ImpactSceneSource[];
}

async function captureValidatedImpactInputs({
  entryId,
  projectId,
  sourceFingerprint,
  baselineFingerprint,
  baselineExpectedContentHash,
  queryText,
  mentionTerms,
  expectedScenes,
}: ImpactInputValidation): Promise<SqliteSourceRevisionGuard | null> {
  // Capture the revision first. The backend (or guarded baseline write) rejects
  // any mutation that races the baseline/candidate/text reads below.
  const latest = await buildCodexSnapshot(entryId);
  if (
    !latest ||
    impactSourceFingerprint(latest) !== sourceFingerprint ||
    !canIncludeResolvedCodexContext(
      latest.contextMode ?? "mentioned",
      "current-mention",
    ) ||
    latest.hasRestrictedPhases
  ) {
    return null;
  }

  const latestBaseline = await getBaseline(entryId);
  if (
    !baselineIsCurrent(
      latestBaseline,
      baselineFingerprint,
      baselineExpectedContentHash,
    )
  ) {
    return null;
  }

  const latestCandidates = await narrowCandidateScenes(
    projectId,
    entryId,
    queryText,
    mentionTerms,
    { limit: CANDIDATE_LIMIT },
  );
  const latestScenes = await getCandidateSceneSources(
    projectId,
    latestCandidates,
  );
  return sameSceneSourceSet(expectedScenes, latestScenes)
    ? latest.sourceRevision
    : null;
}

/**
 * エントリの変更影響をレビューする。manual トリガ。
 * callbacks は runPostEffectMulti へ pass-through（onDone は baseline 更新でラップ）。
 */
export async function runImpactReview(
  entryId: string,
  callbacks: PostEffectRunCallbacks = {},
): Promise<ImpactReviewResult> {
  const built = await buildCodexSnapshot(entryId);
  if (!built) {
    return {
      status: "no-change",
      changeCount: 0,
      changeSummary: "",
      candidateSceneCount: 0,
    };
  }
  const {
    snapshot,
    projectId,
    entryType,
    entryName,
    contextMode = "mentioned",
    hasRestrictedPhases = false,
  } = built;
  const sourceFingerprint = impactSourceFingerprint(built);

  let baseline = await getBaseline(entryId);
  let baselineExpectedContentHash = baselineHashExpectation(baseline);
  const currentRestrictedPhaseIds = new Set(snapshot.restrictedPhaseIds ?? []);
  const currentHasRestrictedPhases =
    hasRestrictedPhases || currentRestrictedPhaseIds.size > 0;

  // Persist only restriction metadata while preserving the last reviewed
  // values. This tombstone prevents a later phase deletion from reconstructing
  // hidden/suppressed content as an old -> empty AI diff.
  if (currentRestrictedPhaseIds.size > 0) {
    const previousRestrictedPhaseIds = new Set(
      baseline?.restrictedPhaseIds ?? [],
    );
    const hasNewRestriction = [...currentRestrictedPhaseIds].some(
      (phaseId) => !previousRestrictedPhaseIds.has(phaseId),
    );
    if (hasNewRestriction) {
      const restrictedPhaseIds = [
        ...new Set([
          ...previousRestrictedPhaseIds,
          ...currentRestrictedPhaseIds,
        ]),
      ].sort();
      baseline = baseline
        ? {
            ...baseline,
            allPhaseIds: snapshot.allPhaseIds ?? baseline.allPhaseIds,
            restrictedPhaseIds,
          }
        : emptyBaselineWithRestrictionMetadata(snapshot, restrictedPhaseIds);
      baselineExpectedContentHash = await persistBaseline(
        entryId,
        projectId,
        baseline,
        baselineExpectedContentHash,
      );
    }
  }
  const baselineFingerprint = stableStringify(baseline);

  const currentPhaseIds = phaseIds(snapshot);
  const visibleDeletedPhaseIds = new Set(
    baseline?.visibleDeletedPhaseIds ?? [],
  );
  const effectiveRestrictedPhaseIds = new Set(currentRestrictedPhaseIds);
  for (const phaseId of baseline?.restrictedPhaseIds ?? []) {
    // A restriction is released only when the same phase still exists and is
    // currently visible. Missing phases retain a deletion tombstone.
    if (!currentPhaseIds.has(phaseId)) {
      effectiveRestrictedPhaseIds.add(phaseId);
    }
  }
  for (const phase of baseline?.phases ?? []) {
    // Only the authoritative Phase write API can prove that a missing phase
    // was visible when deleted. Legacy/unknown deletions remain fail-closed;
    // otherwise a hidden -> delete transition could expose the old body.
    if (
      !currentPhaseIds.has(phase.phaseId) &&
      !visibleDeletedPhaseIds.has(phase.phaseId)
    ) {
      effectiveRestrictedPhaseIds.add(phase.phaseId);
    }
  }

  const safeBaseline = redactRestrictedPhases(
    baseline,
    effectiveRestrictedPhaseIds,
  );
  const safeSnapshot = redactRestrictedPhases(
    snapshot,
    effectiveRestrictedPhaseIds,
  ) as CodexSnapshot;
  const changes = computeCodexDiff(safeBaseline, safeSnapshot);
  const changeSummary = summarizeChanges(changes);

  if (changes.length === 0) {
    // Once a restricted phase has been safely deleted, discard its redacted
    // baseline body and tombstone without involving an AI provider.
    if (
      (effectiveRestrictedPhaseIds.size > 0 ||
        (baseline?.restrictedPhaseIds?.length ?? 0) > 0 ||
        (baseline?.visibleDeletedPhaseIds?.length ?? 0) > 0) &&
      !currentHasRestrictedPhases &&
      canIncludeResolvedCodexContext(contextMode, "current-mention")
    ) {
      await saveBaselineIfSourceCurrent(
        entryId,
        projectId,
        snapshot,
        sourceFingerprint,
        baselineExpectedContentHash,
      );
    }
    return {
      status: "no-change",
      changeCount: 0,
      changeSummary: "",
      candidateSceneCount: 0,
    };
  }

  // Semantic links are an explicit relevance signal, not permission to expose
  // a hidden/suppressed Codex body to an AI provider. Do not advance the local
  // baseline here: if the author later exposes the entry, the pending change
  // should still be reviewed.
  // Impact review is not yet phase-resolved per candidate scene, so the
  // presence of even one restricted phase also fails closed for the whole run.
  if (
    currentHasRestrictedPhases ||
    !canIncludeResolvedCodexContext(contextMode, "current-mention")
  ) {
    return {
      status: "no-candidates",
      changeCount: changes.length,
      changeSummary,
      candidateSceneCount: 0,
    };
  }

  const changeId = computeChangeId(entryId, changes);

  // stage-a: dense クエリ（名前＋旧新値）＋ sparse 言及（名前＋別名）で候補シーン絞り
  const queryText = [entryName, ...changes.flatMap((c) => [c.old, c.new])]
    .filter((s) => s.trim() !== "")
    .join("。");
  const mentionTerms = [entryName, ...snapshot.aliases];
  const validationContext = {
    entryId,
    projectId,
    sourceFingerprint,
    baselineFingerprint,
    baselineExpectedContentHash,
    queryText,
    mentionTerms,
  };
  const advanceBaselineIfInputsCurrent = async (
    expectedScenes: readonly ImpactSceneSource[],
  ): Promise<boolean> => {
    const sourceGuard = await captureValidatedImpactInputs({
      ...validationContext,
      expectedScenes,
    });
    if (!sourceGuard) return false;
    try {
      await persistBaseline(
        entryId,
        projectId,
        snapshot,
        baselineExpectedContentHash,
        sourceGuard,
      );
      return true;
    } catch (error) {
      if (isImpactSourceChangedError(error)) return false;
      throw error;
    }
  };
  const candidates = await narrowCandidateScenes(
    projectId,
    entryId,
    queryText,
    mentionTerms,
    { limit: CANDIDATE_LIMIT },
  );

  if (candidates.length === 0) {
    // Candidate membership is a source input too: a semantic mark can be added
    // without changing Codex values. Re-run it and make the baseline write use
    // the same SQLite revision as one atomic statement.
    const advanced = await advanceBaselineIfInputsCurrent([]);
    return {
      status: advanced ? "no-candidates" : "source-changed",
      changeCount: changes.length,
      changeSummary,
      candidateSceneCount: 0,
    };
  }

  const diffPayload: ImpactDiffPayload = {
    change_id: changeId,
    entry_id: entryId,
    entry_name: entryName,
    entry_type: entryType,
    change_summary: changeSummary,
    changes,
  };
  const codexPayloadJson = JSON.stringify(diffPayload);

  const sceneSources = await getCandidateSceneSources(projectId, candidates);
  const scenes = sceneSources.map((scene) => ({
    scene_id: scene.scene_id,
    codex_payload_json: codexPayloadJson,
    scene_text: scene.scene_text,
  }));

  if (scenes.length === 0) {
    const advanced = await advanceBaselineIfInputsCurrent([]);
    return {
      status: advanced ? "no-candidates" : "source-changed",
      changeCount: changes.length,
      changeSummary,
      candidateSceneCount: 0,
    };
  }

  const lang = getCurrentProjectLanguage();
  const ov = resolveRoleSendOverride("post_effect_impact_review");
  const model =
    ov.model ?? useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
  const systemPrompt = getPromptCatalog(lang).postEffect.impactReviewSystem;

  const inputHash = await computeInputHash({
    promptVersion: IMPACT_REVIEW_PROMPT_VERSION,
    model,
    effectType: "impact_review",
    provider: ov.provider,
    endpointId: ov.endpointId,
    codex: diffPayload,
    scene: scenes.map((s) => normalizeText(s.scene_text)).join("|"),
    scope: `impact:${entryId}:${changeId}`,
  });

  const request: StartPostEffectRunMultiRequest = {
    project_id: projectId,
    effect_type: "impact_review",
    scope_type: "project",
    scope_target_id: null,
    model,
    model_override: ov.model,
    provider_override: ov.provider,
    api_variant_override: ov.apiVariant,
    endpoint_id_override: ov.endpointId,
    prompt_version: IMPACT_REVIEW_PROMPT_VERSION,
    input_hash: inputHash,
    source_guard: built.sourceRevision,
    scenes,
    system_prompt: systemPrompt,
  };

  let runResult: { runId: string; cleanup: () => void };
  try {
    runResult = await runPostEffectMulti(request, {
      ...callbacks,
      beforeStart: async () => {
        await callbacks.beforeStart?.();
        const finalRevision = await captureValidatedImpactInputs({
          ...validationContext,
          expectedScenes: request.scenes,
        });
        if (!finalRevision) {
          throw new ImpactReviewSourceChangedError();
        }
        // Derived mention/index writes may legitimately finish while the run is
        // being prepared. Once the exact Codex and scene payload has been
        // revalidated, anchor the backend guard at this final coherent read.
        // Any write after it is rejected under BEGIN IMMEDIATE together with
        // cache lookup / run creation.
        request.source_guard = finalRevision;
      },
      onDone: async (e) => {
        // レビュー完了 → baseline を現在状態へ進める（次回は今回以降の差分を見る）。
        // 部分失敗 (summary あり = 一部シーンが未解析) では前進させない:
        // ここで進めると computeCodexDiff が次回 'no-change' になり、失敗した
        // シーンはこの変更について二度と再チェックされなくなる。据え置けば
        // 再実行で全候補シーンが同じ差分で再チェックされる。
        if (!e.summary && !currentHasRestrictedPhases) {
          try {
            await advanceBaselineIfInputsCurrent(request.scenes);
          } catch {
            /* baseline 更新失敗は致命ではない */
          }
        }
        await callbacks.onDone?.(e);
      },
    });
  } catch (error) {
    if (isImpactSourceChangedError(error)) {
      return {
        status: "source-changed",
        changeCount: changes.length,
        changeSummary,
        candidateSceneCount: scenes.length,
      };
    }
    throw error;
  }

  const { runId, cleanup } = runResult;

  return {
    status: "started",
    changeCount: changes.length,
    changeSummary,
    candidateSceneCount: scenes.length,
    runId,
    cleanup,
  };
}
