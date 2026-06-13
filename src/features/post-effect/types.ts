import type {
  PostEffectRun,
  PostEffectAnnotation,
  PostEffectAnnotationRelation,
  PostEffectType,
  PostEffectScopeType,
  PostEffectRunStatus,
  PostEffectCategory,
  PostEffectSeverity,
  PostEffectStatus,
  PostEffectRelationType,
  PostEffectRelationDirection,
  SceneLensData,
} from "@/db/schema";

export type {
  PostEffectRun,
  PostEffectAnnotation,
  PostEffectAnnotationRelation,
  PostEffectType,
  PostEffectScopeType,
  PostEffectRunStatus,
  PostEffectCategory,
  PostEffectSeverity,
  PostEffectStatus,
  PostEffectRelationType,
  PostEffectRelationDirection,
  SceneLensData,
};

// ---------------------------------------------------------------------------
// Annotation metadata shapes
// ---------------------------------------------------------------------------

export interface ConsistencyAnnotationMeta {
  codex_ref?: {
    entry_id: string;
    entry_name: string;
    source_field: "summary" | "content" | "detail";
    source_excerpt?: string;
    detail_definition_id?: string;
    detail_name?: string;
    expected_value: string;
    found_value: string;
    found_text: string;
    found_context: string;
    confidence: "high" | "medium" | "low";
    llm_reason: string;
    dismiss_key: string;
    dismiss_source?: "manual" | "run_completed" | "cascade";
    resolved_via?: string;
    /** この annotation を検出した時の AI model 識別子 (例 "gpt-4o-mini") */
    detected_by_model?: string;
  };
  /** range が特定できなかった (LLM の found_text が scene に見つからない等) */
  orphaned?: boolean;
}

export interface IntraAnnotationMeta {
  confidence: "high" | "medium" | "low";
  llm_reason: string;
  found_text: string;
  found_context: string;
  dismiss_key: string;
  dismiss_source?: "manual" | "run_completed" | "cascade";
  orphaned?: boolean;
  detected_by_model?: string;
}

export type TypoCategory =
  // Japanese typo categories
  | "okurigana"
  | "missing-particle"
  | "missing-char"
  // English typo categories
  | "spelling"
  | "grammar"
  | "punctuation"
  // shared
  | "homophone"
  | "other";

export interface TypoAnnotationMeta {
  typo_ref?: {
    category: TypoCategory;
    found_text: string;
    found_context: string;
    suggestion: string;
    confidence: "high" | "medium" | "low";
    llm_reason: string;
    dismiss_key: string;
    dismiss_source?: "manual" | "run_completed" | "cascade";
    detected_by_model?: string;
  };
  orphaned?: boolean;
}

/**
 * review (編集者視点の診断レポート) annotation の metadata。
 * `content` 側に見出し (title) を入れ、理由・位置情報は metadata に置く。
 * span 指摘 (found_text あり) と scene 全体所見 (found_text 無し → orphaned) の両方を許容。
 */
export interface ReviewAnnotationMeta {
  llm_reason?: string;
  found_text?: string;
  found_context?: string;
  dismiss_key?: string;
  dismiss_source?: "manual" | "run_completed" | "cascade";
  detected_by_model?: string;
  orphaned?: boolean;
}

export type IntentDriftRelation =
  | "contradicts"
  | "absent"
  | "dilutes"
  | "ambiguous";

/**
 * intent_drift (狙いズレ指摘) annotation の metadata。
 */
export interface IntentDriftAnnotationMeta {
  relation?: IntentDriftRelation;
  llm_reason?: string;
  found_text?: string;
  found_context?: string;
  dismiss_key?: string;
  dismiss_source?: "manual" | "run_completed" | "cascade";
  detected_by_model?: string;
  orphaned?: boolean;
}

export type TimelineRelation =
  | "chronology"
  | "causality"
  | "contradiction"
  | "ambiguous";

/**
 * timeline_consistency (物語内時系列の整合性指摘) annotation の metadata。
 * 対象シーン本文 vs 確立済タイムライン要約のズレを指摘する。intent_drift と同型。
 */
