//! Tauri / Electron で共有する PostEffects 実行エンジン。
//! 設計書: docs/Grimodex_PostEffects設計書.md
//!
//! 実行フロー:
//!   start_post_effect_run → 即 run_id 返却 (fire-and-forget)
//!     → tokio::spawn で run_consistency_task / run_intra_task を実行
//!     → post_effect:progress / :partial / :done / :error イベントを emit

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use uuid::Uuid;

use grimodex_ai::{AiProvider, AiSettings};
use grimodex_db::{AppError, Database};

/// PostEffect runner がシェルへ要求する最小機能。
///
/// generic method を持つため object-safe ではないが、runner 自体も runtime 型で
/// monomorphize する。Tauri は AppHandle、napi は Arc<AppState> の薄い adapter で
/// 実装し、DB・イベント・abort state の正本をそれぞれの常駐 state に保つ。
pub trait PostEffectRuntime: Clone + Send + Sync + 'static {
    /// 現在 workspace の DB をこの runtime clone へ固定する。start は cache 照合・
    /// running INSERT より前に必ず呼び、detached worker の全 DB 操作を同じ Arc へ
    /// 着弾させる。abort command は未 pin runtime のまま registry の binding を使う。
    fn pin_database(&self) -> Result<Self, AppError>;

    /// pin 済み DB。新規 run を abort registry へ束縛するために使う。
    fn pinned_database(&self) -> Option<Arc<Database>>;

    fn with_db<T, F>(&self, f: F) -> Result<T, AppError>
    where
        F: FnOnce(&Database) -> anyhow::Result<T>;

    /// emit は従来どおり best-effort。シェル固有の失敗は adapter 側で握る。
    fn emit(&self, channel: &str, payload: Value);

    fn abort_registry(&self) -> &PostEffectAbortRegistry;

    fn bind_abort_database(&self, run_id: &str) {
        if let Some(db) = self.pinned_database() {
            self.abort_registry().bind_database(run_id, db);
        } else {
            tracing::error!(run_id, "post-effect run has no pinned database to bind");
        }
    }

    /// registry lock → DB CAS → aborted insert を1 critical sectionにする。
    /// worker の `is_aborted` も同じ lock を取るため、CAS後かつflag前に次sceneを
    /// 開始する TOCTOU window は存在しない。
    fn request_abort_if<F>(&self, run_id: &str, request: F) -> Result<bool, AppError>
    where
        F: FnOnce(Option<&Arc<Database>>) -> Result<bool, AppError>,
    {
        self.abort_registry().request_if(run_id, request)
    }

    fn is_aborted(&self, run_id: &str) -> bool {
        self.abort_registry().is_aborted(run_id)
    }

    fn clear_abort(&self, run_id: &str) {
        self.abort_registry().clear(run_id);
    }
}

/// 1 回の post-effect API 呼び出しに必要な値。
/// role override を使わない effect は model_override=None / role_override=default
/// を渡すことで、現行 Tauri の非対称な override 契約をそのまま保存する。
pub struct PostEffectAiRequest<'a> {
    pub model_override: Option<&'a str>,
    pub role_override: &'a RoleProviderOverride,
    pub system_prompt: &'a str,
    pub codex_content: Option<&'a str>,
    pub scene_content: &'a str,
}

/// API 生応答と、annotation metadata に記録する実効モデル。
pub struct PostEffectAiOutput {
    pub raw_response: String,
    pub detected_model: String,
}

/// 設定・secret 解決と HTTP 呼び出しを shell から注入する seam。
///
/// Tauri 実装は call ごとに ai-settings + keyring を読み、Electron 実装は main が
/// safeStorage から作った snapshot を使う。Fake 実装で error / panic / partial
/// failure をネットワーク無しに駆動できる。
pub trait PostEffectAiClient: Clone + Send + Sync + 'static {
    fn call<'a>(
        &'a self,
        request: PostEffectAiRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<PostEffectAiOutput>> + Send + 'a>>;
}

/// run_id 単位の中止要求と開始元DB binding。clone は同じ state を共有する。
#[derive(Default)]
struct PostEffectAbortState {
    aborted: HashSet<String>,
    /// start 時の pinned DB。workspace switch 後の abort command も開始元 run を
    /// cancel できるよう run_id と一緒に保持する。
    databases: HashMap<String, Arc<Database>>,
}

#[derive(Clone, Default)]
pub struct PostEffectAbortRegistry {
    state: Arc<Mutex<PostEffectAbortState>>,
}

impl PostEffectAbortRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, PostEffectAbortState> {
        // poison は前保持者の panic 痕。フラグ集合は回復して継続できる。
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn request(&self, run_id: &str) {
        self.lock().aborted.insert(run_id.to_string());
    }

    pub fn bind_database(&self, run_id: &str, db: Arc<Database>) {
        self.lock().databases.insert(run_id.to_string(), db);
    }

    /// lock を保持したまま DB ownership/running CAS を実行し、成功したときだけ
    /// abort flag を立てる。`request` callback は binding 済み DB を優先利用する。
    pub fn request_if<F>(&self, run_id: &str, request: F) -> Result<bool, AppError>
    where
        F: FnOnce(Option<&Arc<Database>>) -> Result<bool, AppError>,
    {
        let mut state = self.lock();
        let changed = request(state.databases.get(run_id))?;
        if changed {
            state.aborted.insert(run_id.to_string());
        }
        Ok(changed)
    }

    pub fn is_aborted(&self, run_id: &str) -> bool {
        self.lock().aborted.contains(run_id)
    }

    pub fn clear(&self, run_id: &str) {
        let mut state = self.lock();
        state.aborted.remove(run_id);
        state.databases.remove(run_id);
    }
}

// ---------------------------------------------------------------------------
// プロンプトバージョン定数 — FE 側 (consistencyPayloadBuilder.ts /
// typoPayloadBuilder.ts) と必ず同値であること。プロンプト本文の変更時は
// 両側を同期して bump し、cache key が新しい input_hash と再計算される。
// ---------------------------------------------------------------------------

const CONSISTENCY_PROMPT_VERSION: &str = "consistency_v1.3";
const INTRA_PROMPT_VERSION: &str = "intra_scene_consistency_v1.2";
// impact_review (影響度レビュー): 変更された Codex 設定 (old→new) に対し本文中の
// 矛盾箇所を指摘する。FE 側 (consistencyPayloadBuilder.ts) と必ず同値であること。
const IMPACT_REVIEW_PROMPT_VERSION: &str = "impact_review_v1.1";
const TYPO_PROMPT_VERSION: &str = "typo_detection_v1.2";
const REVIEW_PROMPT_VERSION: &str = "review_v1.1";
const INTENT_DRIFT_PROMPT_VERSION: &str = "intent_drift_v1.1";
// timeline_consistency は multi (folder/project) スコープ専用。multi コマンドは
// prompt_version を検証しない (TS が timelinePayloadBuilder で権威を持つ) ため、
// Rust 側に prompt_version const は持たない。
// v2.0: ペルソナを bare label から genre/想定読者プロフィールを織り込んだ
// brief 注入へ刷新 (TS pseudoCommentPayloadBuilder と同期)。
const PSEUDO_COMMENT_PROMPT_VERSION: &str = "pseudo_comment_v2.1";
const META_STRUCTURE_PROMPT_VERSION: &str = "meta_structure_v1.2";

// システムプロンプト本文は FE catalog (src/prompts/ja/postEffect.ts) で管理し、
// `StartPostEffectRunArgs.system_prompt` として IPC 経由で渡される。
// AUDIT POINT: cache_control は Codex prefix と Scene の境界に正確に挿入される。
// call_post_effect_api がこの前提でキャッシュ境界を制御する。

// ---------------------------------------------------------------------------
// Input / Output 型
// ---------------------------------------------------------------------------

#[derive(Clone, Deserialize)]
pub struct StartPostEffectRunArgs {
    project_id: String,
    effect_type: String,
    scope_type: String,
    scope_target_id: Option<String>,
    model: String,
    /// 機能別モデル: review ロールの override（None/空 = 既定モデル）。実 API 呼び出しの
    /// モデルだけを差し替え、`model`（input_hash / runs.model 記録用）には影響しない。
    #[serde(default)]
    model_override: Option<String>,
    /// 機能別モデルのプロバイダ横断: provider override（None = 既定プロバイダ）。
    #[serde(default)]
    provider_override: Option<AiProvider>,
    /// API 経路 override（None/空 = backend 既定解決）。
    #[serde(default)]
    api_variant_override: Option<String>,
    /// openai-compatible エンドポイント override（None/空 = active）。
    #[serde(default)]
    endpoint_id_override: Option<String>,
    prompt_version: String,
    input_hash: String,
    /// JSON array of CodexPayloadEntry (consistency のみ; intra では空 JSON array を渡す)
    codex_payload_json: String,
    scene_text: String,
    /// System prompt 本文。FE catalog (src/prompts/ja/postEffect.ts) から渡される。
    system_prompt: String,
    /// pseudo_comment の読者ペルソナ名 (他 effect_type では None)。
    #[serde(default)]
    persona: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartPostEffectRunResult {
    run_id: String,
    from_cache: bool,
}

// ---------------------------------------------------------------------------
// Multi-scene run types
// ---------------------------------------------------------------------------

#[derive(Clone, Deserialize)]
pub struct ScenePayload {
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
}

#[derive(Clone, Deserialize)]
pub struct StartPostEffectRunMultiArgs {
    project_id: String,
    effect_type: String,
    scope_type: String,
    scope_target_id: Option<String>,
    model: String,
    /// 機能別モデル: review ロールの override（None/空 = 既定モデル）。実 API 呼び出しの
    /// モデルだけを差し替え、`model`（input_hash / runs.model 記録用）には影響しない。
    #[serde(default)]
    model_override: Option<String>,
    /// 機能別モデルのプロバイダ横断: provider override（None = 既定プロバイダ）。
    #[serde(default)]
    provider_override: Option<AiProvider>,
    /// API 経路 override（None/空 = backend 既定解決）。
    #[serde(default)]
    api_variant_override: Option<String>,
    /// openai-compatible エンドポイント override（None/空 = active）。
    #[serde(default)]
    endpoint_id_override: Option<String>,
    prompt_version: String,
    input_hash: String,
    scenes: Vec<ScenePayload>,
    /// System prompt 本文。FE catalog (src/prompts/ja/postEffect.ts) から渡される。
    system_prompt: String,
}

#[derive(Clone, Serialize)]
struct ProgressEvent<'a> {
    run_id: &'a str,
    stage: &'a str,
    progress: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

#[derive(Clone, Serialize)]
struct PartialEvent<'a> {
    run_id: &'a str,
    annotation_id: String,
}

#[derive(Clone, Serialize)]
struct DoneEvent<'a> {
    run_id: &'a str,
    annotation_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
}

#[derive(Clone, Serialize)]
struct ErrorEvent<'a> {
    run_id: &'a str,
    error: String,
}

fn emit_event<R: PostEffectRuntime, T: Serialize>(runtime: &R, channel: &str, payload: T) {
    match serde_json::to_value(payload) {
        Ok(value) => runtime.emit(channel, value),
        Err(error) => tracing::error!(
            channel,
            error = %error,
            "post-effect event serialization failed"
        ),
    }
}

/// 機能別モデル（review ロール）のプロバイダ横断 override。model_override と並走する
/// provider / API 経路 / エンドポイントの割り当て。全 None/空なら従来挙動（model だけ
/// 差し替え or 既定）= wire 差分ゼロ。
#[derive(Clone, Default)]
pub struct RoleProviderOverride {
    /// 送信先プロバイダ（None = 設定の既定プロバイダ）。
    pub provider: Option<AiProvider>,
    /// API 経路 override（None/空 = backend 既定解決）。
    pub api_variant: Option<String>,
    /// openai-compatible エンドポイント override（None/空 = active）。
    pub endpoint_id: Option<String>,
}

/// 機能別モデル（review ロール）の override を AiSettings に適用する。
/// `model_override` が Some かつ非空のときだけ実呼び出しの `model` を差し替える。
/// `prov` が provider/endpoint/variant の横断割り当てを表す（送信先プロバイダ・キー・
/// 経路を差し替える。send_chat_message と同契約: provider override 時はグローバル
/// model_api_variant を持ち込まない）。None / 空文字なら設定の既定のまま（後方互換）。
/// 既存の `args.model`（input_hash / runs.model 記録用）とは独立した解決軸。
pub fn apply_model_override(
    mut settings: AiSettings,
    model_override: Option<&str>,
    prov: &RoleProviderOverride,
) -> AiSettings {
    if let Some(m) = model_override.filter(|m| !m.is_empty()) {
        settings.model = m.to_string();
    }
    if let Some(p) = prov.provider.as_ref() {
        // provider override 時はグローバル Responses トグルを別プロバイダへ持ち込まない。
        settings.provider = p.clone();
        settings.model_api_variant = None;
    }
    if let Some(v) = prov.api_variant.as_deref().filter(|v| !v.is_empty()) {
        settings.model_api_variant = Some(v.to_string());
    }
    if let Some(eid) = prov.endpoint_id.as_deref().filter(|e| !e.is_empty()) {
        if settings.has_openai_compatible_endpoint(eid) {
            settings.active_openai_compatible_endpoint_id = Some(eid.to_string());
        }
    }
    settings
}

#[cfg(test)]
mod apply_model_override_tests {
    use super::*;
    use grimodex_ai::{AiProvider, AiSettings, OpenaiCompatibleEndpoint};

