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
  };
}

export interface IntraAnnotationMeta {
  confidence: "high" | "medium" | "low";
  llm_reason: string;
  found_text: string;
  found_context: string;
  dismiss_key: string;
  dismiss_source?: "manual" | "run_completed" | "cascade";
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
}

export interface StartPostEffectRunResult {
  run_id: string;
  /** true if a cached (same input_hash) run was returned instead of launching */
  from_cache: boolean;
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
}

export interface PostEffectErrorEvent {
  run_id: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Query responses
// ---------------------------------------------------------------------------

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