export interface TimelineAnnotationMeta {
  relation?: TimelineRelation;
  llm_reason?: string;
  found_text?: string;
  found_context?: string;
  dismiss_key?: string;
  dismiss_source?: "manual" | "run_completed" | "cascade";
  detected_by_model?: string;
  orphaned?: boolean;
}

/**
 * pseudo_comment (読者ペルソナによる本文横コメント) annotation の metadata。
 * persona はペルソナ名。スレッド返信は annotation.parent_id で表現する。
 */
export interface PseudoCommentAnnotationMeta {
  persona?: string;
  found_text?: string;
  found_context?: string;
  detected_by_model?: string;
  orphaned?: boolean;
}

// ---------------------------------------------------------------------------
// Codex payload entry (frontend → Rust)
// ---------------------------------------------------------------------------

export interface CodexPayloadEntry {
  id: string;
  name: string;
  type: string;
  summary: string | null;
  /** PM JSON converted to plain text via phaseResolver */
  content_plain: string;
  /** Detail values where includeInContext=1 */
  detail_values: Array<{ name: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Start run request / response
// ---------------------------------------------------------------------------

export interface StartPostEffectRunRequest {
  project_id: string;
  effect_type: PostEffectType;
  scope_type: PostEffectScopeType;
  scope_target_id?: string | null;
  model: string;
  prompt_version: string;
  input_hash: string;
  /** JSON array of CodexPayloadEntry (consistency only; empty for intra_scene) */
  codex_payload_json: string;
  scene_text: string;
  /** System prompt 本文。FE catalog (`src/prompts/ja/postEffect.ts`) から取得して渡す。 */
  system_prompt: string;
  /** pseudo_comment の読者ペルソナ名 (他 effect_type では省略)。 */
  persona?: string | null;
}

export interface StartPostEffectRunResult {
  run_id: string;
  /** true if a cached (same input_hash) run was returned instead of launching */
  from_cache: boolean;
}

export interface StartPostEffectRunMultiRequest {
  project_id: string;
  effect_type: PostEffectType;
  scope_type: PostEffectScopeType;
  scope_target_id?: string | null;
  model: string;
  prompt_version: string;
  input_hash: string;
  scenes: Array<{
    scene_id: string;
    codex_payload_json: string;
    scene_text: string;
  }>;
  /** System prompt 本文。FE catalog (`src/prompts/ja/postEffect.ts`) から取得して渡す。 */
  system_prompt: string;
}

// ---------------------------------------------------------------------------
// Stream event payloads (post_effect:*)
// ---------------------------------------------------------------------------

export interface PostEffectProgressEvent {
  run_id: string;
  stage: string;
  progress: number;
  message?: string;
}

export interface PostEffectPartialEvent {
  run_id: string;
  annotation_id: string;
}

export interface PostEffectDoneEvent {
  run_id: string;
  annotation_count: number;
  summary?: string;
  /**
   * バックエンドからの実 done イベントには無く、`runPostEffect` が
   * `from_cache: true` のとき合成 onDone を発火する際に true をセットする。
   * 呼び出し側で「キャッシュ短絡で実呼び出ししていない」ことを toast 等で
   * 区別表示する用途。
   */
  from_cache?: boolean;
}

export interface PostEffectErrorEvent {
  run_id: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Query responses
// ---------------------------------------------------------------------------

/**
 * scene_lens_data の 1 レコード (meta_structure の俯瞰診断)。
 * Rust の list_scene_lens_for_project が camelCase + metrics を parse 済み object で返す。
 * `runCompletedAt` は stale 判定 (scene.updatedAt > runCompletedAt) 用。
 */
export interface SceneLensRecord {
  id: string;
  projectId: string;
  runId: string;
  targetId: string | null;
  lensType: "plot_structure" | "pacing" | "character_arc" | "pov";
  metrics: Record<string, unknown>;
  finding: string | null;
  severity: PostEffectSeverity;
  createdAt: string;
  runCompletedAt: string | null;
}

export interface AnnotationsForSceneResponse {
  annotations: PostEffectAnnotation[];
  /** Relations where at least one endpoint is in the returned annotations */
  relations: PostEffectAnnotationRelation[];
}

export interface RunDetailResponse extends PostEffectRun {
  annotations: PostEffectAnnotation[];
  relations: PostEffectAnnotationRelation[];
  lens_data: SceneLensData[];
}