    /// "default" + "other" の 2 件を持つ openai-compatible 設定。active は "default"。
    fn settings_with_endpoints() -> AiSettings {
        AiSettings {
            provider: AiProvider::OpenaiCompatible,
            active_openai_compatible_endpoint_id: Some("default".into()),
            openai_compatible_endpoints: vec![
                OpenaiCompatibleEndpoint {
                    id: "default".into(),
                    base_url: "http://default/v1".into(),
                    ..Default::default()
                },
                OpenaiCompatibleEndpoint {
                    id: "other".into(),
                    base_url: "http://other/v1".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    // 1. all-None override + model_override=Some("m2") => model だけ "m2" に変わり、
    //    provider / model_api_variant / active endpoint は入力のまま。
    #[test]
    fn model_only_override_changes_model_field_only() {
        let mut input = settings_with_endpoints();
        input.provider = AiProvider::OpenAI;
        input.model = "m1".into();
        input.model_api_variant = Some("responses".into());

        let out = apply_model_override(input.clone(), Some("m2"), &RoleProviderOverride::default());

        assert_eq!(out.model, "m2");
        assert_eq!(out.provider, AiProvider::OpenAI);
        assert_eq!(out.model_api_variant, Some("responses".into()));
        assert_eq!(
            out.active_openai_compatible_endpoint_id,
            input.active_openai_compatible_endpoint_id
        );
    }

    // 2. model_override=None + all-None prov => 入力と byte-identical（何も変わらない）。
    #[test]
    fn all_none_override_is_byte_identical() {
        let mut input = settings_with_endpoints();
        input.provider = AiProvider::OpenAI;
        input.model = "m1".into();
        input.model_api_variant = Some("responses".into());

        let out = apply_model_override(input.clone(), None, &RoleProviderOverride::default());

        assert_eq!(out.provider, input.provider);
        assert_eq!(out.model, input.model);
        assert_eq!(out.model_api_variant, input.model_api_variant);
        assert_eq!(
            out.active_openai_compatible_endpoint_id,
            input.active_openai_compatible_endpoint_id
        );
    }

    // 3. provider override Some(P) かつ入力 model_api_variant=Some("responses")
    //    => provider==P かつ model_api_variant==None（invariant b: 別プロバイダへ
    //    グローバル Responses トグルを持ち込まない / PlaMo-404 防止）。
    #[test]
    fn provider_override_clears_model_api_variant() {
        let mut input = AiSettings {
            provider: AiProvider::OpenAI,
            ..Default::default()
        };
        input.model_api_variant = Some("responses".into());

        let prov = RoleProviderOverride {
            provider: Some(AiProvider::OpenaiCompatible),
            ..Default::default()
        };
        let out = apply_model_override(input, None, &prov);

        assert_eq!(out.provider, AiProvider::OpenaiCompatible);
        assert_eq!(out.model_api_variant, None);
    }

    // 4. provider override + api_variant=Some("v1")
    //    => model_api_variant==Some("v1")。明示 api_variant が provider clearing の
    //    後に適用される順序を保証（explicit wins）。
    #[test]
    fn explicit_api_variant_wins_after_provider_clearing() {
        let mut input = AiSettings {
            provider: AiProvider::OpenAI,
            ..Default::default()
        };
        input.model_api_variant = Some("responses".into());

        let prov = RoleProviderOverride {
            provider: Some(AiProvider::OpenaiCompatible),
            api_variant: Some("v1".into()),
            ..Default::default()
        };
        let out = apply_model_override(input, None, &prov);

        assert_eq!(out.provider, AiProvider::OpenaiCompatible);
        assert_eq!(out.model_api_variant, Some("v1".into()));
    }

    // 5. endpoint_id=Some(<known id>) かつ設定がそのエンドポイントを持つ
    //    => active_openai_compatible_endpoint_id==Some(known)（invariant c, 正常系）。
    #[test]
    fn known_endpoint_id_switches_active() {
        let input = settings_with_endpoints();
        assert_eq!(
            input.active_openai_compatible_endpoint_id,
            Some("default".into())
        );

        let prov = RoleProviderOverride {
            endpoint_id: Some("other".into()),
            ..Default::default()
        };
        let out = apply_model_override(input, None, &prov);

        assert_eq!(
            out.active_openai_compatible_endpoint_id,
            Some("other".into())
        );
    }

    // 6. endpoint_id=Some(<unknown id>)
    //    => active_openai_compatible_endpoint_id は入力のまま（invariant c, セキュリティ
    //    上重要な負例: 未知 id で別サーバへ無言リターゲットしない）。
    #[test]
    fn unknown_endpoint_id_leaves_active_unchanged() {
        let input = settings_with_endpoints();

        let prov = RoleProviderOverride {
            endpoint_id: Some("does-not-exist".into()),
            ..Default::default()
        };
        let out = apply_model_override(input, None, &prov);

        assert_eq!(
            out.active_openai_compatible_endpoint_id,
            Some("default".into())
        );
    }
}

// ---------------------------------------------------------------------------
// テキスト検索ユーティリティ
// ---------------------------------------------------------------------------

/// 空白を正規化 (連続空白→単一スペース、trim)。
fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// dedupe / dismiss_key 用の強い正規化。
/// 空白・句読点・記号を除去し ASCII 英字を小文字化する。
///
/// LLM の表現揺れを吸収するためのもの:
/// - 「朱紐は乾いていた」と「朱紐は乾いていた。」を同一視
/// - 「Sandwich」と「sandwich」を同一視
/// - 全角/半角の混在は (現状の運用では入力経路が同じため) 別途対応不要
fn strong_normalize(s: &str) -> String {
    s.chars()
        .filter(|c| !is_strippable_char(*c))
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// `strong_normalize` で除去すべき文字か判定する。
/// 空白・改行・タブ・主要な日本語/英語の句読点・括弧類を除去対象とする。
fn is_strippable_char(c: char) -> bool {
    if c.is_whitespace() {
        return true;
    }
    matches!(
        c,
        // 日本語句読点
        '。' | '、' | '．' | '，' | '・' | '：' | '；'
        | '！' | '？' | '〜' | '～' | '…' | '‥'
        // 日本語括弧
        | '「' | '」' | '『' | '』' | '（' | '）' | '【' | '】'
        | '［' | '］' | '〈' | '〉' | '《' | '》' | '〔' | '〕'
        | '｛' | '｝' | '“' | '”' | '‘' | '’'
        // 英語句読点・記号
        | '.' | ',' | ':' | ';' | '!' | '?' | '/' | '\\' | '|'
        | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | '`'
        | '-' | '_'
    )
}

/// SHA-256 ハッシュ (hex)。dismiss_key / dedupe key に使用。
fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

/// dismiss_key (consistency): hash(entry_id + "|" + strong_normalize(found_text))
///
/// `strong_normalize` ベースに変更したことで以下の表現揺れが同一視される:
/// - 句読点違い (「乾いていた」 vs 「乾いていた。」)
/// - 空白差 (連続空白・前後空白)
/// - 英字ケース差
fn dismiss_key_consistency(entry_id: &str, found_text: &str) -> String {
    sha256_hex(&format!("{}|{}", entry_id, strong_normalize(found_text)))
}

/// dismiss_key の v1.0 版 (Phase 3 より前): hash(entry_id + "|" + normalize_ws(found_text))
///
/// `is_annotation_previously_closed` の dual-lookup 専用。既存 DB の manual
/// dismiss はこの v1.0 key で保存されているため、後方互換を取るためだけに残す。
/// 新規 annotation の保存には `dismiss_key_consistency` のみを使う。
fn dismiss_key_consistency_legacy(entry_id: &str, found_text: &str) -> String {
    sha256_hex(&format!("{}|{}", entry_id, normalize_ws(found_text)))
}

/// dismiss_key (intra_scene): hash(scene_id + "|" + sorted found_texts joined)
fn dismiss_key_intra(scene_id: &str, a_text: &str, b_text: &str) -> String {
    let mut texts = [strong_normalize(a_text), strong_normalize(b_text)];
    texts.sort();
    sha256_hex(&format!("{}|{}|{}", scene_id, texts[0], texts[1]))
}

/// intra_scene 版 legacy key (Phase 3 より前)。理由は consistency 版と同じ。
fn dismiss_key_intra_legacy(scene_id: &str, a_text: &str, b_text: &str) -> String {
    let mut texts = [normalize_ws(a_text), normalize_ws(b_text)];
    texts.sort();
    sha256_hex(&format!("{}|{}|{}", scene_id, texts[0], texts[1]))
}

/// dismiss_key (typo_detection): hash(scene_id + "|" + strong_normalize(found_text) + "|" + strong_normalize(suggestion))
///
/// suggestion をキーに含めるのは、同じ found_text でも提案語が違えば別判断
/// として扱う方が自然なため (ユーザーが「以外→意外」を却下しても「以外→
/// 異界」が来るシナリオは別 dismiss にする)。
fn dismiss_key_typo(scene_id: &str, found_text: &str, suggestion: &str) -> String {
    sha256_hex(&format!(
        "{}|{}|{}",
        scene_id,
        strong_normalize(found_text),
        strong_normalize(suggestion)
    ))
}

/// dismiss_key (review): hash(scene_id + "|" + strong_normalize(title) + "|" + strong_normalize(found_text))
///
/// review は span 指摘 (found_text あり) と scene 全体所見 (found_text 空) の
/// 両方があるため、title も key に含めて同一シーン内の別所見を区別する。
fn dismiss_key_review(scene_id: &str, title: &str, found_text: &str) -> String {
    sha256_hex(&format!(
        "{}|{}|{}",
        scene_id,
        strong_normalize(title),
        strong_normalize(found_text)
    ))
}

/// dismiss_key (intent_drift): same shape as review (title + found_text per scene).
fn dismiss_key_intent_drift(scene_id: &str, title: &str, found_text: &str) -> String {
    sha256_hex(&format!(
        "{}|{}|{}",
        scene_id,
        strong_normalize(title),
        strong_normalize(found_text)
    ))
}

/// dismiss_key (timeline_consistency): same shape as review/intent (title + found_text per scene).
fn dismiss_key_timeline(scene_id: &str, title: &str, found_text: &str) -> String {
    sha256_hex(&format!(
        "{}|{}|{}",
        scene_id,
        strong_normalize(title),
        strong_normalize(found_text)
    ))
}

/// dismiss_key (impact_review): hash(scene_id + "|" + change_id + "|" + strong_normalize(found_text))
///
/// change_id を key に含めるのは意図的: 同じ found_text でも別の変更
/// (例「年齢 15→17」と「年齢 17→14」) に起因する矛盾は別判断として扱うため。
/// ユーザーがある変更について却下しても、別の変更による矛盾は再検出させる。
fn dismiss_key_impact_review(scene_id: &str, change_id: &str, found_text: &str) -> String {
    sha256_hex(&format!(
        "{}|{}|{}",
        strong_normalize(scene_id),
        strong_normalize(change_id),
        strong_normalize(found_text)
    ))
}

/// violation の `entry_id` が Codex payload の有効 id 集合に含まれるか判定する。
///
/// 空文字 or 未知 id は false を返す。LLM が hallucinate した entry_id を
/// 検出して捨てるための判定（呼び出し側で warn ログを出す）。
fn violation_has_valid_entry_id(v: &Value, valid_ids: &HashMap<String, String>) -> bool {
    v["entry_id"]
        .as_str()
        .map(|id| !id.is_empty() && valid_ids.contains_key(id))
        .unwrap_or(false)
}

/// violation の `detail_name` が対象 entry の detail_values の name に
/// 実在するか判定する。
///
/// LLM プロンプト v1.1 から、detail_name は Codex payload の
/// `detail_values[].name` から正確に引いてくるよう要求している。
/// LLM が hallucinate した name (例: 存在しない detail 名や hyphen 違い) は
/// false を返す。呼び出し側で None に丸める。
fn detail_name_is_valid(
    entry_id: &str,
    detail_name: &str,
    detail_names_by_entry: &HashMap<String, std::collections::HashSet<String>>,
) -> bool {
    if detail_name.is_empty() {
        return false;
    }
    detail_names_by_entry
        .get(entry_id)
        .map(|names| names.contains(detail_name))
        .unwrap_or(false)
}

/// `parsed` のルートが Object で、`key` が Array であることを検証して返す。
///
/// LLM が以下のような構造ズレを起こした場合、従来は `.as_array().unwrap_or_default()`
/// で silent に 0 件処理されていたが、本関数は明示的に `anyhow::Err` を返して
/// run を `failed` に落とす。これにより silent fail を撲滅する。
///
/// 検出する異常パターン:
/// - ルートが Array（`[{...}]` 形式で返す LLM）
/// - キー名揺れ（`violations` を期待しているのに `issues` / `results` 等で返す）
/// - キーが配列でない（オブジェクトや文字列で返す）
///
/// 例外: ルートが空オブジェクト `{}` の場合は「該当なし」として空配列を返す。
/// 弱いローカル LLM (gemma 等) が空配列指示を無視して `{}` だけを返す定型で、
/// 他キーが存在しない以上キー揺れの証拠もないため、失敗扱いにしない。
fn extract_array_field(parsed: &Value, key: &str) -> anyhow::Result<Vec<Value>> {
    if !parsed.is_object() {
        anyhow::bail!(
            "LLM 出力のルートが Object ではありません (root={})",
            value_type_name(parsed)
        );
    }
    // 空オブジェクト `{}` は弱いローカル LLM の「該当なし」の定型 (raw_bytes=2)。
    // キー揺れ (他のキーで返す) とは別物なので、空配列として受理する。
    if parsed.as_object().is_some_and(|m| m.is_empty()) {
        return Ok(Vec::new());
    }
    let field = &parsed[key];
    if field.is_null() {
        // 期待キーが存在しない。キー揺れの典型ケース。
        let other_keys: Vec<&str> = parsed
            .as_object()
            .map(|m| m.keys().map(|k| k.as_str()).collect())
            .unwrap_or_default();
        anyhow::bail!(
            "LLM 出力に期待キー '{key}' がありません (実在キー: {:?})",
            other_keys
        );
    }
    field.as_array().cloned().ok_or_else(|| {
        anyhow::anyhow!(
            "LLM 出力の '{key}' が Array ではありません (type={})",
            value_type_name(field)
        )
    })
}

/// `serde_json::Value` のバリアント名を返す（エラーメッセージ用）。
fn value_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// LLM が返す JSON を取り出す。
/// 0) 冒頭の `<think>...</think>`（ローカル reasoning モデルの思考出力）を除去
/// 1) ```json ... ``` / ``` ... ``` で囲まれた最初のブロックを優先
/// 2) なければ最初の `{` から最後の `}` までを返す（前置き文対策）
/// 3) どちらでもなければ trim 済み全文を返す
pub fn extract_json(raw: &str) -> &str {
    let trimmed = raw.trim();

    // 0) reasoning モデル (deepseek-r1 / qwen3 等) は /v1 互換経路で
    //    <think>...</think> を本文に前置する。think 内の `{` や ``` が
    //    下の切り出しを誤爆させるため、冒頭ブロックに限って捨てる。
    let trimmed = match trimmed.strip_prefix("<think>") {
        Some(rest) => match rest.find("</think>") {
            Some(end) => rest[end + "</think>".len()..].trim(),
            None => trimmed,
        },
        None => trimmed,
    };

    // 1) コードフェンスを探す（prefix 限定ではなくどこにあっても拾う）
    if let Some(fence_start) = trimmed.find("```") {
        let after_fence = &trimmed[fence_start + 3..];
        let body = after_fence.strip_prefix("json").unwrap_or(after_fence);
        // 言語タグの直後の改行を飛ばす
        let body = body.trim_start_matches(['\n', '\r', ' ']);
        if let Some(end) = body.find("```") {
            return body[..end].trim();
        }
        // 閉じフェンスがない場合は body 末尾までを使う
        return body.trim();
    }

    // 2) 前置き文 + 生 JSON のパターン: 最初の `{` 〜 最後の `}` を切り出す
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if start < end {
            return trimmed[start..=end].trim();
        }
    }

    trimmed
}

/// LLM 応答を JSON として解釈する（`extract_json` の解析側）。
/// ローカル LLM は外側の `{}` を省いた `"findings": [...]` を返すことがあり、
/// その場合 `trailing characters` で素の parse が失敗する。失敗時は
/// 「抽出結果」「trim 済み全文」をそれぞれ `{}` で包んで一度だけ再試行し、
/// どれも通らなければ元のエラーを返す。
///
/// 注意: 空文字の候補は `{}` に包まない。空応答（プロバイダが content="" を
/// 返す / `<think>...</think>` のみで本文が無い）を `{}` に「救済」すると、
/// extract_array_field の空オブジェクト受理と連鎖して「指摘0件」の無音成功に
/// 化ける。空応答はパース失敗＝シーン失敗に落とすのが正しい。
fn parse_llm_json(raw: &str) -> Result<Value, serde_json::Error> {
    let json_str = extract_json(raw);
    match serde_json::from_str(json_str) {
        Ok(v) => Ok(v),
        Err(e) => {
            for candidate in [json_str, raw.trim()] {
                if candidate.trim().is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(&format!("{{{candidate}}}")) {
                    return Ok(v);
                }
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod extract_json_tests {
    use super::{extract_json, parse_llm_json};

    #[test]
    fn handles_raw_json() {
        assert_eq!(extract_json("{\"violations\":[]}"), "{\"violations\":[]}");
    }

    #[test]
    fn handles_fenced_json_prefix() {
        let raw = "```json\n{\"violations\":[]}\n```";
        assert_eq!(extract_json(raw), "{\"violations\":[]}");
    }

    #[test]
    fn handles_fenced_json_with_preamble() {
        let raw = "Here is the result:\n\n```json\n{\"violations\":[1]}\n```\n";
        assert_eq!(extract_json(raw), "{\"violations\":[1]}");
    }

    #[test]
    fn handles_raw_json_with_preamble() {
        let raw = "The scene describes...\n\n{\"violations\":[]}";
        assert_eq!(extract_json(raw), "{\"violations\":[]}");
    }

    #[test]
    fn handles_fence_without_language_tag() {
        let raw = "```\n{\"a\":1}\n```";
        assert_eq!(extract_json(raw), "{\"a\":1}");
    }

    #[test]
    fn strips_leading_think_block() {
        // think 内の `{}` や ``` に釣られず本体の JSON を取り出す
        let raw = "<think>例えば {\"x\":1} のような…</think>\n{\"findings\":[]}";
        assert_eq!(extract_json(raw), "{\"findings\":[]}");
    }

    #[test]
    fn keeps_text_when_think_block_unclosed() {
        let raw = "<think>途中で切れた {\"findings\":[]}";
        assert_eq!(extract_json(raw), "{\"findings\":[]}");
    }

    // --- parse_llm_json: 外側 {} 省略の救済 ---

    #[test]
    fn parse_recovers_braceless_empty_array() {
        // 実報告: `trailing characters at line 1 column 11`
        // (= `"findings"` 直後の `:` で失敗するパターン)
        let v = parse_llm_json("\"findings\": []").unwrap();
        assert!(v["findings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn parse_recovers_braceless_with_objects() {
        // 内側に `{}` があると extract_json の brace 切り出しが誤爆するため
        // 全文 wrap 側でしか救済できないケース
        let raw = "\"findings\": [{\"title\":\"a\"},{\"title\":\"b\"}]";
        let v = parse_llm_json(raw).unwrap();
        assert_eq!(v["findings"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn parse_recovers_fenced_braceless() {
        let raw = "```json\n\"findings\": [{\"title\":\"a\"}]\n```";
        let v = parse_llm_json(raw).unwrap();
        assert_eq!(v["findings"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn parse_passes_through_well_formed() {
        let v = parse_llm_json("{\"violations\":[]}").unwrap();
        assert!(v["violations"].as_array().unwrap().is_empty());
    }

    #[test]
    fn parse_still_fails_on_prose() {
        assert!(parse_llm_json("シーンは全体的に良好です。").is_err());
    }

    // --- 空応答は救済しない (無音成功 regression gate) ---

    #[test]
    fn parse_fails_on_empty_response() {
        // プロバイダが content="" を返すケース (reasoning が別フィールドに
        // 吐かれて本文が空になる等)。"" を {} に包んで救済すると
        // extract_array_field の {} 受理と連鎖して「指摘0件」に化けるため、
        // 必ずパース失敗にする。
        assert!(parse_llm_json("").is_err());
        assert!(parse_llm_json("   \n ").is_err());
    }

    #[test]
    fn parse_fails_on_think_only_response() {
        // <think>...</think> だけで本文が無い応答も同様に失敗させる。
        assert!(parse_llm_json("<think>考えたが出力なし</think>").is_err());
    }

    #[test]
    fn parse_accepts_literal_empty_object() {
        // gemma 等が「該当なし」として返す生の {} (raw_bytes=2) は
        // 素の parse で通る (救済ではない) — こちらは受理を維持する。
        let v = parse_llm_json("{}").unwrap();
        assert!(v.as_object().unwrap().is_empty());
    }
}

#[cfg(test)]
mod extract_array_field_tests {
    use super::extract_array_field;
    use serde_json::json;

    #[test]
    fn returns_array_when_well_formed() {
        let v = json!({ "violations": [{"a": 1}, {"a": 2}] });
        let result = extract_array_field(&v, "violations").unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn empty_array_is_ok() {
        let v = json!({ "violations": [] });
        let result = extract_array_field(&v, "violations").unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn errors_when_root_is_array() {
        // `[{...}]` のように配列ルートで返す LLM 対策
        let v = json!([{"a": 1}]);
        let err = extract_array_field(&v, "violations").unwrap_err();
        assert!(
            err.to_string().contains("ルートが Object ではありません"),
            "got: {err}"
        );
    }

    #[test]
    fn errors_when_key_missing() {
        // `violations` を `issues` と返すケース
        let v = json!({ "issues": [{"a": 1}] });
        let err = extract_array_field(&v, "violations").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("期待キー 'violations'"), "got: {msg}");
        assert!(msg.contains("issues"), "got: {msg}");
    }

    #[test]
    fn empty_object_means_no_findings() {
        // 弱いローカル LLM (gemma 等) は「該当なし」を `{}` (raw_bytes=2) で
        // 返すことがある。キー揺れと違い他キーが無い = 出力構造の取り違えでは
        // ないので、空配列として扱う (scene 失敗 → run 全体失敗にしない)。
        let v = json!({});
        let result = extract_array_field(&v, "issues").unwrap();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn errors_when_field_is_null_explicitly() {
        // `{"issues": null}` は空オブジェクトではなく明示 null — 構造ズレとして
        // 引き続きエラー (silent fail 撲滅の従来方針を維持)。
        let v = json!({ "issues": null });
        let err = extract_array_field(&v, "issues").unwrap_err();
        assert!(err.to_string().contains("期待キー"), "got: {err}");
    }

    #[test]
    fn errors_when_field_is_object() {
        // 配列ではなく単一オブジェクトで返すケース
        let v = json!({ "violations": {"a": 1} });
        let err = extract_array_field(&v, "violations").unwrap_err();
        assert!(
            err.to_string().contains("Array ではありません"),
            "got: {err}"
        );
    }

    #[test]
    fn errors_when_field_is_string() {
        let v = json!({ "violations": "なし" });
        let err = extract_array_field(&v, "violations").unwrap_err();
        assert!(
            err.to_string().contains("Array ではありません"),
            "got: {err}"
        );
    }

    #[test]
    fn errors_when_root_is_string() {
        let v = json!("violations: none");
        let err = extract_array_field(&v, "violations").unwrap_err();
        assert!(
            err.to_string().contains("ルートが Object ではありません"),
            "got: {err}"
        );
    }
}

#[cfg(test)]
mod violation_has_valid_entry_id_tests {
    use super::violation_has_valid_entry_id;
    use serde_json::json;
    use std::collections::HashMap;

    fn map(ids: &[(&str, &str)]) -> HashMap<String, String> {
        ids.iter()
            .map(|(id, name)| (id.to_string(), name.to_string()))
            .collect()
    }

    #[test]
    fn accepts_known_entry_id() {
        let v = json!({ "entry_id": "abc-1" });
        let m = map(&[("abc-1", "朱紐")]);
        assert!(violation_has_valid_entry_id(&v, &m));
    }

    #[test]
    fn rejects_unknown_entry_id() {
        // LLM が架空の UUID を返したケース
        let v = json!({ "entry_id": "ghost-uuid" });
        let m = map(&[("abc-1", "朱紐")]);
        assert!(!violation_has_valid_entry_id(&v, &m));
    }

    #[test]
    fn rejects_empty_string() {
        let v = json!({ "entry_id": "" });
        let m = map(&[("abc-1", "朱紐")]);
        assert!(!violation_has_valid_entry_id(&v, &m));
    }

    #[test]
    fn rejects_null() {
        let v = json!({ "entry_id": null });
        let m = map(&[("abc-1", "朱紐")]);
        assert!(!violation_has_valid_entry_id(&v, &m));
    }

    #[test]
    fn rejects_missing_field() {
        let v = json!({ "found_text": "..." });
        let m = map(&[("abc-1", "朱紐")]);
        assert!(!violation_has_valid_entry_id(&v, &m));
    }

    #[test]
    fn rejects_non_string_value() {
        // LLM が数値や object で entry_id を返す異常パターン
        let v = json!({ "entry_id": 42 });
        let m = map(&[("abc-1", "朱紐")]);
        assert!(!violation_has_valid_entry_id(&v, &m));
    }

    #[test]
    fn empty_codex_payload_rejects_all() {
        // Codex 不在の scene (mention なし) で LLM が違反を返した場合は全部捨てる
        let v = json!({ "entry_id": "abc-1" });
        let m = map(&[]);
        assert!(!violation_has_valid_entry_id(&v, &m));
    }
}

#[cfg(test)]
mod dismiss_key_review_tests {
    use super::dismiss_key_review;

    #[test]
    fn stable_for_same_inputs() {
        let a = dismiss_key_review("scene-1", "中盤が冗長", "そして彼は");
        let b = dismiss_key_review("scene-1", "中盤が冗長", "そして彼は");
        assert_eq!(a, b);
    }

    #[test]
    fn differs_by_title_and_found_text() {
        let base = dismiss_key_review("scene-1", "中盤が冗長", "そして彼は");
        assert_ne!(
            base,
            dismiss_key_review("scene-1", "別の所見", "そして彼は")
        );
        assert_ne!(
            base,
            dismiss_key_review("scene-1", "中盤が冗長", "別の本文")
        );
        assert_ne!(
            base,
            dismiss_key_review("scene-2", "中盤が冗長", "そして彼は")
        );
    }

    #[test]
    fn normalizes_punctuation_and_space() {
        // strong_normalize により句読点・空白差は同一視される
        let a = dismiss_key_review("s", "所見", "そして彼は");
        let b = dismiss_key_review("s", "所見", " そして彼は。");
        assert_eq!(a, b);
    }
}

#[cfg(test)]
mod detail_name_is_valid_tests {
    use super::detail_name_is_valid;
    use std::collections::{HashMap, HashSet};

    fn build(entry_id: &str, names: &[&str]) -> HashMap<String, HashSet<String>> {
        let mut m = HashMap::new();
        m.insert(
            entry_id.to_string(),
            names.iter().map(|s| s.to_string()).collect(),
        );
        m
    }

    #[test]
    fn accepts_known_detail_name() {
        let m = build("entry-1", &["温度", "材質"]);
        assert!(detail_name_is_valid("entry-1", "温度", &m));
        assert!(detail_name_is_valid("entry-1", "材質", &m));
    }

    #[test]
    fn rejects_unknown_detail_name() {
        // LLM が架空の detail 名を返したケース
        let m = build("entry-1", &["温度", "材質"]);
        assert!(!detail_name_is_valid("entry-1", "色", &m));
    }

    #[test]
    fn rejects_empty_string() {
        let m = build("entry-1", &["温度"]);
        assert!(!detail_name_is_valid("entry-1", "", &m));
    }

    #[test]
    fn rejects_unknown_entry_id() {
        // entry_id 自体が不在ならどんな detail_name でも false
        let m = build("entry-1", &["温度"]);
        assert!(!detail_name_is_valid("ghost-entry", "温度", &m));
    }

    #[test]
    fn rejects_when_entry_has_no_details() {
        // entry に detail_values が無い場合（HashSet 空）
        let m = build("entry-1", &[]);
        assert!(!detail_name_is_valid("entry-1", "温度", &m));
    }

    #[test]
    fn case_and_punctuation_strict() {
        // 完全一致を要求する (NFKC や trim は意図的に入れない)
        // LLM が変な揺らぎを出したら hallucination 扱い
        let m = build("entry-1", &["温度"]);
        assert!(!detail_name_is_valid("entry-1", "温度 ", &m));
        assert!(!detail_name_is_valid("entry-1", "おんど", &m));
    }
}

#[cfg(test)]
mod find_text_position_tests {
    // 既存テストは空白正規化の完全一致経路を検証する。
    use super::find_text_position_exact as find_text_position;

    /// 日本語シーン中で found_text を発見できる
    #[test]
    fn locates_japanese_found_text_in_scene() {
        let scene = "茶碗が並んでいた。湯気はまだ立っていた。誰かがついさっきまでここで茶を飲んでいた。円明は息を殺して耳を澄ませた。";
        let found_text = "円明は息を殺して耳を澄ませた";
        let context = "ここで茶を飲んでいた。円明は息を殺して耳を澄ませた。";
        let pos = find_text_position(scene, found_text, context);
        assert!(pos.is_some(), "日本語 found_text を発見できるべき");
    }

    /// マルチバイト境界でも panic しない（リグレッション防止）
    #[test]
    fn does_not_panic_on_utf8_boundary() {
        let scene = "あいうえおかきくけこさしすせそたちつてとなにぬねの";
        // context の前後 50 バイトが char 境界を割る位置に来るケース
        let context = "けこさしす";
        let found_text = "けこ";
        let _ = find_text_position(scene, found_text, context);
    }

    /// 同じ found_text が複数箇所にあるとき、context に最も近い位置を選ぶ (B4)
    #[test]
    fn picks_best_position_among_multiple_occurrences() {
        // 「金色の髪」が 2 箇所。context は 2 箇所目の周辺を指している。
        let scene =
            "ある日、金色の髪の女性が現れた。それからしばらくして、舞台では金色の髪の歌手が歌っていた。";
        let found_text = "金色の髪";
        let context = "舞台では金色の髪の歌手";
        let pos = find_text_position(scene, found_text, context).expect("should find");
        // 2 箇所目の出現位置は context を完全包含するのでこちらが選ばれる
        let expected_start = scene.find("舞台では金色の髪").unwrap() + "舞台では".len();
        assert_eq!(pos.0, expected_start, "context が示す方の出現を選ぶべき");
    }

    /// found_text が見つからなければ None
    #[test]
    fn returns_none_when_text_not_found() {
        let scene = "今日は良い天気だ。";
        assert!(find_text_position(scene, "雪が降る", "").is_none());
    }

    /// context が空でも単一出現なら見つけられる
    #[test]
    fn handles_empty_context() {
        let scene = "今日は良い天気だ。";
        let pos = find_text_position(scene, "良い天気", "").expect("should find");
        assert_eq!(&scene[pos.0..pos.1], "良い天気");
    }
}

#[cfg(test)]
mod find_text_position_morph_tests {
    use super::find_text_position;

    /// 活用差: LLM が原形「走る」を返しても本文の「走った」にアンカーできる。
    /// 完全一致経路 (find_text_position_exact) では当たらないことも併せて確認する。
    #[test]
    fn resolves_inflected_verb_via_lemma() {
        let scene = "彼は走った。";
        // 完全一致経路では活用差で当たらない (= 従来は orphaned だった)
        assert!(
            super::find_text_position_exact(scene, "彼は走る", "").is_none(),
            "完全一致経路では活用差を吸収できないはず"
        );
        // 日本語なら形態素 lemma 照合で当たる
        let hit = find_text_position(scene, "彼は走る", "", true)
            .expect("形態素照合で活用差を吸収して当てるべき");
        // surface は本文に verbatim で存在する (FE が indexOf 再アンカーできる不変条件)
        assert!(
            scene.contains(&hit.surface),
            "surface は本文に存在する文字列であるべき: {:?}",
            hit.surface
        );
        assert!(
            hit.surface.contains('走'),
            "一致範囲は対象の動詞を含むべき: {:?}",
            hit.surface
        );
        // start/end は surface と整合する
        assert_eq!(&scene[hit.start..hit.end], hit.surface);
    }

    /// 非日本語 (is_japanese=false) では形態素フォールバックを行わない。
    /// 活用差は吸収されず None になる (英語プロジェクトの従来挙動を保つ)。
    #[test]
    fn does_not_use_morph_fallback_for_non_japanese() {
        let scene = "彼は走った。";
        assert!(
            find_text_position(scene, "彼は走る", "", false).is_none(),
            "非日本語では形態素フォールバックしないので None のはず"
        );
    }

    /// 完全一致するものは従来どおり exact 経路で当たり、surface は found_text のまま。
    #[test]
    fn exact_match_keeps_found_text_surface() {
        let scene = "今日は良い天気だ。";
        let hit = find_text_position(scene, "良い天気", "", true).expect("should find");
        assert_eq!(hit.surface, "良い天気");
        assert_eq!(&scene[hit.start..hit.end], "良い天気");
    }

    /// 本文に存在しない指摘は日本語でも None (orphaned)。
    #[test]
    fn returns_none_when_absent_even_in_japanese() {
        let scene = "今日は良い天気だ。";
        assert!(find_text_position(scene, "吹雪が荒れ狂う", "", true).is_none());
    }

    /// exact 経路は改行(=normalize_ws で潰れる空白)を跨いでも **生 scene_text の
    /// バイトオフセット** を返し、surface を生本文からスライスできる(座標系統一)。
    #[test]
    fn exact_returns_raw_offsets_across_newline() {
        let scene = "第一段落。\n第二段落で円明が現れた。";
        let hit = find_text_position(scene, "円明が現れた", "", true).expect("should find");
        // raw オフセットなので生本文スライスが一致する(normalized 座標だと崩れる)
        assert_eq!(&scene[hit.start..hit.end], "円明が現れた");
        assert_eq!(hit.surface, "円明が現れた");
    }

    /// 同一表現が複数あるとき、morph 経路も found_context で正しい出現を選ぶ。
    #[test]
    fn morph_uses_context_to_disambiguate() {
        // 「走った」が 2 箇所。found_text は原形「走る」(活用差で exact は外れる)。
        let scene = "朝、彼は走った。夜、彼女は走った。";
        assert!(
            super::find_text_position_exact(scene, "走る", "").is_none(),
            "exact は活用差で当たらない前提"
        );
        let hit =
            find_text_position(scene, "走る", "彼女は走った", true).expect("morph should find");
        // context が 2 箇所目(夜のほう)を指すので、そちらにアンカーするべき
        let yoru = scene.find('夜').expect("夜 exists");
        assert!(
            hit.start >= yoru,
            "context が示す 2 箇所目を選ぶべき: start={} yoru={}",
            hit.start,
            yoru
        );
        assert!(scene.contains(&hit.surface));
    }
}

#[cfg(test)]
mod strong_normalize_tests {
    use super::strong_normalize;

    #[test]
    fn strips_japanese_punctuation() {
        assert_eq!(strong_normalize("朱紐は乾いていた。"), "朱紐は乾いていた");
        assert_eq!(strong_normalize("「朱紐」"), "朱紐");
        assert_eq!(strong_normalize("乾いていた、冷たく。"), "乾いていた冷たく");
    }

    #[test]
    fn strips_english_punctuation_and_lowercases() {
        assert_eq!(strong_normalize("Hello, World!"), "helloworld");
        assert_eq!(strong_normalize("It's a test."), "itsatest");
    }

    #[test]
    fn strips_whitespace() {
        assert_eq!(strong_normalize("  ab  c "), "abc");
        assert_eq!(strong_normalize("ab\nc\td"), "abcd");
        assert_eq!(strong_normalize("全角\u{3000}スペース"), "全角スペース");
    }

    #[test]
    fn idempotent() {
        let s = "朱紐は乾いていた。";
        let once = strong_normalize(s);
        let twice = strong_normalize(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn same_intent_different_punctuation_match() {
        // dedup の主目的 — 句点ありなしを同一視
        assert_eq!(
            strong_normalize("朱紐は乾いていた。"),
            strong_normalize("朱紐は乾いていた")
        );
        assert_eq!(
            strong_normalize("「朱紐は乾いていた。」"),
            strong_normalize("朱紐は乾いていた")
        );
    }
}

#[cfg(test)]
mod merge_confidence_tests {
    use super::merge_confidence;

    #[test]
    fn high_wins_over_medium() {
        assert_eq!(merge_confidence("high", "medium"), "high");
        assert_eq!(merge_confidence("medium", "high"), "high");
    }

    #[test]
    fn medium_wins_over_low() {
        assert_eq!(merge_confidence("medium", "low"), "medium");
        assert_eq!(merge_confidence("low", "medium"), "medium");
    }

    #[test]
    fn high_wins_over_low() {
        assert_eq!(merge_confidence("high", "low"), "high");
        assert_eq!(merge_confidence("low", "high"), "high");
    }

    #[test]
    fn same_returns_old() {
        // 同じランクなら old を保つ (createdAt 時刻保護)
        assert_eq!(merge_confidence("high", "high"), "high");
        assert_eq!(merge_confidence("medium", "medium"), "medium");
    }

    #[test]
    fn unknown_treated_as_medium() {
        assert_eq!(merge_confidence("garbage", "high"), "high");
        assert_eq!(merge_confidence("garbage", "low"), "garbage");
    }
}

#[cfg(test)]
mod dismiss_key_legacy_tests {
    use super::{
        dismiss_key_consistency, dismiss_key_consistency_legacy, dismiss_key_intra,
        dismiss_key_intra_legacy,
    };

    /// 句読点付き found_text に対して legacy (normalize_ws) と新版
    /// (strong_normalize) の hash が異なることを確認する。
    /// この差異こそが既存 manual dismiss が無効化される regression の根源。
    /// `is_annotation_previously_closed` の dual-lookup で両方を照会してカバーする。
    #[test]
    fn new_and_legacy_differ_when_punctuation_present() {
        let entry = "entry-1";
        let text = "朱紐は乾いていた。";
        assert_ne!(
            dismiss_key_consistency(entry, text),
            dismiss_key_consistency_legacy(entry, text),
            "句読点ありなら新旧 key は別物 (= regression が成立する状況)"
        );
    }

    /// 句読点が無い found_text なら新旧で一致する (空白正規化のみ違うので)。
    #[test]
    fn new_and_legacy_agree_when_no_punctuation() {
        let entry = "entry-1";
        let text = "朱紐は乾いていた";
        assert_eq!(
            dismiss_key_consistency(entry, text),
            dismiss_key_consistency_legacy(entry, text),
            "句読点なしなら新旧 key は同じ"
        );
    }

    /// legacy 関数は決定論的 (同じ入力で同じ出力)
    #[test]
    fn legacy_is_deterministic() {
        let entry = "entry-1";
        let text = "テキスト";
        assert_eq!(
            dismiss_key_consistency_legacy(entry, text),
            dismiss_key_consistency_legacy(entry, text)
        );
    }

    /// intra_scene 版も同様に新旧で違うことを確認
    #[test]
    fn intra_new_and_legacy_differ_with_punctuation() {
        let scene = "scene-1";
        let a = "前は乾いていた。";
        let b = "後は濡れていた、";
        assert_ne!(
            dismiss_key_intra(scene, a, b),
            dismiss_key_intra_legacy(scene, a, b)
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod is_annotation_previously_closed_tests {
    use super::{has_open_annotation_with_key, is_annotation_previously_closed};
    use rusqlite::{params, Connection};

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE post_effect_annotations (
                id          TEXT PRIMARY KEY,
                project_id  TEXT,
                run_id      TEXT,
                anchor_type TEXT,
                scene_id    TEXT,
                range_start INTEGER,
                range_end   INTEGER,
                text_snapshot TEXT,
                category    TEXT NOT NULL,
                persona     TEXT,
                severity    TEXT,
                content     TEXT,
                author_role TEXT,
                parent_id   TEXT,
                status      TEXT NOT NULL,
                metadata    TEXT NOT NULL DEFAULT '{}',
                created_at  TEXT,
                updated_at  TEXT
            );",
        )
        .unwrap();
        conn
    }

    // 全行を project_id = 'P1' で投入する (is_annotation_previously_closed は
    // project スコープで照会するため、テストも一致する project_id を渡す)。
    fn insert(conn: &Connection, id: &str, status: &str, category: &str, metadata: &str) {
        conn.execute(
            "INSERT INTO post_effect_annotations
                (id, project_id, category, status, metadata, content, author_role)
             VALUES (?, 'P1', ?, ?, ?, '', 'ai')",
            params![id, category, status, metadata],
        )
        .unwrap();
    }

    // ---- typo ----

    #[test]
    fn typo_matches_dismissed_top_level_key() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "dismissed",
            "typo_anchor",
            r#"{"dismiss_key":"K1"}"#,
        );
        assert!(is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
        assert!(!is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &["other"]
        ));
    }

    #[test]
    fn typo_matches_resolved_top_level_key() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "resolved",
            "typo_anchor",
            r#"{"dismiss_key":"K1"}"#,
        );
        assert!(is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
    }

    // ---- has_open_annotation_with_key (再実行時の open 重複ガード) ----

    #[test]
    fn open_guard_matches_open_only() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "open",
            "typo_anchor",
            r#"{"dismiss_key":"K1"}"#,
        );
        // open 行は open ガードにだけヒットし、closed 判定にはヒットしない
        assert!(has_open_annotation_with_key(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
        assert!(!is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
    }

    #[test]
    fn open_guard_ignores_closed_and_other_project() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "dismissed",
            "typo_anchor",
            r#"{"dismiss_key":"K1"}"#,
        );
        assert!(!has_open_annotation_with_key(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
        // project スコープ外は不可視
        insert(
            &conn,
            "a2",
            "open",
            "typo_anchor",
            r#"{"dismiss_key":"K2"}"#,
        );
        assert!(!has_open_annotation_with_key(
            &conn,
            "P9",
            "typo_anchor",
            &["K2"]
        ));
    }

    #[test]
    fn open_guard_matches_nested_legacy_keys() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "open",
            "consistency_anchor",
            r#"{"codex_ref":{"dismiss_key":"KC"}}"#,
        );
        assert!(has_open_annotation_with_key(
            &conn,
            "P1",
            "consistency_anchor",
            &["KC"]
        ));
    }

    #[test]
    fn typo_matches_legacy_nested_key_in_typo_ref() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "dismissed",
            "typo_anchor",
            r#"{"typo_ref":{"dismiss_key":"K1"}}"#,
        );
        assert!(is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
    }

    #[test]
    fn typo_ignores_open() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "open",
            "typo_anchor",
            r#"{"dismiss_key":"K1"}"#,
        );
        assert!(!is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
    }

    // ---- consistency (legacy: dismiss_key nested in codex_ref) ----

    #[test]
    fn consistency_matches_legacy_nested_key_in_codex_ref() {
        let conn = open_db();
        // 既存 DB の consistency annotation は dismiss_key が codex_ref 内のみに保存されていた
        insert(
            &conn,
            "a1",
            "dismissed",
            "consistency_anchor",
            r#"{"codex_ref":{"dismiss_key":"K1","entry_id":"e"}}"#,
        );
        assert!(is_annotation_previously_closed(
            &conn,
            "P1",
            "consistency_anchor",
            &["K1"]
        ));
    }

    #[test]
    fn consistency_matches_resolved_with_nested_key() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "resolved",
            "consistency_anchor",
            r#"{"codex_ref":{"dismiss_key":"K1","entry_id":"e"}}"#,
        );
        assert!(is_annotation_previously_closed(
            &conn,
            "P1",
            "consistency_anchor",
            &["K1"]
        ));
    }

    // ---- intra (dismiss_key top-level, category="consistency_anchor") ----

    #[test]
    fn intra_matches_resolved_top_level_key() {
        let conn = open_db();
        // resolved は dismiss_source を立てないので旧 is_manually_dismissed では拾えなかった
        insert(
            &conn,
            "a1",
            "resolved",
            "consistency_anchor",
            r#"{"dismiss_key":"K1","found_text":"x"}"#,
        );
        assert!(is_annotation_previously_closed(
            &conn,
            "P1",
            "consistency_anchor",
            &["K1"]
        ));
    }

    // ---- category isolation ----

    #[test]
    fn category_isolation_typo_vs_consistency() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "dismissed",
            "consistency_anchor",
            r#"{"dismiss_key":"K1"}"#,
        );
        // category 不一致なら hit しない
        assert!(!is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &["K1"]
        ));
    }

    // ---- legacy/new dual key lookup ----

    #[test]
    fn matches_any_key_in_list() {
        let conn = open_db();
        insert(
            &conn,
            "a1",
            "dismissed",
            "consistency_anchor",
            r#"{"dismiss_key":"NEW1"}"#,
        );
        // 1 番目 (legacy) は外れだが 2 番目 (new) で hit
        assert!(is_annotation_previously_closed(
            &conn,
            "P1",
            "consistency_anchor",
            &["LEGACY1", "NEW1"]
        ));
    }

    #[test]
    fn empty_keys_returns_false() {
        let conn = open_db();
        assert!(!is_annotation_previously_closed(
            &conn,
            "P1",
            "typo_anchor",
            &[]
        ));
    }
}

// reply_to_annotation_tests は grimodex-db (post_effect::reply_to_annotation_tests)
// に移動済み (実装本体 reply_to_annotation_inner / ReplyToAnnotationArgs と同居)。
/// `idx` を直下の char 境界に丸める（`is_char_boundary` が安定 API なので自前実装）。
/// stable Rust では `str::floor_char_boundary` がまだ unstable なため。
fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

/// `idx` を直上の char 境界に丸める。
fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    let len = s.len();
    if idx >= len {
        return len;
    }
    while idx < len && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// `found_context` をシーン本文で緩めにマッチし、その window 内で
/// `found_text` を locate する (空白正規化したうえでの完全一致経路)。
/// 戻り値は **生 scene_text のバイトオフセット**。失敗時は `None`。
///
/// `found_text` が複数箇所に出現する場合は、各位置の周辺と `found_context`
/// の一致度 (trigram 重なり + 完全包含ボーナス) をスコアリングして
/// 最良の位置を選ぶ。これは「同じ表現が複数箇所にあるが LLM は特定の
/// 1 箇所を指摘している」ケースで誤位置に annotation が貼られる事故を防ぐ。
///
/// LLM が活用差・送り仮名差・全角半角差を含む `found_text` を返した場合は
/// この経路では `None` になる。日本語ではその後 [`find_text_position_morph`]
/// が形態素 lemma 照合でフォールバックする ([`find_text_position`])。
fn find_text_position_exact(
    scene_text: &str,
    found_text: &str,
    found_context: &str,
) -> Option<(usize, usize)> {
    // 空白正規化したシーン上でマッチし、`norm→raw` バイト写像で **生 scene_text の
    // バイトオフセット** に戻して返す。これにより exact / morph 両経路の戻り値が
    // 同じ raw 座標系に揃い、range_start/end の重なり判定が破綻しない。
    let (norm_scene, norm_to_raw) = normalize_ws_indexed(scene_text);
    let norm_ctx = normalize_ws(found_context);
    let norm_ft = normalize_ws(found_text);

    if norm_ft.is_empty() {
        return None;
    }

    // found_text の全出現位置を列挙
    let occurrences: Vec<usize> = norm_scene
        .match_indices(norm_ft.as_str())
        .map(|(i, _)| i)
        .collect();

    if occurrences.is_empty() {
        return None;
    }

    // 単一出現 or context なし: 最初 (=唯一) の位置。複数なら context で最良を選ぶ。
    let norm_pos = if occurrences.len() == 1 || norm_ctx.is_empty() {
        occurrences[0]
    } else {
        occurrences
            .iter()
            .copied()
            .max_by_key(|&pos| {
                let window = scene_window_around(&norm_scene, pos, norm_ft.len(), norm_ctx.len());
                score_context_match(window, &norm_ctx)
            })
            .unwrap_or(occurrences[0])
    };

    // normalized offset → raw scene_text offset
    let raw_start = *norm_to_raw.get(norm_pos)?;
    let raw_end = *norm_to_raw.get(norm_pos + norm_ft.len())?;
    Some((raw_start, raw_end))
}

/// `normalize_ws` と同じ正規化文字列を作りつつ、正規化文字列の各バイト位置が
/// 元 `s` のどのバイト位置に対応するかの写像 (`map[norm_byte] = raw_byte`) を返す。
/// `map` の長さは `norm.len() + 1` で、末尾に `s.len()` の番兵を持つ。
/// これで normalized 上のマッチ位置を生バイトオフセットへ戻せる。
fn normalize_ws_indexed(s: &str) -> (String, Vec<usize>) {
    let mut norm = String::with_capacity(s.len());
    let mut map: Vec<usize> = Vec::with_capacity(s.len() + 1);
    let mut prev_was_word = false;
    // 直前に出た空白ランの開始 raw 位置 (次に語が来たとき単一スペースへ畳む)
    let mut pending_space_raw: Option<usize> = None;

    for (idx, c) in s.char_indices() {
        if c.is_whitespace() {
            if prev_was_word {
                pending_space_raw = Some(idx);
            }
            prev_was_word = false;
            continue;
        }
        // 語の前に空白ランがあり、かつ先頭でなければ単一スペースを挿入
        if let Some(space_raw) = pending_space_raw.take() {
            if !norm.is_empty() {
                map.push(space_raw);
                norm.push(' ');
            }
        }
        let before = norm.len();
        norm.push(c);
        for _ in before..norm.len() {
            map.push(idx);
        }
        prev_was_word = true;
    }
    map.push(s.len());
    (norm, map)
}

/// [`find_text_position`] の結果。
///
/// - `start`/`end`: シーン本文中の位置ヒント (FE は近傍ヒントとしてのみ使い、
///   表示時は `text_snapshot` から PM 位置を再解決する)。
/// - `surface`: **本文中に verbatim で存在する**文字列。これを `text_snapshot`
///   に格納すると、活用差などで LLM の `found_text` が本文と一致しないケースでも
///   FE が `indexOf` でエディタ上にアンカーを復元できる。
struct AnchorHit {
    start: usize,
    end: usize,
    surface: String,
}

/// LLM の `found_text` をシーン本文中に位置決めする。
///
/// 1. まず空白正規化の完全一致 ([`find_text_position_exact`]) を試す。これで
///    当たれば従来どおり (`surface = found_text`)。
/// 2. 当たらず、かつ日本語プロジェクトなら形態素 lemma 照合
///    ([`find_text_position_morph`]) でフォールバックし、活用差・送り仮名差・
///    全角半角差を吸収する。この経路では本文スライスを `surface` に採るため、
///    `text_snapshot` 経由の FE 再アンカーが成功する。
///
/// 英語など非日本語では形態素辞書 (lindera/UniDic) が無いため、完全一致のみ
/// (= 従来挙動) に留める。どちらも当たらなければ `None` (orphaned)。
fn find_text_position(
    scene_text: &str,
    found_text: &str,
    found_context: &str,
    is_japanese: bool,
) -> Option<AnchorHit> {
    // exact (空白正規化) を先に、外れたら日本語のみ形態素 lemma 照合。
    // どちらも生 scene_text のバイトオフセットを返す (座標系を統一)。
    let (start, end) =
        find_text_position_exact(scene_text, found_text, found_context).or_else(|| {
            if is_japanese {
                find_text_position_morph(scene_text, found_text, found_context)
            } else {
                None
            }
        })?;
    // surface は常に本文スライス = verbatim。text_snapshot に入れると FE が
    // indexOf で再アンカーできる (LLM の found_text の表記揺れに依存しない)。
    let surface = scene_text.get(start..end)?.to_string();
    Some(AnchorHit {
        start,
        end,
        surface,
    })
}

/// 形態素 (lindera/UniDic) の lemma + 正規化表層を照合キーにして、`found_text`
/// のトークン列がシーン本文のトークン列に連続部分列として一致する位置を探す。
///
/// lemma が活用 (走った↔走る) を、`normalize_morph_key` が送り仮名・全角半角・
/// 大文字小文字差を吸収する。返すのは raw `scene_text` のバイト範囲。
///
/// 同一表現が複数箇所にある場合は exact 経路と同様に `found_context` で最良の
/// 位置を選ぶ (誤位置アンカーを防ぐ)。`MorphToken` は Rust 内部に閉じたまま
/// (Serialize 不要) で、戻り値はバイト位置のみ。lindera のトークナイズ失敗は
/// `warn` ログを残して `None` (= orphaned) に倒す。
fn find_text_position_morph(
    scene_text: &str,
    found_text: &str,
    found_context: &str,
) -> Option<(usize, usize)> {
    let ft_toks = match grimodex_lint::morph::tokenize_block(found_text) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "[post_effect] morph tokenize(found_text) 失敗; orphaned に倒す");
            return None;
        }
    };
    let ft_keys: Vec<String> = ft_toks
        .iter()
        .map(morph_key)
        .filter(|k| !k.is_empty())
        .collect();
    if ft_keys.is_empty() {
        return None;
    }

    let scene_toks = match grimodex_lint::morph::tokenize_block(scene_text) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = %e, "[post_effect] morph tokenize(scene) 失敗; orphaned に倒す");
            return None;
        }
    };
    // (照合キー, byte_start, byte_end)。空白等で key が空になるトークンは除外。
    let scene_keyed: Vec<(String, usize, usize)> = scene_toks
        .iter()
        .map(|t| (morph_key(t), t.byte_start, t.byte_end))
        .filter(|(k, _, _)| !k.is_empty())
        .collect();
    let window = ft_keys.len();
    if scene_keyed.len() < window {
        return None;
    }

    // 連続部分列一致の全候補を集める。
    let mut candidates: Vec<(usize, usize)> = Vec::new();
    for start in 0..=(scene_keyed.len() - window) {
        let matches = (0..window).all(|j| scene_keyed[start + j].0 == ft_keys[j]);
        if matches {
            let s = scene_keyed[start].1;
            let e = scene_keyed[start + window - 1].2;
            if s < e && scene_text.is_char_boundary(s) && scene_text.is_char_boundary(e) {
                candidates.push((s, e));
            }
        }
    }

    if candidates.len() <= 1 || found_context.is_empty() {
        return candidates.first().copied();
    }
    // 複数候補: exact 経路と同じく周辺 window と context の一致度で最良を選ぶ。
    candidates
        .iter()
        .copied()
        .max_by_key(|&(s, e)| {
            let window =
                scene_window_around(scene_text, s, e.saturating_sub(s), found_context.len());
            score_context_match(window, found_context)
        })
        .or_else(|| candidates.first().copied())
}

/// 形態素トークンの照合キー。lemma があればそれ (活用を吸収)、無ければ表層を
/// 使い、いずれも `normalize_morph_key` で正規化する。
fn morph_key(t: &grimodex_lint::morph::MorphToken) -> String {
    let base = if t.lemma.is_empty() {
        t.surface.as_str()
    } else {
        t.lemma.as_str()
    };
    normalize_morph_key(base)
}

/// 照合キーの正規化: 空白除去 + 全角 ASCII の半角化 + 小文字化。
/// 送り仮名差は lemma 側で、表記ゆれ (全角/半角・大小) はここで吸収する。
fn normalize_morph_key(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .map(fold_fullwidth_ascii)
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 全角 ASCII (Ａ-Ｚ ０-９ 記号) を対応する半角 ASCII へ畳み込む。
fn fold_fullwidth_ascii(c: char) -> char {
    match c {
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        _ => c,
    }
}

/// プロジェクトの言語が日本語 (= 形態素 lemma 照合を有効化する) か。
///
/// 既に開いている `conn` を直接使うことで `with_conn` 内から安全に呼べる
/// (`project_language` のように `with_conn` を再帰させるとデッドロックするのを
/// 回避)。判定は明示的な opt-in (`== "ja"`) とし、将来 ja/en 以外の言語が増えても
/// 誤って lindera(日本語専用辞書) を当てない。行が無い場合はスキーマ既定の ja、
/// DB エラー時は warn を残しつつ ja 既定にフォールバックする。
fn conn_project_is_japanese(conn: &rusqlite::Connection, project_id: &str) -> bool {
    match conn.query_row(
        "SELECT language FROM projects WHERE id = ?1",
        rusqlite::params![project_id],
        |r| r.get::<_, String>(0),
    ) {
        Ok(lang) => lang == "ja",
        // 行が無い = スキーマ既定 'ja' 相当
        Err(rusqlite::Error::QueryReturnedNoRows) => true,
        Err(e) => {
            tracing::warn!(
                error = %e,
                project_id,
                "[post_effect] project 言語の取得に失敗; ja 既定にフォールバック"
            );
            true
        }
    }
}

/// `pos` の前後 `radius` バイトの窓を char 境界でクランプして返す。
fn scene_window_around(scene: &str, pos: usize, ft_len: usize, radius: usize) -> &str {
    let raw_start = pos.saturating_sub(radius);
    let raw_end = (pos + ft_len + radius).min(scene.len());
    let start = floor_char_boundary(scene, raw_start);
    let end = ceil_char_boundary(scene, raw_end);
    &scene[start..end]
}

/// 出現位置周辺のウィンドウと `context` の一致度スコア。
///
/// - ウィンドウが context を完全包含 → 大ボーナス (1_000_000)
/// - そうでなければ trigram 重なり数 (順序を多少考慮した粗い一致度)
fn score_context_match(window: &str, context: &str) -> u32 {
    if context.is_empty() {
        return 0;
    }
    if window.contains(context) {
        return 1_000_000;
    }
    let n = 3;
    let ctx_chars: Vec<char> = context.chars().collect();
    if ctx_chars.len() < n {
        return 0;
    }
    let trigrams: std::collections::HashSet<String> = (0..=ctx_chars.len() - n)
        .map(|i| ctx_chars[i..i + n].iter().collect::<String>())
        .collect();
    let win_chars: Vec<char> = window.chars().collect();
    if win_chars.len() < n {
        return 0;
    }
    let mut hits: u32 = 0;
    for i in 0..=win_chars.len() - n {
        let tg: String = win_chars[i..i + n].iter().collect();
        if trigrams.contains(&tg) {
            hits += 1;
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// DB ヘルパー: dismiss_key が closed 済みかチェック (typo / consistency / intra 共通)
// ---------------------------------------------------------------------------

/// annotation が既にユーザーによって閉じられているか判定する (typo / consistency
/// / intra 共通)。
///
/// `is_manually_dismissed` との違い:
/// - status を `dismissed` だけでなく `resolved` も対象にする (ユーザーが
///   「解決済み」(✓) で閉じたケースを再検出させない)
/// - dismiss_source の有無は問わない (resolved は dismiss_source を立てない)
/// - dismiss_key の格納位置は新規分は top-level だが、既存 (consistency:
///   `codex_ref` 内 / 旧 typo: `typo_ref` 内) で nested 保存されたものとの
///   後方互換のため複数 path を OR で照会する
///
/// 同じ dismiss_key を持つ closed annotation が一件でも存在すれば true を返す。
/// 呼び出し側は true なら新規 INSERT を skip することで、AI 再実行時に過去判断が
/// 上書きされる UX バグを防ぐ。
fn is_annotation_previously_closed(
    conn: &rusqlite::Connection,
    project_id: &str,
    category: &str,
    dismiss_keys: &[&str],
) -> bool {
    annotation_with_key_exists(
        conn,
        project_id,
        category,
        dismiss_keys,
        "('dismissed', 'resolved')",
    )
}

/// 同じ dismiss_key を持つ **open** annotation が既に存在するか判定する。
///
/// run が途中失敗した後の再実行（continue-on-error 化で部分失敗 run の成功
/// シーン分も保存されるようになった）では、前回成功シーンの指摘を LLM が
/// 再度返してくると同一 dismiss_key の open annotation が二重挿入される。
/// 呼び出し側は true なら INSERT を skip して既存 open 行を残す。
/// consistency は range 重なりベースの in-place マージ
/// (`find_overlapping_open_annotation`) を持つためこのガードは使わない。
fn has_open_annotation_with_key(
    conn: &rusqlite::Connection,
    project_id: &str,
    category: &str,
    dismiss_keys: &[&str],
) -> bool {
    annotation_with_key_exists(conn, project_id, category, dismiss_keys, "('open')")
}

/// `status_set_sql` は呼び出し側が文字列リテラルで渡す SQL の IN 集合
/// (ユーザー入力ではない)。dismiss_key の格納位置は新規分 top-level / 旧
/// nested (codex_ref / typo_ref) の複数 path を OR で照会する。
fn annotation_with_key_exists(
    conn: &rusqlite::Connection,
    project_id: &str,
    category: &str,
    dismiss_keys: &[&str],
    status_set_sql: &str,
) -> bool {
    if dismiss_keys.is_empty() {
        return false;
    }
    let placeholders = std::iter::repeat_n("?", dismiss_keys.len())
        .collect::<Vec<_>>()
        .join(", ");
    // category は呼び出し側が文字列リテラルで指定する (ユーザー入力ではない)。
    // project_id を必ず束縛してプロジェクト跨ぎの dismiss_key 衝突を防ぐ
    // (この経路の他の read/write はすべて project スコープ済み。dismiss_key 自体
    // に scene_id(UUID) が埋まり衝突はほぼ起き得ないが defense-in-depth)。
    let sql = format!(
        "SELECT 1 FROM post_effect_annotations
           WHERE project_id = ?1
             AND category = ?2
             AND status IN {status_set_sql}
             AND (json_extract(metadata, '$.dismiss_key')            IN ({placeholders})
                  OR json_extract(metadata, '$.codex_ref.dismiss_key') IN ({placeholders})
                  OR json_extract(metadata, '$.typo_ref.dismiss_key')  IN ({placeholders}))
           LIMIT 1"
    );
    // params: [project_id, category, keys..., keys..., keys...]
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + dismiss_keys.len() * 3);
    params.push(&project_id as &dyn rusqlite::ToSql);
    params.push(&category as &dyn rusqlite::ToSql);
    for _ in 0..3 {
        for k in dismiss_keys {
            params.push(k as &dyn rusqlite::ToSql);
        }
    }
    conn.query_row(&sql, rusqlite::params_from_iter(params), |_| Ok(()))
        .is_ok()
}

/// confidence の優先順位 (high > medium > low) で重みを返す。
fn confidence_rank(c: &str) -> u8 {
    match c {
        "high" => 3,
        "low" => 1,
        // medium またはその他は medium 扱い
        _ => 2,
    }
}

/// 2 つの confidence をマージする (max 採用)。
/// 過去 run で high が出ていた指摘が、後続 run で medium になっても
/// high のまま保持する (LLM の揺らぎで severity が下がるのを防ぐ)。
fn merge_confidence<'a>(old: &'a str, new: &'a str) -> &'a str {
    if confidence_rank(old) >= confidence_rank(new) {
        old
    } else {
        new
    }
}

/// `confidence` に対応する `severity` 値を返す。
fn severity_from_confidence(confidence: &str) -> &'static str {
    match confidence {
        "high" => "error",
        "low" => "suggestion",
        _ => "warning",
    }
}

/// 同 entry_id / 同 scene の open annotation で、range が `[new_start, new_end)`
/// と重なるものを 1 件返す（複数あれば最初の 1 件）。重なる既存があれば
/// in-place で UPDATE して LLM 揺らぎを吸収する。
///
/// orphaned (range_start == range_end) 同士は重なり判定対象外。
fn find_overlapping_open_annotation(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_id: &str,
    entry_id: &str,
    new_start: i64,
    new_end: i64,
) -> Option<(String, String)> {
    if new_start == new_end {
        return None; // orphaned な新規は merge 対象から外す
    }
    conn.query_row(
        "SELECT id,
                COALESCE(json_extract(metadata, '$.codex_ref.confidence'), 'medium') AS conf
           FROM post_effect_annotations
          WHERE project_id = ?
            AND scene_id = ?
            AND category = 'consistency_anchor'
            AND status = 'open'
            AND json_extract(metadata, '$.codex_ref.entry_id') = ?
            AND range_end > range_start
            AND range_start < ?
            AND range_end > ?
          ORDER BY created_at ASC
          LIMIT 1",
        params![project_id, scene_id, entry_id, new_end, new_start],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .ok()
}

// ---------------------------------------------------------------------------
// consistency run
// ---------------------------------------------------------------------------

/// consistency チェックを 1 シーン分実行し、挿入したアノテーション数を返す。
/// 進捗イベントや run ステータス更新は呼び出し側が担当する。
#[allow(clippy::too_many_arguments)]
async fn process_consistency_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    codex_payload_json: &str,
    scene_text: &str,
    system_prompt: &str,
    model_override: Option<&str>,
    prov: &RoleProviderOverride,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        codex_bytes = codex_payload_json.len(),
        scene_chars = scene_text.chars().count(),
        "[post_effect] consistency: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override,
            role_override: prov,
            system_prompt,
            codex_content: Some(codex_payload_json),
            scene_content: scene_text,
        })
        .await
        .map_err(|e| {
            tracing::error!(
                run_id = run_id,
                scene_id = scene_id,
                elapsed_ms = ai_start.elapsed().as_millis(),
                error = %e,
                "[post_effect] consistency: AI call failed"
            );
            anyhow::anyhow!("AI 呼び出し失敗: {e}")
        })?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        elapsed_ms = ai_start.elapsed().as_millis(),
        raw_bytes = raw_response.len(),
        "[post_effect] consistency: AI response received"
    );

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    tracing::debug!(
        run_id = run_id,
        scene_id = scene_id,
        json_preview = %&json_str.chars().take(120).collect::<String>(),
        "[post_effect] consistency: extracted JSON preview"
    );
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(2000).collect::<String>(),
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] consistency: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let violations = extract_array_field(&parsed, "violations").map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] consistency: JSON structure INVALID"
        );
        anyhow::anyhow!("LLM 出力の構造が不正: {e}")
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        violations_count = violations.len(),
        "[post_effect] consistency: parsed violations"
    );

    let codex_entries: Vec<Value> = serde_json::from_str(codex_payload_json).unwrap_or_default();
    let name_map: HashMap<String, String> = codex_entries
        .iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_string();
            let name = e["name"].as_str()?.to_string();
            Some((id, name))
        })
        .collect();

    // entry_id → detail_values の name 集合。LLM が返した detail_name を
    // この集合と照合して、hallucination を弾く。
    let detail_names_by_entry: HashMap<String, std::collections::HashSet<String>> = codex_entries
        .iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_string();
            let detail_values = e["detail_values"].as_array()?;
            let names: std::collections::HashSet<String> = detail_values
                .iter()
                .filter_map(|dv| dv["name"].as_str().map(|s| s.to_string()))
                .collect();
            Some((id, names))
        })
        .collect();

    // entry_id の検証: LLM が hallucinate した存在しない entry_id を捨てる。
    // (silent に DB へ入れると entry_name が空の不格好な annotation になる)
    let mut hallucinated: Vec<String> = Vec::new();
    let validated: Vec<&Value> = violations
        .iter()
        .filter(|v| {
            if violation_has_valid_entry_id(v, &name_map) {
                return true;
            }
            let reason = v["entry_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "(empty)".to_string());
            hallucinated.push(reason);
            false
        })
        .collect();
    if !hallucinated.is_empty() {
        tracing::warn!(
            run_id = run_id,
            scene_id = scene_id,
            hallucinated_entry_ids = ?hallucinated,
            valid_entry_ids = ?name_map.keys().collect::<Vec<_>>(),
            "[post_effect] consistency: dropped violations with unknown entry_id"
        );
    }

    let mut seen_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = validated
        .iter()
        .copied()
        .filter(|v| {
            let entry_id = v["entry_id"].as_str().unwrap_or("");
            let source_field = v["source_field"].as_str().unwrap_or("");
            // dedup キーには LLM が返した detail_name をそのまま使う。
            // hallucination の検証/丸めは INSERT 直前で行う (同じ run で同じ
            // 不正値を 2 回返すケースを 1 件に dedup させる挙動を意図)。
            let detail_name = v["detail_name"].as_str().unwrap_or("__none__");
            let found_text = strong_normalize(v["found_text"].as_str().unwrap_or(""));
            let key = format!("{entry_id}|{source_field}|{detail_name}|{found_text}");
            seen_keys.insert(key)
        })
        .collect();

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        deduped_count = deduped.len(),
        "[post_effect] consistency: saving annotations"
    );
    on_stage(0.7, "saving");
    let save_start = std::time::Instant::now();
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for violation in &deduped {
                let entry_id = violation["entry_id"].as_str().unwrap_or("");
                let found_text = violation["found_text"].as_str().unwrap_or("");
                let found_context = violation["found_context"].as_str().unwrap_or("");
                let confidence = violation["confidence"].as_str().unwrap_or("medium");
                let reason = violation["reason"].as_str().unwrap_or("");
                let expected_value = violation["expected_value"].as_str().unwrap_or("");
                let source_field = violation["source_field"].as_str().unwrap_or("content");
                let source_excerpt = violation["source_excerpt"].as_str();

                // detail_name の検証: LLM が hallucinate した detail 名は捨てる。
                // 不正値は warn ログを残しつつ None に丸めて annotation 自体は残す。
                let raw_detail_name = violation["detail_name"].as_str();
                let detail_name: Option<&str> = match raw_detail_name {
                    Some("") => None,
                    Some(name) => {
                        if detail_name_is_valid(entry_id, name, &detail_names_by_entry) {
                            Some(name)
                        } else {
                            tracing::warn!(
                                run_id = run_id,
                                scene_id = scene_id,
                                entry_id = entry_id,
                                hallucinated_detail_name = name,
                                valid_detail_names = ?detail_names_by_entry
                                    .get(entry_id)
                                    .map(|s| s.iter().collect::<Vec<_>>()),
                                "[post_effect] consistency: detail_name not in Codex; coerced to null"
                            );
                            None
                        }
                    }
                    None => None,
                };

                let dismiss_key = dismiss_key_consistency(entry_id, found_text);
                let legacy_dismiss_key = dismiss_key_consistency_legacy(entry_id, found_text);
                let entry_name = name_map.get(entry_id).cloned().unwrap_or_default();

                // 過去に dismissed / resolved されている場合は新規 annotation を
                // 作らない (ユーザー判断を尊重 + done セクションが重複しない)。
                // 旧 is_manually_dismissed は dismissed のみ + dismiss_source 必須で
                // resolved を取りこぼし、かつ dismiss_key が codex_ref 内 nested の
                // ため top-level クエリが空振りしていた regression を解消する。
                if is_annotation_previously_closed(
                    conn,
                    project_id,
                    "consistency_anchor",
                    &[&dismiss_key, &legacy_dismiss_key],
                ) {
                    continue;
                }

                let hit = find_text_position(scene_text, found_text, found_context, is_ja);
                let (range_start, range_end, orphaned) = match &hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                // text_snapshot には本文に verbatim 存在する表層を入れる
                // (FE が indexOf で再アンカーできるように)。
                let text_snapshot = hit.as_ref().map_or(found_text, |h| h.surface.as_str());

                // 既存 open annotation で range が重なるものを探す。
                // ヒットすれば INSERT せず UPDATE (LLM の表現揺れを吸収)。
                // 既存 dismissed/resolved は上の早期 continue で除外済み。
                let existing = find_overlapping_open_annotation(
                    conn, project_id, scene_id, entry_id, range_start, range_end,
                );

                // confidence は既存とのマージで max を採る (揺らぎで下がるのを防ぐ)
                let merged_confidence: String = match &existing {
                    Some((_, old_conf)) => merge_confidence(old_conf, confidence).to_string(),
                    None => confidence.to_string(),
                };
                let severity = severity_from_confidence(&merged_confidence);

                let content = format!(
                    "{}.{} と矛盾: {}",
                    entry_name,
                    detail_name.unwrap_or(source_field),
                    found_text
                );
                // dismiss_key は top-level にも複製保存する (
                // is_annotation_previously_closed が新規分は top-level の
                // $.dismiss_key を優先参照するため。後方互換で nested 版も
                // 残す)。
                let metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "codex_ref": {
                        "entry_id": entry_id,
                        "entry_name": entry_name,
                        "source_field": source_field,
                        "source_excerpt": source_excerpt,
                        "detail_name": detail_name,
                        "expected_value": expected_value,
                        "found_value": found_text,
                        "found_text": found_text,
                        "found_context": found_context,
                        "confidence": merged_confidence,
                        "llm_reason": reason,
                        "dismiss_key": dismiss_key,
                        "detected_by_model": detected_model,
                    },
                    "orphaned": orphaned,
                });

                let emitted_id = if let Some((existing_id, _)) = existing {
                    // 既存 annotation を in-place 更新
                    conn.execute(
                        "UPDATE post_effect_annotations
                            SET run_id = ?,
                                range_start = ?,
                                range_end = ?,
                                text_snapshot = ?,
                                severity = ?,
                                content = ?,
                                metadata = ?,
                                updated_at = datetime('now')
                          WHERE id = ?",
                        params![
                            run_id,
                            range_start,
                            range_end,
                            text_snapshot,
                            severity,
                            content,
                            metadata.to_string(),
                            existing_id,
                        ],
                    )?;
                    tracing::debug!(
                        run_id = run_id,
                        scene_id = scene_id,
                        annotation_id = %existing_id,
                        "[post_effect] consistency: merged into existing annotation"
                    );
                    existing_id
                } else {
                    let new_id = Uuid::new_v4().to_string();
                    conn.execute(
                        "INSERT INTO post_effect_annotations
                            (id, project_id, run_id, anchor_type, scene_id,
                             range_start, range_end, text_snapshot,
                             category, severity, content, author_role,
                             status, metadata, created_at, updated_at)
                         VALUES (?, ?, ?, 'scene_range', ?,
                                 ?, ?, ?,
                                 'consistency_anchor', ?, ?, 'ai',
                                 'open', ?, datetime('now'), datetime('now'))",
                        params![
                            new_id,
                            project_id,
                            run_id,
                            scene_id,
                            range_start,
                            range_end,
                            text_snapshot,
                            severity,
                            content,
                            metadata.to_string(),
                        ],
                    )?;
                    new_id
                };

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: emitted_id,
                    },
                );
                count += 1;
            }

            // 旧仕様の「前回 open を run_completed で dismissed」UPDATE はここに
            // あったが廃止した。LLM 検出は決定論的でなく、揺らぎ・モデル変更で
            // 真の指摘が silent に消える事故が起きていたため。指摘の close は
            // ユーザーの明示操作 (manual dismiss / resolved) のみで行う。

            Ok(count)
        })
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        saved_count = count,
        save_ms = save_start.elapsed().as_millis(),
        "[post_effect] consistency: scene DONE"
    );

    Ok(count)
}

