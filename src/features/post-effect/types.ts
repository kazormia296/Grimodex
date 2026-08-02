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
  /**
   * relation='causality' のとき、原因イベントが属するシーンの id (timeline 要約から
   * LLM が選ぶ「因」)。annotation 自体は「果」のシーンに anchor 済み。因果地図の有向辺
   * (cause→effect) の cause 端点。LLM が hallucinate しうるので、描画側 (buildCausalityDag)
   * で実在シーンに解決できないものは捨てる。
   */
  cause_scene_id?: string;
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

/**
 * impact_review (影響度レビュー) annotation の metadata。
 * 「変更された Codex 設定」に対し、本文中の矛盾箇所を指摘する。
 * consistency の codex_ref とは分離した impact_ref に格納する
 * （カテゴリ impact_review_anchor で別フィルタするため）。
 */
export interface ImpactReviewAnnotationMeta {
  impact_ref?: {
    entry_id: string;
    entry_name: string;
    /** 今回レビュー対象の変更を識別するキー（baseline→現在の差分ハッシュ等） */
    change_id: string;
    /** 何が変わったかの要約（例「年齢 15→17」） */
    change_summary: string;
    /** 矛盾の強さ 0.0–1.0 */
    contradiction_score: number;
    found_text: string;
    found_context: string;
    confidence: "high" | "medium" | "low";
    llm_reason: string;
    dismiss_key: string;
    dismiss_source?: "manual" | "run_completed" | "cascade";
    detected_by_model?: string;
  };
  /** range が特定できなかった (found_text が scene に見つからない等) */
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
  effect_type: Exclude<PostEffectType, "impact_review">;
  scope_type: PostEffectScopeType;
  scope_target_id?: string | null;
  model: string;
  /**
   * 機能別モデル: 対応ロールの override（省略/空 = 既定モデル）。実 API 呼び出しの
   * モデルだけを差し替え、`model`（input_hash / runs.model 記録用）には影響しない。
   * 解決は modelRouting.resolveModelForPath が正本。
   */
  model_override?: string | null;
  /**
   * 機能別モデルのプロバイダ横断 override（省略 = 既定プロバイダ）。model_override と
   * 並走し、送信先プロバイダ/API 経路/エンドポイントを差し替える。
   * 解決は modelRouting.resolveRoleSendOverride が正本。
   */
  provider_override?: string | null;
  api_variant_override?: string | null;
  endpoint_id_override?: string | null;
  prompt_version: string;
  input_hash: string;
  /** JSON array of CodexPayloadEntry (consistency only; empty for intra_scene) */
  codex_payload_json: string;
  scene_text: string;
  /** System prompt 本文。FE catalog (`src/prompts/ja/postEffect.ts`) から取得して渡す。 */
  system_prompt: string;
  /** pseudo_comment の読者ペルソナ名 (他 effect_type では省略)。 */
  persona?: string | null;
  /** true のとき、保存せず post_effect:partial に一時コメントを流す。 */
  live?: boolean;
}

export interface StartPostEffectRunResult {
  run_id: string;
  /** true if a cached (same input_hash) run was returned instead of launching */
  from_cache: boolean;
}

/**
 * Snapshot revision captured from the workspace SQLite connection.
 * `total_changes()` covers writes on this connection while `data_version`
 * covers commits made through another connection (for example standalone MCP).
 * Decimal strings avoid losing u64 precision at the JS boundary.
 */
export interface SqliteSourceRevisionGuard {
  kind: "sqlite_revision_v1";
  expected_connection_epoch: string;
  expected_total_changes: string;
  expected_data_version: string;
}

interface StartPostEffectRunMultiBase {
  project_id: string;
  scope_type: PostEffectScopeType;
  scope_target_id?: string | null;
  model: string;
  /**
   * 機能別モデル: 対応ロールの override（省略/空 = 既定モデル）。実 API 呼び出しの
   * モデルだけを差し替え、`model`（input_hash / runs.model 記録用）には影響しない。
   */
  model_override?: string | null;
  /**
   * 機能別モデルのプロバイダ横断 override（省略 = 既定プロバイダ）。model_override と
   * 並走し、送信先プロバイダ/API 経路/エンドポイントを差し替える。
   * 解決は modelRouting.resolveRoleSendOverride が正本。
   */
  provider_override?: string | null;
  api_variant_override?: string | null;
  endpoint_id_override?: string | null;
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

export type StartPostEffectRunMultiRequest = StartPostEffectRunMultiBase &
  (
    | {
        effect_type: "impact_review";
        source_guard: SqliteSourceRevisionGuard;
      }
    | {
        effect_type: Exclude<PostEffectType, "impact_review">;
        source_guard?: never;
      }
  );

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
  /** live=true の擬似コメントだけが持つ。通常の永続 annotation では省略。 */
  live_comment?: {
    content: string;
    persona?: string | null;
    found_text?: string;
    found_context?: string;
  };
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
/** persist:false is used by automatic panel-follow without changing settings. */
export interface LayerSetOptions {
  persist?: boolean;
}