/// 7 つの単一シーン run_*_task が共有するスケルトン: "calling_ai" の初回
/// progress を emit → effect 固有の process を await → 成功時は finalize_run +
/// done(summary: None)、失敗時は error emit + fail_run。
/// run_multi_task は構造が異なる（fan-out / abort / per-scene 進捗）ため対象外。
async fn run_effect_task<R, F, Fut>(runtime: R, run_id: String, process: F)
where
    R: PostEffectRuntime,
    F: FnOnce(R, String) -> Fut,
    Fut: Future<Output = Result<usize, anyhow::Error>>,
{
    emit_event(
        &runtime,
        "post_effect:progress",
        ProgressEvent {
            run_id: &run_id,
            stage: "calling_ai",
            progress: 0.1,
            message: None,
        },
    );

    match process(runtime.clone(), run_id.clone()).await {
        Ok(n) => {
            finish_success(&runtime, &run_id, n, None);
        }
        Err(e) => {
            finish_failure(&runtime, &run_id, &e.to_string());
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_consistency_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
    system_prompt: String,
    model_override: Option<String>,
    prov: RoleProviderOverride,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_consistency_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &codex_payload_json,
            &scene_text,
            &system_prompt,
            model_override.as_deref(),
            &prov,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

// ---------------------------------------------------------------------------
// intra_scene_consistency run
// ---------------------------------------------------------------------------

/// intra_scene_consistency チェックを 1 シーン分実行し、挿入したペア数を返す。
/// 進捗イベントや run ステータス更新は呼び出し側が担当する。
#[allow(clippy::too_many_arguments)]
async fn process_intra_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        scene_chars = scene_text.chars().count(),
        "[post_effect] intra: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let no_override = RoleProviderOverride::default();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override: None,
            role_override: &no_override,
            system_prompt,
            codex_content: None,
            scene_content: scene_text,
        })
        .await
        .map_err(|e| {
            tracing::error!(
                run_id = run_id,
                scene_id = scene_id,
                elapsed_ms = ai_start.elapsed().as_millis(),
                error = %e,
                "[post_effect] intra: AI call failed"
            );
            anyhow::anyhow!("AI 呼び出し失敗: {e}")
        })?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        elapsed_ms = ai_start.elapsed().as_millis(),
        raw_bytes = raw_response.len(),
        "[post_effect] intra: AI response received"
    );

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(2000).collect::<String>(),
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] intra: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let pairs = extract_array_field(&parsed, "pairs").map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] intra: JSON structure INVALID"
        );
        anyhow::anyhow!("LLM 出力の構造が不正: {e}")
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        pairs_count = pairs.len(),
        "[post_effect] intra: parsed pairs"
    );

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = pairs
        .iter()
        .filter(|p| {
            let a_t = strong_normalize(p["a"]["found_text"].as_str().unwrap_or(""));
            let b_t = strong_normalize(p["b"]["found_text"].as_str().unwrap_or(""));
            let mut sorted = [a_t.clone(), b_t.clone()];
            sorted.sort();
            let key = format!("{}|{}", scene_id, sorted.join("|"));
            seen.insert(key)
        })
        .collect();

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for pair in &deduped {
                let a_text = pair["a"]["found_text"].as_str().unwrap_or("");
                let a_ctx = pair["a"]["found_context"].as_str().unwrap_or("");
                let b_text = pair["b"]["found_text"].as_str().unwrap_or("");
                let b_ctx = pair["b"]["found_context"].as_str().unwrap_or("");
                let confidence = pair["confidence"].as_str().unwrap_or("medium");
                let reason = pair["reason"].as_str().unwrap_or("");
                let severity = match confidence {
                    "high" => "error",
                    "low" => "suggestion",
                    _ => "warning",
                };

                let dismiss_key = dismiss_key_intra(scene_id, a_text, b_text);
                let legacy_dismiss_key = dismiss_key_intra_legacy(scene_id, a_text, b_text);

                // 過去に dismissed / resolved されている場合は新規 pair を
                // 作らない (ユーザー判断を尊重)。同 dismiss_key の片側 a/b の
                // どちらかが closed なら pair 全体を skip する (
                // update_relation_status はカスケードで両側を同 status にする
                // ため、片側だけ open になる正規ルートは存在しない)。
                if is_annotation_previously_closed(
                    conn,
                    project_id,
                    "consistency_anchor",
                    &[&dismiss_key, &legacy_dismiss_key],
                ) || has_open_annotation_with_key(
                    conn,
                    project_id,
                    "consistency_anchor",
                    &[&dismiss_key, &legacy_dismiss_key],
                ) {
                    continue;
                }

                let a_hit = find_text_position(scene_text, a_text, a_ctx, is_ja);
                let (a_start, a_end, a_orphaned) = match &a_hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let a_snapshot = a_hit.as_ref().map_or(a_text, |h| h.surface.as_str());
                let b_hit = find_text_position(scene_text, b_text, b_ctx, is_ja);
                let (b_start, b_end, b_orphaned) = match &b_hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let b_snapshot = b_hit.as_ref().map_or(b_text, |h| h.surface.as_str());

                let ann_a_id = Uuid::new_v4().to_string();
                let ann_b_id = Uuid::new_v4().to_string();
                let relation_id = Uuid::new_v4().to_string();

                let meta_a = serde_json::json!({
                    "confidence": confidence,
                    "llm_reason": reason,
                    "found_text": a_text,
                    "found_context": a_ctx,
                    "dismiss_key": dismiss_key,
                    "orphaned": a_orphaned,
                    "detected_by_model": detected_model,
                });
                let meta_b = serde_json::json!({
                    "confidence": confidence,
                    "llm_reason": reason,
                    "found_text": b_text,
                    "found_context": b_ctx,
                    "dismiss_key": dismiss_key,
                    "orphaned": b_orphaned,
                    "detected_by_model": detected_model,
                });

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'consistency_anchor', ?, ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        ann_a_id,
                        project_id,
                        run_id,
                        scene_id,
                        a_start,
                        a_end,
                        a_snapshot,
                        severity,
                        reason,
                        meta_a.to_string(),
                    ],
                )?;
                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'consistency_anchor', ?, ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        ann_b_id,
                        project_id,
                        run_id,
                        scene_id,
                        b_start,
                        b_end,
                        b_snapshot,
                        severity,
                        reason,
                        meta_b.to_string(),
                    ],
                )?;
                conn.execute(
                    "INSERT INTO post_effect_annotation_relations
                        (id, project_id, run_id,
                         annotation_a_id, annotation_b_id,
                         relation_type, direction, description, status, metadata, created_at)
                     VALUES (?, ?, ?, ?, ?, 'contradiction', 'bidirectional', ?, 'open', '{}', datetime('now'))",
                    params![relation_id, project_id, run_id, ann_a_id, ann_b_id, reason],
                )?;

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: ann_a_id.clone(),
                    },
                );
                count += 1;
            }

            // 旧仕様の「前回 open を run_completed で dismissed」UPDATE はここに
            // あったが廃止した (consistency 側と同じ理由)。

            Ok(count)
        })
    })?;

    Ok(count)
}

async fn run_intra_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_intra_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

// ---------------------------------------------------------------------------
// typo_detection run
// ---------------------------------------------------------------------------

/// typo_detection チェックを 1 シーン分実行し、挿入したアノテーション数を返す。
#[allow(clippy::too_many_arguments)]
async fn process_typo_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        scene_chars = scene_text.chars().count(),
        "[post_effect] typo: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let no_override = RoleProviderOverride::default();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override: None,
            role_override: &no_override,
            system_prompt,
            codex_content: None,
            scene_content: scene_text,
        })
        .await
        .map_err(|e| {
            tracing::error!(
                run_id = run_id,
                scene_id = scene_id,
                elapsed_ms = ai_start.elapsed().as_millis(),
                error = %e,
                "[post_effect] typo: AI call failed"
            );
            anyhow::anyhow!("AI 呼び出し失敗: {e}")
        })?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        elapsed_ms = ai_start.elapsed().as_millis(),
        raw_bytes = raw_response.len(),
        "[post_effect] typo: AI response received"
    );

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(2000).collect::<String>(),
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] typo: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let issues = extract_array_field(&parsed, "issues").map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] typo: JSON structure INVALID"
        );
        anyhow::anyhow!("LLM 出力の構造が不正: {e}")
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        issues_count = issues.len(),
        "[post_effect] typo: parsed issues"
    );

    // dedupe: 同じ scene 内で同じ (found_text + suggestion) を 1 件にまとめる
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = issues
        .iter()
        .filter(|p| {
            let ft = strong_normalize(p["found_text"].as_str().unwrap_or(""));
            let sg = strong_normalize(p["suggestion"].as_str().unwrap_or(""));
            if ft.is_empty() {
                return false;
            }
            seen.insert(format!("{ft}|{sg}"))
        })
        .collect();

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for issue in &deduped {
                let found_text = issue["found_text"].as_str().unwrap_or("");
                let found_context = issue["found_context"].as_str().unwrap_or("");
                let suggestion = issue["suggestion"].as_str().unwrap_or("");
                let raw_category = issue["category"].as_str().unwrap_or("other");
                let category_label = match raw_category {
                    // Japanese categories + shared + English (spelling/grammar/
                    // punctuation) — en projects emit the English set, ja the
                    // Japanese set; both are accepted (FE TypoCategory union).
                    "okurigana" | "missing-particle" | "homophone" | "missing-char"
                    | "spelling" | "grammar" | "punctuation" | "other" => raw_category,
                    _ => "other",
                };
                let confidence = issue["confidence"].as_str().unwrap_or("medium");
                let reason = issue["reason"].as_str().unwrap_or("");
                // typo は致命傷ではないので consistency より一段弱め
                let severity = match confidence {
                    "high" => "warning",
                    _ => "suggestion",
                };

                let dismiss_key = dismiss_key_typo(scene_id, found_text, suggestion);
                // 過去に dismissed / resolved されている場合は新規 annotation を
                // 作らない (ユーザー判断を尊重 + done セクションが重複しない)
                if is_annotation_previously_closed(conn, project_id, "typo_anchor", &[&dismiss_key])
                    || has_open_annotation_with_key(
                        conn,
                        project_id,
                        "typo_anchor",
                        &[&dismiss_key],
                    )
                {
                    continue;
                }

                let hit = find_text_position(scene_text, found_text, found_context, is_ja);
                let (range_start, range_end, orphaned) = match &hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let text_snapshot = hit.as_ref().map_or(found_text, |h| h.surface.as_str());

                let new_id = Uuid::new_v4().to_string();
                let content = if suggestion.is_empty() {
                    format!("「{found_text}」: {reason}")
                } else {
                    format!("「{found_text}」→「{suggestion}」: {reason}")
                };
                // dismiss_key は top-level に置く (
                // `is_annotation_previously_closed` が $.dismiss_key を優先参照
                // するため)。typo_ref 内にも残すのは旧 DB との後方互換のため。
                let metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "typo_ref": {
                        "category": category_label,
                        "found_text": found_text,
                        "found_context": found_context,
                        "suggestion": suggestion,
                        "confidence": confidence,
                        "llm_reason": reason,
                        "dismiss_key": dismiss_key,
                        "detected_by_model": detected_model,
                    },
                    "orphaned": orphaned,
                });

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'typo_anchor', ?, ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        new_id,
                        project_id,
                        run_id,
                        scene_id,
                        range_start,
                        range_end,
                        text_snapshot,
                        severity,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: new_id,
                    },
                );
                count += 1;
            }

            Ok(count)
        })
    })?;

    Ok(count)
}

async fn run_typo_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_typo_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

// ---------------------------------------------------------------------------
// review run (編集者視点の診断レポート)
// ---------------------------------------------------------------------------

/// review チェックを 1 シーン分実行し、挿入したアノテーション数を返す。
/// Codex 不使用・scene 本文のみ (typo と同形)。
#[allow(clippy::too_many_arguments)]
async fn process_review_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    model_override: Option<&str>,
    prov: &RoleProviderOverride,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        scene_chars = scene_text.chars().count(),
        "[post_effect] review: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override,
            role_override: prov,
            system_prompt,
            codex_content: None,
            scene_content: scene_text,
        })
        .await
        .map_err(|e| {
            tracing::error!(
                run_id = run_id,
                scene_id = scene_id,
                elapsed_ms = ai_start.elapsed().as_millis(),
                error = %e,
                "[post_effect] review: AI call failed"
            );
            anyhow::anyhow!("AI 呼び出し失敗: {e}")
        })?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(2000).collect::<String>(),
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] review: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let findings = extract_array_field(&parsed, "findings").map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] review: JSON structure INVALID"
        );
        anyhow::anyhow!("LLM 出力の構造が不正: {e}")
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        findings_count = findings.len(),
        "[post_effect] review: parsed findings"
    );

    // dedupe: 同じ scene 内で同じ (title + found_text) を 1 件にまとめる
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = findings
        .iter()
        .filter(|f| {
            let title = strong_normalize(f["title"].as_str().unwrap_or(""));
            let ft = strong_normalize(f["found_text"].as_str().unwrap_or(""));
            if title.is_empty() && ft.is_empty() {
                return false;
            }
            seen.insert(format!("{title}|{ft}"))
        })
        .collect();

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for finding in &deduped {
                let title = finding["title"].as_str().unwrap_or("");
                let reason = finding["reason"].as_str().unwrap_or("");
                let found_text = finding["found_text"].as_str().unwrap_or("");
                let found_context = finding["found_context"].as_str().unwrap_or("");
                let severity = match finding["severity"].as_str().unwrap_or("suggestion") {
                    "error" => "error",
                    "warning" => "warning",
                    "info" => "info",
                    _ => "suggestion",
                };

                let dismiss_key = dismiss_key_review(scene_id, title, found_text);
                if is_annotation_previously_closed(conn, project_id, "review", &[&dismiss_key])
                    || has_open_annotation_with_key(conn, project_id, "review", &[&dismiss_key])
                {
                    continue;
                }

                // found_text が空なら scene 全体所見 (位置特定なし = orphaned)
                let hit = if found_text.is_empty() {
                    None
                } else {
                    find_text_position(scene_text, found_text, found_context, is_ja)
                };
                let (range_start, range_end, orphaned) = match &hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let text_snapshot: Option<&str> = if found_text.is_empty() {
                    None
                } else {
                    Some(hit.as_ref().map_or(found_text, |h| h.surface.as_str()))
                };

                let new_id = Uuid::new_v4().to_string();
                let content = if title.is_empty() { reason } else { title };
                let metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "llm_reason": reason,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": detected_model,
                    "orphaned": orphaned,
                });

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'review', ?, ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        new_id,
                        project_id,
                        run_id,
                        scene_id,
                        range_start,
                        range_end,
                        text_snapshot,
                        severity,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: new_id,
                    },
                );
                count += 1;
            }

            Ok(count)
        })
    })?;

    Ok(count)
}

/// intent_drift チェックを 1 シーン分実行し、挿入したアノテーション数を返す。
#[allow(clippy::too_many_arguments)]
async fn process_intent_drift_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    model_override: Option<&str>,
    prov: &RoleProviderOverride,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        scene_chars = scene_text.chars().count(),
        "[post_effect] intent_drift: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override,
            role_override: prov,
            system_prompt,
            codex_content: None,
            scene_content: scene_text,
        })
        .await
        .map_err(|e| {
            tracing::error!(
                run_id = run_id,
                scene_id = scene_id,
                elapsed_ms = ai_start.elapsed().as_millis(),
                error = %e,
                "[post_effect] intent_drift: AI call failed"
            );
            anyhow::anyhow!("AI 呼び出し失敗: {e}")
        })?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(2000).collect::<String>(),
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] intent_drift: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let findings = extract_array_field(&parsed, "findings").map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] intent_drift: JSON structure INVALID"
        );
        anyhow::anyhow!("LLM 出力の構造が不正: {e}")
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        findings_count = findings.len(),
        "[post_effect] intent_drift: parsed findings"
    );

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = findings
        .iter()
        .filter(|f| {
            let title = strong_normalize(f["title"].as_str().unwrap_or(""));
            let ft = strong_normalize(f["found_text"].as_str().unwrap_or(""));
            if title.is_empty() && ft.is_empty() {
                return false;
            }
            seen.insert(format!("{title}|{ft}"))
        })
        .collect();

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for finding in &deduped {
                let title = finding["title"].as_str().unwrap_or("");
                let note = finding["note"].as_str().unwrap_or("");
                let relation = finding["relation"].as_str().unwrap_or("ambiguous");
                let found_text = finding["found_text"].as_str().unwrap_or("");
                let found_context = finding["found_context"].as_str().unwrap_or("");

                let dismiss_key = dismiss_key_intent_drift(scene_id, title, found_text);
                if is_annotation_previously_closed(
                    conn,
                    project_id,
                    "intent_anchor",
                    &[&dismiss_key],
                ) || has_open_annotation_with_key(
                    conn,
                    project_id,
                    "intent_anchor",
                    &[&dismiss_key],
                ) {
                    continue;
                }

                let hit = if found_text.is_empty() {
                    None
                } else {
                    find_text_position(scene_text, found_text, found_context, is_ja)
                };
                let (range_start, range_end, orphaned) = match &hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let text_snapshot: Option<&str> = if found_text.is_empty() {
                    None
                } else {
                    Some(hit.as_ref().map_or(found_text, |h| h.surface.as_str()))
                };

                let new_id = Uuid::new_v4().to_string();
                let content = if title.is_empty() { note } else { title };
                let metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "llm_reason": note,
                    "relation": relation,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": detected_model,
                    "orphaned": orphaned,
                });

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'intent_anchor', 'info', ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        new_id,
                        project_id,
                        run_id,
                        scene_id,
                        range_start,
                        range_end,
                        text_snapshot,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: new_id,
                    },
                );
                count += 1;
            }

            Ok(count)
        })
    })?;

    Ok(count)
}

#[allow(clippy::too_many_arguments)]
async fn run_intent_drift_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    model_override: Option<String>,
    prov: RoleProviderOverride,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_intent_drift_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            model_override.as_deref(),
            &prov,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

/// timeline_consistency チェックを 1 シーン分実行し、挿入したアノテーション数を返す。
///
/// クロスシーンの整合性は run_multi_task のシーン fan-out で扱う。物語内時系列の
/// 順序付き要約 (title / story_time_label / 概要) は TS 側で system_prompt に注入済で、
/// このシーン本文がその確立済タイムラインと矛盾する箇所だけを findings として返させる。
/// 1 シーン分の処理形は process_intent_drift_scene と同型 (scene_text + system_prompt)。
#[allow(clippy::too_many_arguments)]
async fn process_timeline_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    model_override: Option<&str>,
    prov: &RoleProviderOverride,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        scene_chars = scene_text.chars().count(),
        "[post_effect] timeline_consistency: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override,
            role_override: prov,
            system_prompt,
            codex_content: None,
            scene_content: scene_text,
        })
        .await
        .map_err(|e| {
            tracing::error!(
                run_id = run_id,
                scene_id = scene_id,
                elapsed_ms = ai_start.elapsed().as_millis(),
                error = %e,
                "[post_effect] timeline_consistency: AI call failed"
            );
            anyhow::anyhow!("AI 呼び出し失敗: {e}")
        })?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(2000).collect::<String>(),
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] timeline_consistency: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let findings = extract_array_field(&parsed, "findings").map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] timeline_consistency: JSON structure INVALID"
        );
        anyhow::anyhow!("LLM 出力の構造が不正: {e}")
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        findings_count = findings.len(),
        "[post_effect] timeline_consistency: parsed findings"
    );

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = findings
        .iter()
        .filter(|f| {
            let title = strong_normalize(f["title"].as_str().unwrap_or(""));
            let ft = strong_normalize(f["found_text"].as_str().unwrap_or(""));
            if title.is_empty() && ft.is_empty() {
                return false;
            }
            seen.insert(format!("{title}|{ft}"))
        })
        .collect();

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for finding in &deduped {
                let title = finding["title"].as_str().unwrap_or("");
                let note = finding["note"].as_str().unwrap_or("");
                let relation = finding["relation"].as_str().unwrap_or("ambiguous");
                let found_text = finding["found_text"].as_str().unwrap_or("");
                let found_context = finding["found_context"].as_str().unwrap_or("");

                let dismiss_key = dismiss_key_timeline(scene_id, title, found_text);
                if is_annotation_previously_closed(
                    conn,
                    project_id,
                    "timeline_anchor",
                    &[&dismiss_key],
                ) || has_open_annotation_with_key(
                    conn,
                    project_id,
                    "timeline_anchor",
                    &[&dismiss_key],
                ) {
                    continue;
                }

                let hit = if found_text.is_empty() {
                    None
                } else {
                    find_text_position(scene_text, found_text, found_context, is_ja)
                };
                let (range_start, range_end, orphaned) = match &hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let text_snapshot: Option<&str> = if found_text.is_empty() {
                    None
                } else {
                    Some(hit.as_ref().map_or(found_text, |h| h.surface.as_str()))
                };

                let new_id = Uuid::new_v4().to_string();
                let content = if title.is_empty() { note } else { title };
                let mut metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "llm_reason": note,
                    "relation": relation,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": detected_model,
                    "orphaned": orphaned,
                });
                // causality finding のみ、LLM が返した「因」シーン id を構造化保存する
                // (因果地図用)。LLM は実在しない id を返しうるが、描画側
                // (buildCausalityDag) が実在シーンに解決できないものを捨てるため
                // Rust 側では検証しない。
                if relation == "causality" {
                    let cause_scene_id = finding["cause_scene_id"].as_str().unwrap_or("");
                    if !cause_scene_id.is_empty() {
                        metadata["cause_scene_id"] =
                            serde_json::Value::String(cause_scene_id.to_string());
                    }
                }

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'timeline_anchor', 'info', ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        new_id,
                        project_id,
                        run_id,
                        scene_id,
                        range_start,
                        range_end,
                        text_snapshot,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: new_id,
                    },
                );
                count += 1;
            }

            Ok(count)
        })
    })?;

    Ok(count)
}

// ---------------------------------------------------------------------------
// impact_review run (変更された Codex 設定 → 本文の矛盾レビュー)
// ---------------------------------------------------------------------------

/// `contradiction_score` (0.0–1.0) から severity を導く。
/// consistency は confidence ベースだが impact_review は score を直接持つため
/// それを使う: >=0.7 → "warning", >=0.4 → "suggestion", それ以外 → "info"。
fn severity_from_contradiction_score(score: f64) -> &'static str {
    if score >= 0.7 {
        "warning"
    } else if score >= 0.4 {
        "suggestion"
    } else {
        "info"
    }
}

/// impact_review チェックを 1 シーン分実行し、挿入した annotation 数を返す。
/// `codex_payload_json` は 1 件の Codex 変更差分 (baseline→現在) を表す JSON
/// オブジェクト (change_id / entry_id / entry_name / entry_type / change_summary
/// / changes[])。consistency と同様に Codex ブロックとして call_post_effect_api に
/// `Some(..)` で渡す (cache_control 境界に乗る)。
#[allow(clippy::too_many_arguments)]
async fn process_impact_review_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    codex_payload_json: &str,
    scene_text: &str,
    system_prompt: &str,
    model_override: Option<&str>,
    prov: &RoleProviderOverride,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    // 差分ペイロードを寛容にデシリアライズ (欠落キーで hard-fail しない)。
    // entry メタは annotation metadata に転記するため取り出す。
    let diff: Value = serde_json::from_str(codex_payload_json).unwrap_or(Value::Null);
    let change_id = diff["change_id"].as_str().unwrap_or("");
    let entry_id = diff["entry_id"].as_str().unwrap_or("");
    let entry_name = diff["entry_name"].as_str().unwrap_or("");
    let change_summary = diff["change_summary"].as_str().unwrap_or("");

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        change_id = change_id,
        entry_id = entry_id,
        codex_bytes = codex_payload_json.len(),
        scene_chars = scene_text.chars().count(),
        "[post_effect] impact_review: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override,
            role_override: prov,
            system_prompt,
            codex_content: Some(codex_payload_json),
            scene_content: scene_text,
        })
        .await
        .map_err(|e| {
            tracing::error!(
                run_id = run_id,
                scene_id = scene_id,
                elapsed_ms = ai_start.elapsed().as_millis(),
                error = %e,
                "[post_effect] impact_review: AI call failed"
            );
            anyhow::anyhow!("AI 呼び出し失敗: {e}")
        })?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        elapsed_ms = ai_start.elapsed().as_millis(),
        raw_bytes = raw_response.len(),
        "[post_effect] impact_review: AI response received"
    );

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(2000).collect::<String>(),
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] impact_review: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let judgments = extract_array_field(&parsed, "judgments").map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] impact_review: JSON structure INVALID"
        );
        anyhow::anyhow!("LLM 出力の構造が不正: {e}")
    })?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        judgments_count = judgments.len(),
        "[post_effect] impact_review: parsed judgments"
    );

    // dedup: (change_id + strong_normalize(found_text))。空 found_text は除外。
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = judgments
        .iter()
        .filter(|j| {
            let ft = strong_normalize(j["found_text"].as_str().unwrap_or(""));
            if ft.is_empty() {
                return false;
            }
            seen.insert(format!("{}|{}", strong_normalize(change_id), ft))
        })
        .collect();

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for judgment in &deduped {
                let found_text = judgment["found_text"].as_str().unwrap_or("");
                let found_context = judgment["found_context"].as_str().unwrap_or("");
                let confidence = judgment["confidence"].as_str().unwrap_or("medium");
                let reason = judgment["reason"].as_str().unwrap_or("");
                let contradiction_score = judgment["contradiction_score"].as_f64().unwrap_or(0.0);

                let dismiss_key = dismiss_key_impact_review(scene_id, change_id, found_text);
                // brand-new カテゴリのため legacy 後方互換 key は不要 (single key path)。
                if is_annotation_previously_closed(
                    conn,
                    project_id,
                    "impact_review_anchor",
                    &[&dismiss_key],
                ) || has_open_annotation_with_key(
                    conn,
                    project_id,
                    "impact_review_anchor",
                    &[&dismiss_key],
                ) {
                    continue;
                }

                let hit = find_text_position(scene_text, found_text, found_context, is_ja);
                let (range_start, range_end, orphaned) = match &hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let text_snapshot = hit.as_ref().map_or(found_text, |h| h.surface.as_str());

                let severity = severity_from_contradiction_score(contradiction_score);
                let content = reason;

                let metadata = serde_json::json!({
                    "impact_ref": {
                        "entry_id": entry_id,
                        "entry_name": entry_name,
                        "change_id": change_id,
                        "change_summary": change_summary,
                        "contradiction_score": contradiction_score,
                        "llm_reason": reason,
                        "confidence": confidence,
                        "found_text": found_text,
                        "found_context": found_context,
                        "dismiss_key": dismiss_key,
                        "detected_by_model": detected_model,
                    },
                    "orphaned": orphaned,
                });

                let new_id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'impact_review_anchor', ?, ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        new_id,
                        project_id,
                        run_id,
                        scene_id,
                        range_start,
                        range_end,
                        text_snapshot,
                        severity,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: new_id,
                    },
                );
                count += 1;
            }

            Ok(count)
        })
    })?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        saved_count = count,
        "[post_effect] impact_review: scene DONE"
    );

    Ok(count)
}

#[allow(clippy::too_many_arguments)]
async fn run_impact_review_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
    system_prompt: String,
    model_override: Option<String>,
    prov: RoleProviderOverride,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_impact_review_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &codex_payload_json,
            &scene_text,
            &system_prompt,
            model_override.as_deref(),
            &prov,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

#[allow(clippy::too_many_arguments)]
async fn run_review_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    model_override: Option<String>,
    prov: RoleProviderOverride,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_review_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            model_override.as_deref(),
            &prov,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

// ---------------------------------------------------------------------------
// pseudo_comment run (読者ペルソナによる本文横コメント)
// ---------------------------------------------------------------------------

/// pseudo_comment チェックを 1 シーン分実行し、挿入したコメント数を返す。
/// Codex 不使用・scene 本文のみ。persona は annotation.persona に格納する。
#[allow(clippy::too_many_arguments)]
async fn process_pseudo_comment_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    persona: Option<&str>,
    model_override: Option<&str>,
    prov: &RoleProviderOverride,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        persona = persona.unwrap_or(""),
        "[post_effect] pseudo_comment: calling AI"
    );
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override,
            role_override: prov,
            system_prompt,
            codex_content: None,
            scene_content: scene_text,
        })
        .await
        .map_err(|e| anyhow::anyhow!("AI 呼び出し失敗: {e}"))?;
    let detected_model = ai_output.detected_model;
    let raw_response = ai_output.raw_response;

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] pseudo_comment: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let comments = extract_array_field(&parsed, "comments")
        .map_err(|e| anyhow::anyhow!("LLM 出力の構造が不正: {e}"))?;
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        comments_count = comments.len(),
        "[post_effect] pseudo_comment: parsed comments"
    );

    // dedupe: 同じ scene 内で同じ (found_text + content) を 1 件にまとめる
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let deduped: Vec<&Value> = comments
        .iter()
        .filter(|c| {
            let ft = strong_normalize(c["found_text"].as_str().unwrap_or(""));
            let body = strong_normalize(c["content"].as_str().unwrap_or(""));
            if body.is_empty() {
                return false;
            }
            seen.insert(format!("{ft}|{body}"))
        })
        .collect();

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            let is_ja = conn_project_is_japanese(conn, project_id);

            for comment in &deduped {
                let body = comment["content"].as_str().unwrap_or("");
                let found_text = comment["found_text"].as_str().unwrap_or("");
                let found_context = comment["found_context"].as_str().unwrap_or("");

                let hit = if found_text.is_empty() {
                    None
                } else {
                    find_text_position(scene_text, found_text, found_context, is_ja)
                };
                let (range_start, range_end, orphaned) = match &hit {
                    Some(h) => (h.start as i64, h.end as i64, false),
                    None => (0i64, 0i64, true),
                };
                let text_snapshot: Option<&str> = if found_text.is_empty() {
                    None
                } else {
                    Some(hit.as_ref().map_or(found_text, |h| h.surface.as_str()))
                };

                let new_id = Uuid::new_v4().to_string();
                let metadata = serde_json::json!({
                    "persona": persona,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": detected_model,
                    "orphaned": orphaned,
                });

                conn.execute(
                    "INSERT INTO post_effect_annotations
                        (id, project_id, run_id, anchor_type, scene_id,
                         range_start, range_end, text_snapshot,
                         category, persona, severity, content, author_role,
                         status, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, 'scene_range', ?,
                             ?, ?, ?,
                             'pseudo_comment', ?, NULL, ?, 'ai',
                             'open', ?, datetime('now'), datetime('now'))",
                    params![
                        new_id,
                        project_id,
                        run_id,
                        scene_id,
                        range_start,
                        range_end,
                        text_snapshot,
                        persona,
                        body,
                        metadata.to_string(),
                    ],
                )?;

                emit_event(
                    runtime,
                    "post_effect:partial",
                    PartialEvent {
                        run_id,
                        annotation_id: new_id,
                    },
                );
                count += 1;
            }

            Ok(count)
        })
    })?;

    Ok(count)
}

#[allow(clippy::too_many_arguments)]
async fn run_pseudo_comment_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    persona: Option<String>,
    model_override: Option<String>,
    prov: RoleProviderOverride,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_pseudo_comment_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            persona.as_deref(),
            model_override.as_deref(),
            &prov,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

// ---------------------------------------------------------------------------
// meta_structure run (プロット構造・ペーシングの俯瞰診断)
// ---------------------------------------------------------------------------

/// meta_structure を 1 シーン分実行し、挿入した lens 件数を返す。
/// annotation ではなく scene_lens_data に書き込む。
#[allow(clippy::too_many_arguments)]
async fn process_meta_structure_scene<R, A>(
    runtime: &R,
    ai: &A,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        "[post_effect] meta_structure: calling AI"
    );
    let no_override = RoleProviderOverride::default();
    let ai_output = ai
        .call(PostEffectAiRequest {
            model_override: None,
            role_override: &no_override,
            system_prompt,
            codex_content: None,
            scene_content: scene_text,
        })
        .await
        .map_err(|e| anyhow::anyhow!("AI 呼び出し失敗: {e}"))?;
    let raw_response = ai_output.raw_response;

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = parse_llm_json(&raw_response).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(2000).collect::<String>(),
            error = %e,
            "[post_effect] meta_structure: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let lenses = extract_array_field(&parsed, "lenses")
        .map_err(|e| anyhow::anyhow!("LLM 出力の構造が不正: {e}"))?;

    on_stage(0.7, "saving");
    let count: usize = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut count = 0usize;
            for lens in &lenses {
                // MVP は plot_structure / pacing のみ採用
                let lens_type = match lens["lens_type"].as_str().unwrap_or("") {
                    "plot_structure" => "plot_structure",
                    "pacing" => "pacing",
                    _ => continue,
                };
                let severity = match lens["severity"].as_str().unwrap_or("info") {
                    "error" => "error",
                    "warning" => "warning",
                    "suggestion" => "suggestion",
                    _ => "info",
                };
                let finding = lens["finding"].as_str().unwrap_or("");
                let metrics = lens
                    .get("metrics")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));

                let new_id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO scene_lens_data
                        (id, project_id, run_id, target_id, lens_type,
                         metrics, finding, severity, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
                    params![
                        new_id,
                        project_id,
                        run_id,
                        scene_id,
                        lens_type,
                        metrics.to_string(),
                        finding,
                        severity,
                    ],
                )?;
                count += 1;
            }
            Ok(count)
        })
    })?;

    Ok(count)
}

async fn run_meta_structure_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    run_effect_task(runtime, run_id, |runtime, run_id| async move {
        process_meta_structure_scene(
            &runtime,
            &ai,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            |p, s| {
                emit_event(
                    &runtime,
                    "post_effect:progress",
                    ProgressEvent {
                        run_id: &run_id,
                        stage: s,
                        progress: p,
                        message: None,
                    },
                );
            },
        )
        .await
    })
    .await;
}

// ---------------------------------------------------------------------------
// Multi-scene run task
// ---------------------------------------------------------------------------

/// run_multi_task 終了時の着地判定。
///
/// 従来は 1 シーンの失敗で run 全体を即 fail + return していたため、
/// プロジェクト全体チェックが LLM の 1 回の出力揺れ (パース不能 JSON 等) で
/// 丸ごと失敗していた。全シーンを処理し切ったあと、失敗の集計でまとめて
/// 着地を決める。
enum MultiRunOutcome {
    /// 全シーン成功 (空シーン skip 含む) — completed + done イベント。
    Completed,
    /// 一部失敗 — 成功シーンの annotation は保存済み。run 行は failed
    /// (同一 input_hash がキャッシュに乗らない = 再実行で再試行できる) に
    /// しつつ、FE には done イベント + summary で「部分完了」を伝える。
    CompletedWithFailures(String),
    /// 実処理した全シーンが失敗 — 従来どおり fail_run + error イベント。
    Failed(String),
}

/// `attempted` = 空シーン skip を除いた実処理シーン数。
/// `failures` = (scene_id, エラーメッセージ)。
fn decide_multi_outcome(attempted: usize, failures: &[(String, String)]) -> MultiRunOutcome {
    if failures.is_empty() {
        return MultiRunOutcome::Completed;
    }
    let first_error = failures
        .first()
        .map(|(_, e)| e.as_str())
        .unwrap_or("不明なエラー");
    if failures.len() >= attempted {
        return MultiRunOutcome::Failed(format!(
            "全 {attempted} シーンの解析に失敗しました。最初のエラー: {first_error}"
        ));
    }
    let ok = attempted - failures.len();
    MultiRunOutcome::CompletedWithFailures(format!(
        "{}/{attempted} シーンの解析に失敗しました（他 {ok} シーンは完了）。最初のエラー: {first_error}",
        failures.len()
    ))
}

#[cfg(test)]
mod decide_multi_outcome_tests {
    use super::{decide_multi_outcome, MultiRunOutcome};

    fn fail(id: &str, err: &str) -> (String, String) {
        (id.to_string(), err.to_string())
    }

    #[test]
    fn all_ok_is_completed() {
        assert!(matches!(
            decide_multi_outcome(5, &[]),
            MultiRunOutcome::Completed
        ));
    }

    #[test]
    fn zero_attempted_is_completed() {
        // 全シーンが空で skip された場合も正常完了扱い
        assert!(matches!(
            decide_multi_outcome(0, &[]),
            MultiRunOutcome::Completed
        ));
    }

    #[test]
    fn some_failures_is_partial_with_counts() {
        let failures = vec![fail("s1", "パース失敗: xyz")];
        match decide_multi_outcome(15, &failures) {
            MultiRunOutcome::CompletedWithFailures(msg) => {
                assert!(msg.contains("1/15"), "got: {msg}");
                assert!(msg.contains("他 14 シーンは完了"), "got: {msg}");
                assert!(msg.contains("パース失敗: xyz"), "got: {msg}");
            }
            _ => panic!("expected CompletedWithFailures"),
        }
    }

    #[test]
    fn all_failed_is_failed() {
        let failures = vec![fail("s1", "err A"), fail("s2", "err B")];
        match decide_multi_outcome(2, &failures) {
            MultiRunOutcome::Failed(msg) => {
                assert!(msg.contains("全 2 シーン"), "got: {msg}");
                // 最初のエラーを代表として載せる
                assert!(msg.contains("err A"), "got: {msg}");
            }
            _ => panic!("expected Failed"),
        }
    }
}

#[cfg(test)]
mod abort_registry_tests {
    #[test]
    fn abort_registry_is_scoped_per_run() {
        let reg = super::PostEffectAbortRegistry::new();
        reg.request("run-a");
        assert!(reg.is_aborted("run-a"));
        assert!(!reg.is_aborted("run-b")); // 他 run に波及しない
        reg.clear("run-a");
        assert!(!reg.is_aborted("run-a")); // 終端後は解除され、後続の同名 run を汚さない
    }

    /// 単発 run の終端は `start_post_effect_run` の spawn 出口で
    /// `registry.clear(&run_id)` を呼ぶ（run_multi の join 出口と同じパターン。
    /// AppHandle が要るため spawn 自体はユニットで駆動できないが、その clear が
    /// 満たすべき不変条件をレジストリ単体で担保する）。中止要求済みの単発 run が
    /// 終端で clear されても、並走する別 run の中止要求は残る。
    #[test]
    fn single_run_terminal_clear_is_scoped() {
        let reg = super::PostEffectAbortRegistry::new();
        // 単発 run(single) と別 run(other) の両方に中止を要求。
        reg.request("single");
        reg.request("other");
        assert!(reg.is_aborted("single"));
        assert!(reg.is_aborted("other"));
        // 単発 run が終端 → spawn 出口の clear 相当。
        reg.clear("single");
        assert!(!reg.is_aborted("single")); // 永久残留しない（リーク防止）
        assert!(reg.is_aborted("other")); // 並走 run の要求は握り潰さない
    }

    #[test]
    fn request_if_holds_registry_lock_until_abort_flag_is_visible() {
        use std::sync::mpsc;
        use std::time::Duration;

        let reg = super::PostEffectAbortRegistry::new();
        let (cas_entered_tx, cas_entered_rx) = mpsc::channel();
        let (release_cas_tx, release_cas_rx) = mpsc::channel();
        let request_reg = reg.clone();
        let request = std::thread::spawn(move || {
            request_reg
                .request_if("run", |_bound_db| {
                    cas_entered_tx.send(()).expect("signal CAS entered");
                    release_cas_rx.recv().expect("release CAS");
                    Ok(true)
                })
                .expect("request_if")
        });

        cas_entered_rx.recv().expect("CAS entered");
        let (observing_tx, observing_rx) = mpsc::channel();
        let (observed_tx, observed_rx) = mpsc::channel();
        let observer_reg = reg.clone();
        let observer = std::thread::spawn(move || {
            observing_tx.send(()).expect("signal observer started");
            observed_tx
                .send(observer_reg.is_aborted("run"))
                .expect("send observed flag");
        });

        observing_rx.recv().expect("observer started");
        assert!(
            observed_rx.recv_timeout(Duration::from_millis(50)).is_err(),
            "worker の is_aborted は DB CAS→flag insert の critical section 中に割り込まない"
        );
        release_cas_tx.send(()).expect("release CAS");
        assert!(observed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("observer completes after flag insert"));
        assert!(request.join().expect("request thread"));
        observer.join().expect("observer thread");
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_multi_task<R, A>(
    runtime: R,
    ai: A,
    run_id: String,
    project_id: String,
    effect_type: String,
    scenes: Vec<ScenePayload>,
    system_prompt: String,
    model_override: Option<String>,
    prov: RoleProviderOverride,
) where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    let total = scenes.len();
    let mut total_count = 0usize;
    // 1 シーンの失敗で run 全体を落とさず、失敗を集計して最後に着地を決める
    // (decide_multi_outcome)。成功シーンの annotation はその場で保存済み。
    let mut attempted = 0usize;
    let mut failures: Vec<(String, String)> = Vec::new();
    tracing::info!(
        run_id = %run_id,
        effect_type = %effect_type,
        total_scenes = total,
        "[post_effect] run_multi_task START"
    );

    for (idx, scene) in scenes.into_iter().enumerate() {
        if runtime.is_aborted(&run_id) {
            tracing::warn!(run_id = %run_id, "[post_effect] aborted by user");
            finish_failure(&runtime, &run_id, "中断されました");
            return;
        }

        let progress = (idx as f32) / (total as f32).max(1.0) * 0.9;
        let msg = format!("{}/{}", idx + 1, total);
        emit_event(
            &runtime,
            "post_effect:progress",
            ProgressEvent {
                run_id: &run_id,
                stage: "calling_ai",
                progress,
                message: Some(&msg),
            },
        );

        // 空シーンは AI に投げない。空本文に指摘は存在しえず、弱いローカル
        // モデルは空入力に対して `{}` 等の degenerate な出力を返しやすい
        // (プロジェクト全体チェック失敗の主要因の一つだった)。
        if scene.scene_text.trim().is_empty() {
            tracing::info!(
                run_id = %run_id,
                idx = idx + 1,
                total = total,
                scene_id = %scene.scene_id,
                "[post_effect] skipping empty scene"
            );
            continue;
        }
        attempted += 1;

        tracing::info!(
            run_id = %run_id,
            idx = idx + 1,
            total = total,
            scene_id = %scene.scene_id,
            scene_text_len = scene.scene_text.chars().count(),
            "[post_effect] processing scene START"
        );
        let scene_start = std::time::Instant::now();

        let result = match effect_type.as_str() {
            "consistency" => {
                process_consistency_scene(
                    &runtime,
                    &ai,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.codex_payload_json,
                    &scene.scene_text,
                    &system_prompt,
                    model_override.as_deref(),
                    &prov,
                    |_p, _s| {},
                )
                .await
            }
            "typo_detection" => {
                process_typo_scene(
                    &runtime,
                    &ai,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    |_p, _s| {},
                )
                .await
            }
            "review" => {
                process_review_scene(
                    &runtime,
                    &ai,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    model_override.as_deref(),
                    &prov,
                    |_p, _s| {},
                )
                .await
            }
            "meta_structure" => {
                process_meta_structure_scene(
                    &runtime,
                    &ai,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    |_p, _s| {},
                )
                .await
            }
            "timeline_consistency" => {
                process_timeline_scene(
                    &runtime,
                    &ai,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    model_override.as_deref(),
                    &prov,
                    |_p, _s| {},
                )
                .await
            }
            "impact_review" => {
                process_impact_review_scene(
                    &runtime,
                    &ai,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.codex_payload_json,
                    &scene.scene_text,
                    &system_prompt,
                    model_override.as_deref(),
                    &prov,
                    |_p, _s| {},
                )
                .await
            }
            _ => {
                process_intra_scene(
                    &runtime,
                    &ai,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    |_p, _s| {},
                )
                .await
            }
        };

        let elapsed_ms = scene_start.elapsed().as_millis();

        match result {
            Ok(n) => {
                tracing::info!(
                    run_id = %run_id,
                    idx = idx + 1,
                    scene_id = %scene.scene_id,
                    annotation_count = n,
                    elapsed_ms = elapsed_ms,
                    "[post_effect] processing scene OK"
                );
                total_count += n;
            }
            Err(e) => {
                tracing::error!(
                    run_id = %run_id,
                    idx = idx + 1,
                    scene_id = %scene.scene_id,
                    elapsed_ms = elapsed_ms,
                    error = %e,
                    "[post_effect] processing scene FAILED (continuing with remaining scenes)"
                );
                failures.push((scene.scene_id.clone(), e.to_string()));
            }
        }
    }

    let outcome = decide_multi_outcome(attempted, &failures);
    // meta_structure の消費者 (Outline オーバーレイの list_scene_lens_for_project)
    // は completed run の lens しか表示しない (SCENE_LENS_FOR_PROJECT_SQL)。
    // 部分失敗を done+summary で「成功分は保存済み」と見せても UI には一切
    // 現れず嘘になるため、meta_structure に限り部分失敗は従来どおり run 失敗
    // (error イベント) に倒す。メッセージには完了/失敗シーン数が残る。
    let outcome = match outcome {
        MultiRunOutcome::CompletedWithFailures(msg) if effect_type == "meta_structure" => {
            MultiRunOutcome::Failed(msg)
        }
        o => o,
    };
    match outcome {
        MultiRunOutcome::Completed => {
            tracing::info!(
                run_id = %run_id,
                total_count = total_count,
                "[post_effect] run_multi_task DONE"
            );
            finish_success(&runtime, &run_id, total_count, None);
        }
        MultiRunOutcome::CompletedWithFailures(summary) => {
            tracing::warn!(
                run_id = %run_id,
                total_count = total_count,
                failed_scenes = failures.len(),
                summary = %summary,
                "[post_effect] run_multi_task DONE with partial failures"
            );
            // DB 上は failed にする: 同一 input_hash が completed キャッシュに
            // 乗ると、失敗シーンが本文未変更のまま二度と再解析されないため。
            // FE には done + summary を渡し「成功分は保存済み・一部失敗」を
            // 警告トーストで見せる (error イベントだと全滅に見えてしまう)。
            finish_partial(&runtime, &run_id, total_count, summary);
        }
        MultiRunOutcome::Failed(message) => {
            tracing::error!(
                run_id = %run_id,
                failed_scenes = failures.len(),
                "[post_effect] run_multi_task FAILED (all scenes)"
            );
            finish_failure(&runtime, &run_id, &message);
        }
    }
}

// ---------------------------------------------------------------------------
// 終端 CAS。abort と worker 完了のうち DB mutex 上で先に running を取った側を
// 正本にし、cancelled を completed / failed で上書きしない。
// ---------------------------------------------------------------------------

const ABORTED_MESSAGE: &str = "中断されました";

#[derive(Debug, PartialEq, Eq)]
enum TerminalClaim {
    Claimed,
    Cancelled,
    Already(String),
    Missing,
}

fn claim_terminal<R: PostEffectRuntime>(
    runtime: &R,
    run_id: &str,
    status: &str,
    error_message: Option<&str>,
) -> Result<TerminalClaim, AppError> {
    runtime.with_db(|db| {
        db.with_conn(|conn| {
            let changed = match status {
                "completed" => conn.execute(
                    "UPDATE post_effect_runs
                        SET status = 'completed', completed_at = datetime('now')
                      WHERE id = ? AND status = 'running'",
                    params![run_id],
                )?,
                "failed" => conn.execute(
                    "UPDATE post_effect_runs
                        SET status = 'failed', error_message = ?, completed_at = datetime('now')
                      WHERE id = ? AND status = 'running'",
                    params![error_message, run_id],
                )?,
                other => anyhow::bail!("unsupported post-effect terminal status: {other}"),
            };
            if changed == 1 {
                return Ok(TerminalClaim::Claimed);
            }

            let current = conn
                .query_row(
                    "SELECT status FROM post_effect_runs WHERE id = ?",
                    params![run_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            Ok(match current.as_deref() {
                Some("cancelled") => TerminalClaim::Cancelled,
                Some(other) => TerminalClaim::Already(other.to_string()),
                None => TerminalClaim::Missing,
            })
        })
    })
}

fn emit_cancelled<R: PostEffectRuntime>(runtime: &R, run_id: &str) {
    emit_event(
        runtime,
        "post_effect:error",
        ErrorEvent {
            run_id,
            error: ABORTED_MESSAGE.to_string(),
        },
    );
}

fn emit_terminal_persistence_error<R: PostEffectRuntime>(
    runtime: &R,
    run_id: &str,
    terminal: &str,
    detail: impl std::fmt::Display,
) {
    emit_event(
        runtime,
        "post_effect:error",
        ErrorEvent {
            run_id,
            error: format!("post-effect の{terminal}状態を永続化できませんでした: {detail}"),
        },
    );
}

fn finish_success<R: PostEffectRuntime>(
    runtime: &R,
    run_id: &str,
    annotation_count: usize,
    summary: Option<String>,
) {
    match claim_terminal(runtime, run_id, "completed", None) {
        Ok(TerminalClaim::Cancelled) => emit_cancelled(runtime, run_id),
        Ok(TerminalClaim::Claimed) => emit_event(
            runtime,
            "post_effect:done",
            DoneEvent {
                run_id,
                annotation_count,
                summary,
            },
        ),
        Ok(other) => {
            tracing::error!(run_id, state = ?other, "post-effect completed without terminal CAS");
            // done は DB completed が正本になったときだけ送る。Missing/Already を
            // 成功扱いすると FE と永続状態が食い違い、再起動後に結果が消える。
            emit_terminal_persistence_error(
                runtime,
                run_id,
                "完了",
                format_args!("terminal CAS result={other:?}"),
            );
        }
        Err(error) => {
            tracing::error!(run_id, error = %error, "post-effect completion CAS failed");
            emit_terminal_persistence_error(runtime, run_id, "完了", error);
        }
    }
}

fn finish_failure<R: PostEffectRuntime>(runtime: &R, run_id: &str, error_message: &str) {
    match claim_terminal(runtime, run_id, "failed", Some(error_message)) {
        Ok(TerminalClaim::Cancelled) => emit_cancelled(runtime, run_id),
        Ok(TerminalClaim::Claimed) => emit_event(
            runtime,
            "post_effect:error",
            ErrorEvent {
                run_id,
                error: error_message.to_string(),
            },
        ),
        Ok(other) => {
            tracing::error!(run_id, state = ?other, "post-effect failed without terminal CAS");
            emit_terminal_persistence_error(
                runtime,
                run_id,
                "失敗",
                format_args!("terminal CAS result={other:?}; original error={error_message}"),
            );
        }
        Err(error) => {
            tracing::error!(run_id, error = %error, "post-effect failure CAS failed");
            emit_terminal_persistence_error(
                runtime,
                run_id,
                "失敗",
                format_args!("{error}; original error={error_message}"),
            );
        }
    }
}

fn finish_partial<R: PostEffectRuntime>(
    runtime: &R,
    run_id: &str,
    annotation_count: usize,
    summary: String,
) {
    match claim_terminal(runtime, run_id, "failed", Some(&summary)) {
        Ok(TerminalClaim::Cancelled) => emit_cancelled(runtime, run_id),
        Ok(TerminalClaim::Claimed) => emit_event(
            runtime,
            "post_effect:done",
            DoneEvent {
                run_id,
                annotation_count,
                summary: Some(summary),
            },
        ),
        Ok(other) => {
            tracing::error!(run_id, state = ?other, "post-effect partial run missed terminal CAS");
            emit_terminal_persistence_error(
                runtime,
                run_id,
                "部分失敗",
                format_args!("terminal CAS result={other:?}; summary={summary}"),
            );
        }
        Err(error) => {
            tracing::error!(run_id, error = %error, "post-effect partial CAS failed");
            emit_terminal_persistence_error(
                runtime,
                run_id,
                "部分失敗",
                format_args!("{error}; summary={summary}"),
            );
        }
    }
}

/// キャッシュ照合と running 行 INSERT の結果。
enum EnsureRunOutcome {
    /// 同一 input_hash の completed run が存在し再利用する（既存 run_id）
    Cached(String),
    /// 新規に running 行を INSERT した（新規 run_id）
    Created(String),
}

/// start_post_effect_run / start_post_effect_run_multi が共有する
/// 「completed run のキャッシュ照合 → ミス時に running 行 INSERT」。
/// SQL 文字列とバインド順序は挙動保存のため元実装から変更していない。
/// run_id の生成はキャッシュミス確定後（ヒット時は生成しない）。
#[allow(clippy::too_many_arguments)]
fn ensure_post_effect_run(
    runtime: &impl PostEffectRuntime,
    project_id: &str,
    effect_type: &str,
    scope_type: &str,
    scope_target_id: Option<&str>,
    model: &str,
    prompt_version: &str,
    input_hash: &str,
) -> Result<EnsureRunOutcome, AppError> {
    if let Some(target_id) = scope_target_id {
        ensure_tree_node_belongs_to_project(runtime, project_id, target_id, "scope_target_id")?;
    }

    let cached_run_id: Option<String> = runtime.with_db(|db| {
        db.with_conn(|conn| {
            let result = conn.query_row(
                "SELECT id FROM post_effect_runs
                  WHERE project_id = ?
                    AND effect_type = ?
                    AND scope_type = ?
                    AND COALESCE(scope_target_id, '') = COALESCE(?, '')
                    AND input_hash = ?
                    AND status = 'completed'
                  ORDER BY started_at DESC
                  LIMIT 1",
                params![
                    project_id,
                    effect_type,
                    scope_type,
                    scope_target_id,
                    input_hash,
                ],
                |row: &rusqlite::Row<'_>| row.get::<_, String>(0),
            );
            Ok(result.ok())
        })
    })?;

    if let Some(existing_id) = cached_run_id {
        return Ok(EnsureRunOutcome::Cached(existing_id));
    }

    // run 行を INSERT (UNIQUE 制約でも重複 running をブロック)
    let run_id = Uuid::new_v4().to_string();

    runtime.with_db(|db| {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO post_effect_runs
                    (id, project_id, effect_type, scope_type, scope_target_id,
                     model, prompt_version, input_hash, status, started_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', datetime('now'))",
                params![
                    run_id,
                    project_id,
                    effect_type,
                    scope_type,
                    scope_target_id,
                    model,
                    prompt_version,
                    input_hash,
                ],
            )?;
            Ok(())
        })
    })?;

    Ok(EnsureRunOutcome::Created(run_id))
}

fn ensure_tree_node_belongs_to_project(
    runtime: &impl PostEffectRuntime,
    project_id: &str,
    node_id: &str,
    field: &str,
) -> Result<(), AppError> {
    let belongs = runtime.with_db(|db| {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT 1 FROM tree_nodes WHERE id = ? AND project_id = ?",
                params![node_id, project_id],
                |_row| Ok(()),
            )
            .optional()
            .map(|value| value.is_some())
            .map_err(anyhow::Error::from)
        })
    })?;
    if !belongs {
        return Err(anyhow::anyhow!(
            "{field} '{node_id}' does not belong to project '{project_id}'"
        )
        .into());
    }
    Ok(())
}

fn ensure_multi_scenes_belong_to_project(
    runtime: &impl PostEffectRuntime,
    project_id: &str,
    scenes: &[ScenePayload],
) -> Result<(), AppError> {
    runtime.with_db(|db| {
        db.with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT 1 FROM tree_nodes WHERE id = ? AND project_id = ?")?;
            for scene in scenes {
                let belongs = stmt
                    .query_row(params![scene.scene_id, project_id], |_row| Ok(()))
                    .optional()?
                    .is_some();
                if !belongs {
                    anyhow::bail!(
                        "scenes[].scene_id '{}' does not belong to project '{}'",
                        scene.scene_id,
                        project_id
                    );
                }
            }
            Ok(())
        })
    })
}

// ---------------------------------------------------------------------------
// Public orchestration API
// ---------------------------------------------------------------------------

pub async fn start_post_effect_run<R, A>(
    runtime: R,
    ai: A,
    args: StartPostEffectRunArgs,
) -> Result<StartPostEffectRunResult, AppError>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    // 単発 run は abort を見ないため中止レジストリには一切触れない。

    let effect_type = args.effect_type.as_str();
    let supported = matches!(
        effect_type,
        "consistency"
            | "intra_scene_consistency"
            | "typo_detection"
            | "intent_drift"
            | "review"
            | "pseudo_comment"
            | "meta_structure"
            | "impact_review"
    );
    if !supported {
        return Err(
            anyhow::anyhow!("effect_type '{}' は Phase 1b では未実装です", effect_type).into(),
        );
    }

    let prompt_version = match effect_type {
        "consistency" => CONSISTENCY_PROMPT_VERSION,
        "typo_detection" => TYPO_PROMPT_VERSION,
        "review" => REVIEW_PROMPT_VERSION,
        "intent_drift" => INTENT_DRIFT_PROMPT_VERSION,
        "pseudo_comment" => PSEUDO_COMMENT_PROMPT_VERSION,
        "meta_structure" => META_STRUCTURE_PROMPT_VERSION,
        "impact_review" => IMPACT_REVIEW_PROMPT_VERSION,
        _ => INTRA_PROMPT_VERSION,
    };
    if args.prompt_version != prompt_version {
        tracing::warn!(
            "prompt_version mismatch: got '{}', expected '{}'",
            args.prompt_version,
            prompt_version
        );
    }

    // cache照合・running INSERT・detached worker を同じ workspace DBへ固定する。
    // pin は switching/no-workspace を fail-closed で拒否する shell adapter の責務。
    let runtime = runtime.pin_database()?;

    // キャッシュチェック + running 行 INSERT (ensure_post_effect_run に集約)
    let run_id = match ensure_post_effect_run(
        &runtime,
        &args.project_id,
        &args.effect_type,
        &args.scope_type,
        args.scope_target_id.as_deref(),
        &args.model,
        &args.prompt_version,
        &args.input_hash,
    )? {
        EnsureRunOutcome::Cached(existing_id) => {
            return Ok(StartPostEffectRunResult {
                run_id: existing_id,
                from_cache: true,
            });
        }
        EnsureRunOutcome::Created(run_id) => run_id,
    };
    // start が run_id を外部へ返す前に binding を公開するため、abort command が
    // workspace switch 後に来ても開始元 DB の running row を CAS できる。
    runtime.bind_abort_database(&run_id);

    // scene_id は scope_target_id から取得 (scope_type='scene' のみ Phase 1b 対応)
    let scene_id = args.scope_target_id.clone().unwrap_or_default();

    let project_id = args.project_id.clone();
    let effect = args.effect_type.clone();
    let codex_json = args.codex_payload_json.clone();
    let scene_text = args.scene_text.clone();
    let system_prompt = args.system_prompt.clone();
    let persona = args.persona.clone();
    let model_override = args.model_override.clone();
    let prov = RoleProviderOverride {
        provider: args.provider_override.clone(),
        api_variant: args.api_variant_override.clone(),
        endpoint_id: args.endpoint_id_override.clone(),
    };
    let rid = run_id.clone();

    tokio::task::spawn(async move {
        let runtime_clone = runtime.clone();
        let rid_clone = rid.clone();
        let join = tokio::task::spawn(async move {
            match effect.as_str() {
                "consistency" => {
                    run_consistency_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        codex_json,
                        scene_text,
                        system_prompt,
                        model_override,
                        prov.clone(),
                    )
                    .await;
                }
                "impact_review" => {
                    run_impact_review_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        codex_json,
                        scene_text,
                        system_prompt,
                        model_override,
                        prov.clone(),
                    )
                    .await;
                }
                "typo_detection" => {
                    run_typo_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                    )
                    .await;
                }
                "review" => {
                    run_review_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        model_override,
                        prov.clone(),
                    )
                    .await;
                }
                "intent_drift" => {
                    run_intent_drift_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        model_override,
                        prov.clone(),
                    )
                    .await;
                }
                "pseudo_comment" => {
                    run_pseudo_comment_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        persona,
                        model_override,
                        prov.clone(),
                    )
                    .await;
                }
                "meta_structure" => {
                    run_meta_structure_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                    )
                    .await;
                }
                _ => {
                    run_intra_task(
                        runtime,
                        ai,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                    )
                    .await;
                }
            }
        })
        .await;
        if let Err(join_err) = join {
            // 内側タスクが panic した場合のフォールバック emit
            // (これがないとフロントの spinner が永遠に止まらない)
            let msg = if join_err.is_panic() {
                format!("post-effect タスクが panic しました: {join_err}")
            } else {
                format!("post-effect タスクが異常終了しました: {join_err}")
            };
            finish_failure(&runtime_clone, &rid_clone, &msg);
        }
        // 単発 run の全終端（run_effect_task 内の done/error、および内側タスクが
        // panic して join が Err のパス）を集約する単一出口。multi 側と同じく
        // ここで clear し、中止要求の run_id が中止レジストリへ永久残留するのを防ぐ
        // （単発 run は abort を観測しないが、要求エントリは掃除する必要がある）。
        runtime_clone.clear_abort(&rid_clone);
    });

    Ok(StartPostEffectRunResult {
        run_id,
        from_cache: false,
    })
}

pub async fn start_post_effect_run_multi<R, A>(
    runtime: R,
    ai: A,
    args: StartPostEffectRunMultiArgs,
) -> Result<StartPostEffectRunResult, AppError>
where
    R: PostEffectRuntime,
    A: PostEffectAiClient,
{
    // 中止要求は run_id 単位。新 run 開始時に集合全体をリセットしない
    // (並走 run の中止要求を握り潰さないため)。clear は run 終端で行う。

    if args.scenes.is_empty() {
        return Err(anyhow::anyhow!("scenes が空です").into());
    }

    let effect_type = args.effect_type.as_str();
    let supported = matches!(
        effect_type,
        "consistency"
            | "intra_scene_consistency"
            | "typo_detection"
            | "review"
            | "meta_structure"
            | "timeline_consistency"
            | "impact_review"
    );
    if !supported {
        return Err(anyhow::anyhow!("effect_type '{}' は未実装です", effect_type).into());
    }

    let runtime = runtime.pin_database()?;

    // XPROJ fail-closed: 1件でも別project / 不明sceneなら、cache照合・running INSERT・
    // AI開始のいずれよりも前に同期rejectする。
    ensure_multi_scenes_belong_to_project(&runtime, &args.project_id, &args.scenes)?;

    // キャッシュチェック + running 行 INSERT (ensure_post_effect_run に集約)
    let run_id = match ensure_post_effect_run(
        &runtime,
        &args.project_id,
        &args.effect_type,
        &args.scope_type,
        args.scope_target_id.as_deref(),
        &args.model,
        &args.prompt_version,
        &args.input_hash,
    )? {
        EnsureRunOutcome::Cached(existing_id) => {
            return Ok(StartPostEffectRunResult {
                run_id: existing_id,
                from_cache: true,
            });
        }
        EnsureRunOutcome::Created(run_id) => run_id,
    };
    runtime.bind_abort_database(&run_id);

    let project_id = args.project_id.clone();
    let effect = args.effect_type.clone();
    let scenes = args.scenes;
    let system_prompt = args.system_prompt.clone();
    let model_override = args.model_override.clone();
    let prov = RoleProviderOverride {
        provider: args.provider_override.clone(),
        api_variant: args.api_variant_override.clone(),
        endpoint_id: args.endpoint_id_override.clone(),
    };
    let rid = run_id.clone();

    tokio::task::spawn(async move {
        let runtime_clone = runtime.clone();
        let rid_clone = rid.clone();
        let join = tokio::task::spawn(async move {
            run_multi_task(
                runtime,
                ai,
                rid,
                project_id,
                effect,
                scenes,
                system_prompt,
                model_override,
                prov,
            )
            .await;
        })
        .await;
        if let Err(join_err) = join {
            let msg = if join_err.is_panic() {
                format!("post-effect multi タスクが panic しました: {join_err}")
            } else {
                format!("post-effect multi タスクが異常終了しました: {join_err}")
            };
            finish_failure(&runtime_clone, &rid_clone, &msg);
        }
        // run の全終端（正常完了 / 部分失敗 / エラー / 中止、および
        // run_multi_task が panic して join が Err のパス）を集約する単一出口。
        // ここで clear すれば run_id が中止レジストリに残り続けるリークを防げる。
        runtime_clone.clear_abort(&rid_clone);
    });

    Ok(StartPostEffectRunResult {
        run_id,
        from_cache: false,
    })
}

pub fn abort_post_effect_run<R: PostEffectRuntime>(
    runtime: &R,
    run_id: &str,
    project_id: &str,
) -> Result<(), AppError> {
    // DB の所有権+running CASが取れたときだけ registry を立てる。これにより
    // cross-project run の停止と、terminal/cache runへのlate abortリークを防ぐ。
    runtime.request_abort_if(run_id, |bound_db| {
        let cancel = |db: &Database| -> Result<bool, AppError> {
            Ok(db.with_conn(|conn| {
                let changed = conn.execute(
                    "UPDATE post_effect_runs
                        SET status = 'cancelled', completed_at = datetime('now')
                      WHERE id = ? AND project_id = ? AND status = 'running'",
                    params![run_id, project_id],
                )?;
                Ok(changed == 1)
            })?)
        };

        match bound_db {
            // start 時に bind 済みなら workspace switch 後も開始元 DB を cancel。
            Some(db) => cancel(db),
            // 移行前/手動seed run は現在 workspace 上で従来どおり照合する。
            None => runtime.with_db(|db| Ok(cancel(db)?)),
        }
    })?;
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod runtime_contract_tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    const PROJECT: &str = "default-project";
    const OTHER_PROJECT: &str = "other-project";

    #[derive(Clone)]
    struct FakeRuntime {
        db: Arc<Database>,
        events: Arc<Mutex<Vec<(String, Value)>>>,
        aborts: PostEffectAbortRegistry,
    }

    impl PostEffectRuntime for FakeRuntime {
        fn pin_database(&self) -> Result<Self, AppError> {
            Ok(self.clone())
        }

        fn pinned_database(&self) -> Option<Arc<Database>> {
            Some(Arc::clone(&self.db))
        }

        fn with_db<T, F>(&self, f: F) -> Result<T, AppError>
        where
            F: FnOnce(&Database) -> anyhow::Result<T>,
        {
            Ok(f(&self.db)?)
        }

        fn emit(&self, channel: &str, payload: Value) {
            self.events
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((channel.to_string(), payload));
        }

        fn abort_registry(&self) -> &PostEffectAbortRegistry {
            &self.aborts
        }
    }

    /// workspace 切替競合を再現する runtime。`active` は shell の現在 workspace、
    /// `pinned` は start が worker 全体へ束縛した DB。command側 clone は None のまま
    /// active B を見る一方、worker側 clone は A を保持する状況を再現できる。
    #[derive(Clone)]
    struct SwitchingRuntime {
        active: Arc<Mutex<Arc<Database>>>,
        pinned: Option<Arc<Database>>,
        events: Arc<Mutex<Vec<(String, Value)>>>,
        aborts: PostEffectAbortRegistry,
    }

    #[derive(Clone)]
    struct FailingRuntime {
        events: Arc<Mutex<Vec<(String, Value)>>>,
        aborts: PostEffectAbortRegistry,
    }

    impl PostEffectRuntime for FailingRuntime {
        fn pin_database(&self) -> Result<Self, AppError> {
            Err(AppError::NoWorkspace)
        }

        fn pinned_database(&self) -> Option<Arc<Database>> {
            None
        }

        fn with_db<T, F>(&self, _f: F) -> Result<T, AppError>
        where
            F: FnOnce(&Database) -> anyhow::Result<T>,
        {
            Err(AppError::NoWorkspace)
        }

        fn emit(&self, channel: &str, payload: Value) {
            self.events
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((channel.to_string(), payload));
        }

        fn abort_registry(&self) -> &PostEffectAbortRegistry {
            &self.aborts
        }
    }

    impl PostEffectRuntime for SwitchingRuntime {
        fn pin_database(&self) -> Result<Self, AppError> {
            let db = Arc::clone(
                &self
                    .active
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
            );
            Ok(Self {
                active: Arc::clone(&self.active),
                pinned: Some(db),
                events: Arc::clone(&self.events),
                aborts: self.aborts.clone(),
            })
        }

        fn pinned_database(&self) -> Option<Arc<Database>> {
            self.pinned.as_ref().map(Arc::clone)
        }

        fn with_db<T, F>(&self, f: F) -> Result<T, AppError>
        where
            F: FnOnce(&Database) -> anyhow::Result<T>,
        {
            let db = match &self.pinned {
                Some(db) => Arc::clone(db),
                None => Arc::clone(
                    &self
                        .active
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()),
                ),
            };
            Ok(f(&db)?)
        }

        fn emit(&self, channel: &str, payload: Value) {
            self.events
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((channel.to_string(), payload));
        }

        fn abort_registry(&self) -> &PostEffectAbortRegistry {
            &self.aborts
        }
    }

    #[derive(Clone, Default)]
    struct FakeAi {
        calls: Arc<AtomicUsize>,
    }

    impl PostEffectAiClient for FakeAi {
        fn call<'a>(
            &'a self,
            _request: PostEffectAiRequest<'a>,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<PostEffectAiOutput>> + Send + 'a>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(PostEffectAiOutput {
                    raw_response: r#"{"findings":[]}"#.to_string(),
                    detected_model: "fake".to_string(),
                })
            })
        }
    }

    #[derive(Clone, Default)]
    struct GatedAi {
        entered: Arc<Notify>,
        release: Arc<Notify>,
    }

    impl PostEffectAiClient for GatedAi {
        fn call<'a>(
            &'a self,
            _request: PostEffectAiRequest<'a>,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<PostEffectAiOutput>> + Send + 'a>> {
            Box::pin(async move {
                self.entered.notify_one();
                self.release.notified().await;
                Ok(PostEffectAiOutput {
                    raw_response: r#"{"findings":[]}"#.to_string(),
                    detected_model: "fake".to_string(),
                })
            })
        }
    }

    fn runtime() -> FakeRuntime {
        let db = seeded_db();
        FakeRuntime {
            db,
            events: Arc::new(Mutex::new(Vec::new())),
            aborts: PostEffectAbortRegistry::new(),
        }
    }

    fn seeded_db() -> Arc<Database> {
        let db = Arc::new(Database::new(Path::new(":memory:")).expect("in-memory db"));
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language, created_at, updated_at)
                 VALUES (?, 'Other', 'ja', datetime('now'), datetime('now'))",
                params![OTHER_PROJECT],
            )?;
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, sort_order, created_at, updated_at)
                 VALUES
                    ('scene-own', ?, 'scene', 'Own', 'a0', datetime('now'), datetime('now')),
                    ('scene-other', ?, 'scene', 'Other', 'a0', datetime('now'), datetime('now'))",
                params![PROJECT, OTHER_PROJECT],
            )?;
            Ok(())
        })
        .expect("seed");
        db
    }

    fn switching_runtime(db: Arc<Database>) -> SwitchingRuntime {
        SwitchingRuntime {
            active: Arc::new(Mutex::new(db)),
            pinned: None,
            events: Arc::new(Mutex::new(Vec::new())),
            aborts: PostEffectAbortRegistry::new(),
        }
    }

    fn single_args(target: &str, input_hash: &str) -> StartPostEffectRunArgs {
        StartPostEffectRunArgs {
            project_id: PROJECT.to_string(),
            effect_type: "review".to_string(),
            scope_type: "scene".to_string(),
            scope_target_id: Some(target.to_string()),
            model: "audit-model".to_string(),
            model_override: None,
            provider_override: None,
            api_variant_override: None,
            endpoint_id_override: None,
            prompt_version: REVIEW_PROMPT_VERSION.to_string(),
            input_hash: input_hash.to_string(),
            codex_payload_json: "[]".to_string(),
            scene_text: "本文".to_string(),
            system_prompt: "review".to_string(),
            persona: None,
        }
    }

    fn multi_args(scene_id: &str) -> StartPostEffectRunMultiArgs {
        StartPostEffectRunMultiArgs {
            project_id: PROJECT.to_string(),
            effect_type: "timeline_consistency".to_string(),
            scope_type: "project".to_string(),
            scope_target_id: None,
            model: "audit-model".to_string(),
            model_override: None,
            provider_override: None,
            api_variant_override: None,
            endpoint_id_override: None,
            prompt_version: "timeline_v1".to_string(),
            input_hash: "multi-hash".to_string(),
            scenes: vec![ScenePayload {
                scene_id: scene_id.to_string(),
                codex_payload_json: "[]".to_string(),
                scene_text: "本文".to_string(),
            }],
            system_prompt: "timeline".to_string(),
        }
    }

    fn insert_run(runtime: &FakeRuntime, id: &str, status: &str, input_hash: &str) {
        runtime
            .with_db(|db| {
                db.with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO post_effect_runs
                            (id, project_id, effect_type, scope_type, scope_target_id,
                             model, prompt_version, input_hash, status, started_at, completed_at)
                         VALUES (?, ?, 'review', 'scene', 'scene-own',
                                 'audit-model', ?, ?, ?, datetime('now'),
                                 CASE WHEN ? = 'running' THEN NULL ELSE datetime('now') END)",
                        params![
                            id,
                            PROJECT,
                            REVIEW_PROMPT_VERSION,
                            input_hash,
                            status,
                            status
                        ],
                    )?;
                    Ok(())
                })
            })
            .expect("insert run");
    }

    fn run_status(runtime: &FakeRuntime, id: &str) -> String {
        runtime
            .with_db(|db| {
                db.with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT status FROM post_effect_runs WHERE id = ?",
                        params![id],
                        |row| row.get(0),
                    )?)
                })
            })
            .expect("run status")
    }

    fn run_count(runtime: &FakeRuntime) -> i64 {
        runtime
            .with_db(|db| {
                db.with_conn(|conn| {
                    Ok(
                        conn.query_row("SELECT COUNT(*) FROM post_effect_runs", [], |row| {
                            row.get(0)
                        })?,
                    )
                })
            })
            .expect("run count")
    }

    fn event_channels(runtime: &FakeRuntime) -> Vec<String> {
        runtime
            .events
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(channel, _)| channel.clone())
            .collect()
    }

    fn db_run_status(db: &Database, run_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT status FROM post_effect_runs WHERE id = ?",
                    params![run_id],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .expect("query run status")
    }

    async fn wait_for_terminal(db: &Database, run_id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if matches!(
                    db_run_status(db, run_id).as_deref(),
                    Some("completed" | "failed" | "cancelled")
                ) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("worker reaches terminal state");
    }

    async fn wait_for_event(runtime: &SwitchingRuntime, channel: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if runtime
                    .events
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .iter()
                    .any(|(actual, _)| actual == channel)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("worker emits terminal event");
    }

    async fn wait_for_abort_clear(runtime: &SwitchingRuntime, run_id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while runtime.is_aborted(run_id) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("worker clears abort state");
    }

    #[tokio::test]
    async fn single_cross_project_target_rejects_before_insert_or_ai() {
        let runtime = runtime();
        let ai = FakeAi::default();
        let error = start_post_effect_run(
            runtime.clone(),
            ai.clone(),
            single_args("scene-other", "xproj"),
        )
        .await
        .expect_err("cross-project target must fail");
        assert!(error.to_string().contains("does not belong to project"));
        assert_eq!(run_count(&runtime), 0);
        assert_eq!(ai.calls.load(Ordering::SeqCst), 0);
        assert!(event_channels(&runtime).is_empty());
    }

    #[tokio::test]
    async fn multi_cross_project_scene_rejects_before_insert_or_ai() {
        let runtime = runtime();
        let ai = FakeAi::default();
        let error =
            start_post_effect_run_multi(runtime.clone(), ai.clone(), multi_args("scene-other"))
                .await
                .expect_err("cross-project scene must fail");
        assert!(error.to_string().contains("does not belong to project"));
        assert_eq!(run_count(&runtime), 0);
        assert_eq!(ai.calls.load(Ordering::SeqCst), 0);
        assert!(event_channels(&runtime).is_empty());
    }

    #[tokio::test]
    async fn completed_cache_hit_does_not_call_ai_or_emit() {
        let runtime = runtime();
        let ai = FakeAi::default();
        insert_run(&runtime, "cached", "completed", "cache-hash");
        let result = start_post_effect_run(
            runtime.clone(),
            ai.clone(),
            single_args("scene-own", "cache-hash"),
        )
        .await
        .expect("cache hit");
        assert!(result.from_cache);
        assert_eq!(result.run_id, "cached");
        assert_eq!(run_count(&runtime), 1);
        assert_eq!(ai.calls.load(Ordering::SeqCst), 0);
        assert!(event_channels(&runtime).is_empty());
    }

    #[tokio::test]
    async fn single_worker_keeps_start_database_after_workspace_switch() {
        let db_a = seeded_db();
        let db_b = seeded_db();
        let runtime = switching_runtime(Arc::clone(&db_a));
        let ai = GatedAi::default();

        let result = start_post_effect_run(
            runtime.clone(),
            ai.clone(),
            single_args("scene-own", "switch-single"),
        )
        .await
        .expect("start on workspace A");
        assert_eq!(
            db_run_status(&db_a, &result.run_id).as_deref(),
            Some("running")
        );

        ai.entered.notified().await;
        *runtime.active.lock().expect("active DB lock") = Arc::clone(&db_b);
        ai.release.notify_one();

        wait_for_terminal(&db_a, &result.run_id).await;
        assert_eq!(
            db_run_status(&db_a, &result.run_id).as_deref(),
            Some("completed"),
            "開始元 A の running 行を必ず終端する"
        );
        assert_eq!(
            db_run_status(&db_b, &result.run_id),
            None,
            "切替先 B へ run/annotation を混入させない"
        );
        assert_eq!(
            runtime
                .events
                .lock()
                .expect("events")
                .iter()
                .filter(|(channel, _)| channel == "post_effect:done")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn multi_worker_keeps_start_database_after_workspace_switch() {
        let db_a = seeded_db();
        let db_b = seeded_db();
        let runtime = switching_runtime(Arc::clone(&db_a));
        let ai = GatedAi::default();
        let mut args = multi_args("scene-own");
        args.effect_type = "review".to_string();
        args.input_hash = "switch-multi".to_string();

        let result = start_post_effect_run_multi(runtime.clone(), ai.clone(), args)
            .await
            .expect("start multi on workspace A");
        assert_eq!(
            db_run_status(&db_a, &result.run_id).as_deref(),
            Some("running")
        );

        ai.entered.notified().await;
        *runtime.active.lock().expect("active DB lock") = Arc::clone(&db_b);
        ai.release.notify_one();

        wait_for_terminal(&db_a, &result.run_id).await;
        assert_eq!(
            db_run_status(&db_a, &result.run_id).as_deref(),
            Some("completed")
        );
        assert_eq!(db_run_status(&db_b, &result.run_id), None);
        assert_eq!(
            runtime
                .events
                .lock()
                .expect("events")
                .iter()
                .filter(|(channel, _)| channel == "post_effect:done")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn abort_after_workspace_switch_cancels_bound_start_database() {
        let db_a = seeded_db();
        let db_b = seeded_db();
        let runtime = switching_runtime(Arc::clone(&db_a));
        let ai = GatedAi::default();

        let result = start_post_effect_run(
            runtime.clone(),
            ai.clone(),
            single_args("scene-own", "switch-abort"),
        )
        .await
        .expect("start on workspace A");
        ai.entered.notified().await;
        *runtime.active.lock().expect("active DB lock") = Arc::clone(&db_b);

        abort_post_effect_run(&runtime, &result.run_id, PROJECT)
            .expect("bound A run can be aborted while B is active");
        assert_eq!(
            db_run_status(&db_a, &result.run_id).as_deref(),
            Some("cancelled")
        );
        assert_eq!(db_run_status(&db_b, &result.run_id), None);
        assert!(runtime.is_aborted(&result.run_id));

        ai.release.notify_one();
        wait_for_event(&runtime, "post_effect:error").await;
        wait_for_abort_clear(&runtime, &result.run_id).await;
        assert!(runtime
            .events
            .lock()
            .expect("events")
            .iter()
            .all(|(channel, _)| channel != "post_effect:done"));
        assert!(
            !runtime.is_aborted(&result.run_id),
            "worker 終端で flag とDB bindingを一緒に解放する"
        );
    }

    #[test]
    fn finish_success_missing_run_emits_persistence_error_not_done() {
        let runtime = runtime();
        finish_success(&runtime, "missing", 2, None);
        let events = runtime.events.lock().expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "post_effect:error");
        assert!(events[0].1["error"]
            .as_str()
            .unwrap_or_default()
            .contains("永続化"));
    }

    #[test]
    fn finish_partial_already_terminal_emits_persistence_error_not_done() {
        let runtime = runtime();
        insert_run(&runtime, "already", "completed", "already-hash");
        finish_partial(&runtime, "already", 1, "partial".to_string());
        let events = runtime.events.lock().expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "post_effect:error");
        assert!(events[0].1["error"]
            .as_str()
            .unwrap_or_default()
            .contains("永続化"));
    }

    #[test]
    fn finish_failure_database_error_reports_persistence_failure() {
        let runtime = FailingRuntime {
            events: Arc::new(Mutex::new(Vec::new())),
            aborts: PostEffectAbortRegistry::new(),
        };
        finish_failure(&runtime, "run", "AI failed");
        let events = runtime.events.lock().expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "post_effect:error");
        let message = events[0].1["error"].as_str().unwrap_or_default();
        assert!(message.contains("永続化"));
        assert!(message.contains("AI failed"));
    }

    #[test]
    fn wrong_project_and_late_abort_do_not_pollute_registry() {
        let runtime = runtime();
        insert_run(&runtime, "running", "running", "running-hash");
        abort_post_effect_run(&runtime, "running", OTHER_PROJECT).expect("wrong project no-op");
        assert!(!runtime.is_aborted("running"));
        assert_eq!(run_status(&runtime, "running"), "running");

        finish_success(&runtime, "running", 0, None);
        abort_post_effect_run(&runtime, "running", PROJECT).expect("late abort no-op");
        assert!(!runtime.is_aborted("running"));
        assert_eq!(run_status(&runtime, "running"), "completed");
    }

    #[test]
    fn abort_wins_terminal_cas_and_cancelled_is_not_overwritten() {
        let runtime = runtime();
        insert_run(&runtime, "abort-wins", "running", "abort-hash");
        abort_post_effect_run(&runtime, "abort-wins", PROJECT).expect("abort");
        assert!(runtime.is_aborted("abort-wins"));
        finish_success(&runtime, "abort-wins", 3, None);
        assert_eq!(run_status(&runtime, "abort-wins"), "cancelled");
        assert_eq!(event_channels(&runtime), vec!["post_effect:error"]);
        let payload = runtime.events.lock().unwrap();
        assert_eq!(payload[0].1["error"], ABORTED_MESSAGE);
    }

    #[test]
    fn finalize_wins_terminal_cas_and_late_abort_is_noop() {
        let runtime = runtime();
        insert_run(&runtime, "finish-wins", "running", "finish-hash");
        finish_success(&runtime, "finish-wins", 2, None);
        assert_eq!(run_status(&runtime, "finish-wins"), "completed");
        abort_post_effect_run(&runtime, "finish-wins", PROJECT).expect("late abort");
        assert!(!runtime.is_aborted("finish-wins"));
        assert_eq!(run_status(&runtime, "finish-wins"), "completed");
        assert_eq!(event_channels(&runtime), vec!["post_effect:done"]);
    }
}
