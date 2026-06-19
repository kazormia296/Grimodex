//! PostEffects Tauri コマンド群。
//! 設計書: docs/Grimodex_PostEffects設計書.md
//!
//! 実行フロー:
//!   start_post_effect_run → 即 run_id 返却 (fire-and-forget)
//!     → tokio::spawn で run_consistency_task / run_intra_task を実行
//!     → post_effect:progress / :partial / :done / :error イベントを emit

use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use super::ai::resolve_api_key;
use super::PostEffectAbortFlag;
use super::{AiSettingsPath, AppError, WorkspaceState};
use crate::ai::{call_post_effect_api, read_ai_settings};

// ---------------------------------------------------------------------------
// プロンプトバージョン定数 — FE 側 (consistencyPayloadBuilder.ts /
// typoPayloadBuilder.ts) と必ず同値であること。プロンプト本文の変更時は
// 両側を同期して bump し、cache key が新しい input_hash と再計算される。
// ---------------------------------------------------------------------------

const CONSISTENCY_PROMPT_VERSION: &str = "consistency_v1.1";
const INTRA_PROMPT_VERSION: &str = "intra_scene_consistency_v1.0";
// impact_review (影響度レビュー): 変更された Codex 設定 (old→new) に対し本文中の
// 矛盾箇所を指摘する。FE 側 (consistencyPayloadBuilder.ts) と必ず同値であること。
const IMPACT_REVIEW_PROMPT_VERSION: &str = "impact_review_v1.0";
const TYPO_PROMPT_VERSION: &str = "typo_detection_v1.0";
const REVIEW_PROMPT_VERSION: &str = "review_v1.0";
const INTENT_DRIFT_PROMPT_VERSION: &str = "intent_drift_v1.0";
// timeline_consistency は multi (folder/project) スコープ専用。multi コマンドは
// prompt_version を検証しない (TS が timelinePayloadBuilder で権威を持つ) ため、
// Rust 側に prompt_version const は持たない。
// v2.0: ペルソナを bare label から genre/想定読者プロフィールを織り込んだ
// brief 注入へ刷新 (TS pseudoCommentPayloadBuilder と同期)。
const PSEUDO_COMMENT_PROMPT_VERSION: &str = "pseudo_comment_v2.0";
const META_STRUCTURE_PROMPT_VERSION: &str = "meta_structure_v1.1";

// システムプロンプト本文は FE catalog (src/prompts/ja/postEffect.ts) で管理し、
// `StartPostEffectRunArgs.system_prompt` として IPC 経由で渡される。
// AUDIT POINT: cache_control は Codex prefix と Scene の境界に正確に挿入される。
// call_post_effect_api がこの前提でキャッシュ境界を制御する。

// ---------------------------------------------------------------------------
// Input / Output 型
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct StartPostEffectRunArgs {
    project_id: String,
    effect_type: String,
    scope_type: String,
    scope_target_id: Option<String>,
    model: String,
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

#[derive(Serialize)]
pub(crate) struct StartPostEffectRunResult {
    run_id: String,
    from_cache: bool,
}

// ---------------------------------------------------------------------------
// Multi-scene run types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub(crate) struct ScenePayload {
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
}

#[derive(Deserialize)]
pub(crate) struct StartPostEffectRunMultiArgs {
    project_id: String,
    effect_type: String,
    scope_type: String,
    scope_target_id: Option<String>,
    model: String,
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
fn extract_array_field(parsed: &Value, key: &str) -> anyhow::Result<Vec<Value>> {
    if !parsed.is_object() {
        anyhow::bail!(
            "LLM 出力のルートが Object ではありません (root={})",
            value_type_name(parsed)
        );
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
/// 1) ```json ... ``` / ``` ... ``` で囲まれた最初のブロックを優先
/// 2) なければ最初の `{` から最後の `}` までを返す（前置き文対策）
/// 3) どちらでもなければ trim 済み全文を返す
fn extract_json(raw: &str) -> &str {
    let trimmed = raw.trim();

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

#[cfg(test)]
mod extract_json_tests {
    use super::extract_json;

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
    use super::find_text_position;

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
    use super::is_annotation_previously_closed;
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

    fn insert(conn: &Connection, id: &str, status: &str, category: &str, metadata: &str) {
        conn.execute(
            "INSERT INTO post_effect_annotations
                (id, category, status, metadata, content, author_role)
             VALUES (?, ?, ?, ?, '', 'ai')",
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
            "typo_anchor",
            &["K1"]
        ));
        assert!(!is_annotation_previously_closed(
            &conn,
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
            "typo_anchor",
            &["K1"]
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
            "consistency_anchor",
            &["LEGACY1", "NEW1"]
        ));
    }

    #[test]
    fn empty_keys_returns_false() {
        let conn = open_db();
        assert!(!is_annotation_previously_closed(&conn, "typo_anchor", &[]));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod reply_to_annotation_tests {
    use super::{reply_to_annotation_inner, ReplyToAnnotationArgs};
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

    /// 親 (pseudo_comment / open) を継承対象の 4 列込みで INSERT する。
    /// persona は `Option` で渡し、NULL ケースもカバーできるようにする。
    fn insert_parent(
        conn: &Connection,
        id: &str,
        project_id: &str,
        scene_id: Option<&str>,
        run_id: Option<&str>,
        persona: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO post_effect_annotations
                (id, project_id, scene_id, run_id, anchor_type,
                 category, persona, content, author_role, status, metadata)
             VALUES (?, ?, ?, ?, 'scene_range',
                     'pseudo_comment', ?, 'parent body', 'ai', 'open', '{}')",
            params![id, project_id, scene_id, run_id, persona],
        )
        .unwrap();
    }

    fn args(parent_id: &str, content: &str, author_role: &str) -> ReplyToAnnotationArgs {
        // 既存テストは親と同一プロジェクトを前提 (proj-1 / proj)。XPROJ ガードの
        // 不一致ケースは args_in() で別途検証する。
        args_in(parent_id, content, author_role, "proj-1")
    }

    fn args_in(
        parent_id: &str,
        content: &str,
        author_role: &str,
        project_id: &str,
    ) -> ReplyToAnnotationArgs {
        ReplyToAnnotationArgs {
            parent_id: parent_id.to_string(),
            content: content.to_string(),
            author_role: author_role.to_string(),
            project_id: project_id.to_string(),
        }
    }

    // ---- (a) inheritance ----

    #[test]
    fn inherits_parent_fields() {
        let conn = open_db();
        insert_parent(
            &conn,
            "parent-1",
            "proj-1",
            Some("scene-7"),
            Some("run-9"),
            Some("校閲者A"),
        );

        let child =
            reply_to_annotation_inner(&conn, &args("parent-1", "返信本文", "user")).unwrap();

        // Uuid はランダムなので返り値から child id を読み戻す
        let child_id = child["id"].as_str().unwrap();
        assert_ne!(child_id, "parent-1");

        // 4 つの継承フィールドが親と一致
        assert_eq!(child["projectId"].as_str(), Some("proj-1"));
        assert_eq!(child["sceneId"].as_str(), Some("scene-7"));
        assert_eq!(child["runId"].as_str(), Some("run-9"));
        assert_eq!(child["persona"].as_str(), Some("校閲者A"));

        // 親子リンク・固定値
        assert_eq!(child["parentId"].as_str(), Some("parent-1"));
        assert_eq!(child["status"].as_str(), Some("open"));
        assert_eq!(child["category"].as_str(), Some("pseudo_comment"));
        assert_eq!(child["content"].as_str(), Some("返信本文"));
        assert_eq!(child["authorRole"].as_str(), Some("user"));

        // metadata.persona も親 persona を反映
        assert_eq!(child["metadata"]["persona"].as_str(), Some("校閲者A"));
    }

    // ---- (b) author_role fallback ----

    fn author_role_for(input: &str) -> String {
        let conn = open_db();
        insert_parent(&conn, "p", "proj-1", Some("s"), Some("r"), Some("persona"));
        let child = reply_to_annotation_inner(&conn, &args("p", "c", input)).unwrap();
        child["authorRole"].as_str().unwrap().to_string()
    }

    #[test]
    fn author_role_known_values_pass_through() {
        assert_eq!(author_role_for("user"), "user");
        assert_eq!(author_role_for("ai"), "ai");
        assert_eq!(author_role_for("system"), "system");
    }

    #[test]
    fn author_role_unknown_falls_back_to_user() {
        assert_eq!(author_role_for("garbage"), "user");
        assert_eq!(author_role_for(""), "user");
    }

    // ---- (c) NULL persona ----

    #[test]
    fn null_persona_parent_yields_null_child_persona() {
        let conn = open_db();
        insert_parent(&conn, "p", "proj-1", Some("s"), Some("r"), None);

        let child = reply_to_annotation_inner(&conn, &args("p", "c", "user")).unwrap();

        assert!(child["persona"].is_null());
        assert!(child["metadata"]["persona"].is_null());
    }

    // ---- (d) XPROJ guard: 別プロジェクトの parent_id では返信できない ----

    #[test]
    fn rejects_reply_to_parent_in_another_project() {
        let conn = open_db();
        insert_parent(&conn, "p", "proj-A", Some("s"), Some("r"), None);

        // proj-B から proj-A の親へ返信を試みる → 親 lookup が 0 行で Err
        let res = reply_to_annotation_inner(&conn, &args_in("p", "侵入", "user", "proj-B"));
        assert!(res.is_err(), "cross-project reply must be rejected");

        // 子 annotation が作られていないこと
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM post_effect_annotations WHERE parent_id = 'p'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "no child row may be inserted on rejection");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod xproj_scope_tests {
    use super::{update_annotation_status_inner, update_relation_status_inner};
    use rusqlite::{params, Connection};

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE post_effect_annotations (
                id TEXT PRIMARY KEY, project_id TEXT, run_id TEXT, anchor_type TEXT,
                scene_id TEXT, range_start INTEGER, range_end INTEGER, text_snapshot TEXT,
                category TEXT NOT NULL, persona TEXT, severity TEXT, content TEXT,
                author_role TEXT, parent_id TEXT, status TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT
            );
            CREATE TABLE post_effect_annotation_relations (
                id TEXT PRIMARY KEY, project_id TEXT, run_id TEXT,
                annotation_a_id TEXT NOT NULL, annotation_b_id TEXT NOT NULL,
                relation_type TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'bidirectional',
                description TEXT, status TEXT NOT NULL DEFAULT 'open',
                metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT
            );",
        )
        .unwrap();
        conn
    }

    fn insert_ann(conn: &Connection, id: &str, project_id: &str) {
        // anchor_type / created_at / updated_at は row_to_annotation_value が
        // 非 Option で読むため必ず埋める (read-back を成立させる)。
        conn.execute(
            "INSERT INTO post_effect_annotations
                (id, project_id, anchor_type, category, content, author_role,
                 status, metadata, created_at, updated_at)
             VALUES (?, ?, 'scene_range', 'consistency_anchor', 'c', 'ai',
                     'open', '{}', '2024-01-01', '2024-01-01')",
            params![id, project_id],
        )
        .unwrap();
    }

    fn status_of(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT status FROM post_effect_annotations WHERE id = ?",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn update_annotation_status_rejects_other_project() {
        let conn = open_db();
        insert_ann(&conn, "a1", "proj-A");

        // 別プロジェクトからの更新は弾かれ、状態は変わらない
        let res = update_annotation_status_inner(&conn, "a1", "dismissed", "proj-B");
        assert!(res.is_err(), "cross-project update must be rejected");
        assert_eq!(status_of(&conn, "a1"), "open");

        // 同一プロジェクトなら更新できる
        let ok = update_annotation_status_inner(&conn, "a1", "dismissed", "proj-A");
        assert!(ok.is_ok());
        assert_eq!(status_of(&conn, "a1"), "dismissed");
    }

    #[test]
    fn update_relation_status_rejects_other_project_and_scopes_cascade() {
        let conn = open_db();
        insert_ann(&conn, "a1", "proj-A");
        insert_ann(&conn, "a2", "proj-A");
        conn.execute(
            "INSERT INTO post_effect_annotation_relations
                (id, project_id, annotation_a_id, annotation_b_id, relation_type,
                 status, metadata, created_at)
             VALUES ('rel1', 'proj-A', 'a1', 'a2', 'contradiction',
                     'open', '{}', '2024-01-01')",
            [],
        )
        .unwrap();

        // 別プロジェクトからは弾かれ、relation も両端 annotation も変わらない
        let res = update_relation_status_inner(&conn, "rel1", "dismissed", "proj-B");
        assert!(res.is_err());
        assert_eq!(status_of(&conn, "a1"), "open");
        assert_eq!(status_of(&conn, "a2"), "open");

        // 同一プロジェクトなら relation + 両端 annotation がカスケード
        let ok = update_relation_status_inner(&conn, "rel1", "dismissed", "proj-A");
        assert!(ok.is_ok());
        assert_eq!(status_of(&conn, "a1"), "dismissed");
        assert_eq!(status_of(&conn, "a2"), "dismissed");
    }
}

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
/// `found_text` を locate する。文字単位のオフセットを返す。
/// 失敗時は `None` (orphaned annotation として扱う)。
///
/// `found_text` が複数箇所に出現する場合は、各位置の周辺と `found_context`
/// の一致度 (trigram 重なり + 完全包含ボーナス) をスコアリングして
/// 最良の位置を選ぶ。これは「同じ表現が複数箇所にあるが LLM は特定の
/// 1 箇所を指摘している」ケースで誤位置に annotation が貼られる事故を防ぐ。
fn find_text_position(
    scene_text: &str,
    found_text: &str,
    found_context: &str,
) -> Option<(usize, usize)> {
    let norm_scene = normalize_ws(scene_text);
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

    // 単一出現 or context なし: 最初 (=唯一) の位置を返す
    if occurrences.len() == 1 || norm_ctx.is_empty() {
        let pos = occurrences[0];
        return Some((pos, pos + norm_ft.len()));
    }

    // 複数出現: 周辺ウィンドウと context の一致度でスコアリングし最良を選ぶ
    let best_pos = occurrences
        .iter()
        .copied()
        .max_by_key(|&pos| {
            let window = scene_window_around(&norm_scene, pos, norm_ft.len(), norm_ctx.len());
            score_context_match(window, &norm_ctx)
        })
        .unwrap_or(occurrences[0]);

    Some((best_pos, best_pos + norm_ft.len()))
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
    category: &str,
    dismiss_keys: &[&str],
) -> bool {
    if dismiss_keys.is_empty() {
        return false;
    }
    let placeholders = std::iter::repeat_n("?", dismiss_keys.len())
        .collect::<Vec<_>>()
        .join(", ");
    // category は呼び出し側が文字列リテラルで指定する (ユーザー入力ではない)
    let sql = format!(
        "SELECT 1 FROM post_effect_annotations
           WHERE category = ?1
             AND status IN ('dismissed', 'resolved')
             AND (json_extract(metadata, '$.dismiss_key')            IN ({placeholders})
                  OR json_extract(metadata, '$.codex_ref.dismiss_key') IN ({placeholders})
                  OR json_extract(metadata, '$.typo_ref.dismiss_key')  IN ({placeholders}))
           LIMIT 1"
    );
    // params: [category, keys..., keys..., keys...]
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(1 + dismiss_keys.len() * 3);
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
async fn process_consistency_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    codex_payload_json: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        codex_bytes = codex_payload_json.len(),
        scene_chars = scene_text.chars().count(),
        "[post_effect] consistency: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let raw_response = call_post_effect_api(
        &ai_settings,
        &api_key,
        system_prompt,
        Some(codex_payload_json),
        scene_text,
    )
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
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let save_start = std::time::Instant::now();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

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
                    "consistency_anchor",
                    &[&dismiss_key, &legacy_dismiss_key],
                ) {
                    continue;
                }

                let (range_start, range_end, orphaned) =
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };

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
                        "detected_by_model": ai_settings.model,
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
                            found_text,
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
                            found_text,
                            severity,
                            content,
                            metadata.to_string(),
                        ],
                    )?;
                    new_id
                };

                let _ = app.emit(
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
async fn run_effect_task<F, Fut>(app: AppHandle, run_id: String, process: F)
where
    F: FnOnce(AppHandle, String) -> Fut,
    Fut: std::future::Future<Output = Result<usize, anyhow::Error>>,
{
    let _ = app.emit(
        "post_effect:progress",
        ProgressEvent {
            run_id: &run_id,
            stage: "calling_ai",
            progress: 0.1,
            message: None,
        },
    );

    match process(app.clone(), run_id.clone()).await {
        Ok(n) => {
            finalize_run(&app, &run_id);
            let _ = app.emit(
                "post_effect:done",
                DoneEvent {
                    run_id: &run_id,
                    annotation_count: n,
                    summary: None,
                },
            );
        }
        Err(e) => {
            let _ = app.emit(
                "post_effect:error",
                ErrorEvent {
                    run_id: &run_id,
                    error: e.to_string(),
                },
            );
            fail_run(&app, &run_id, &e.to_string());
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_consistency_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_consistency_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &codex_payload_json,
            &scene_text,
            &system_prompt,
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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
async fn process_intra_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        scene_chars = scene_text.chars().count(),
        "[post_effect] intra: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let raw_response =
        call_post_effect_api(&ai_settings, &api_key, system_prompt, None, scene_text)
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
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        elapsed_ms = ai_start.elapsed().as_millis(),
        raw_bytes = raw_response.len(),
        "[post_effect] intra: AI response received"
    );

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

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
                    "consistency_anchor",
                    &[&dismiss_key, &legacy_dismiss_key],
                ) {
                    continue;
                }

                let (a_start, a_end, a_orphaned) =
                    match find_text_position(scene_text, a_text, a_ctx) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };
                let (b_start, b_end, b_orphaned) =
                    match find_text_position(scene_text, b_text, b_ctx) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };

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
                    "detected_by_model": ai_settings.model,
                });
                let meta_b = serde_json::json!({
                    "confidence": confidence,
                    "llm_reason": reason,
                    "found_text": b_text,
                    "found_context": b_ctx,
                    "dismiss_key": dismiss_key,
                    "orphaned": b_orphaned,
                    "detected_by_model": ai_settings.model,
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
                        a_text,
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
                        b_text,
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

                let _ = app.emit(
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

async fn run_intra_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_intra_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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
async fn process_typo_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        scene_chars = scene_text.chars().count(),
        "[post_effect] typo: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let raw_response =
        call_post_effect_api(&ai_settings, &api_key, system_prompt, None, scene_text)
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
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        elapsed_ms = ai_start.elapsed().as_millis(),
        raw_bytes = raw_response.len(),
        "[post_effect] typo: AI response received"
    );

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

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
                if is_annotation_previously_closed(conn, "typo_anchor", &[&dismiss_key]) {
                    continue;
                }

                let (range_start, range_end, orphaned) =
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };

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
                        "detected_by_model": ai_settings.model,
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
                        found_text,
                        severity,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                let _ = app.emit(
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

async fn run_typo_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_typo_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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
async fn process_review_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        scene_chars = scene_text.chars().count(),
        "[post_effect] review: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let raw_response =
        call_post_effect_api(&ai_settings, &api_key, system_prompt, None, scene_text)
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

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

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
                if is_annotation_previously_closed(conn, "review", &[&dismiss_key]) {
                    continue;
                }

                // found_text が空なら scene 全体所見 (位置特定なし = orphaned)
                let (range_start, range_end, orphaned) = if found_text.is_empty() {
                    (0i64, 0i64, true)
                } else {
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    }
                };

                let new_id = Uuid::new_v4().to_string();
                let content = if title.is_empty() { reason } else { title };
                let metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "llm_reason": reason,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": ai_settings.model,
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
                        if found_text.is_empty() {
                            None
                        } else {
                            Some(found_text)
                        },
                        severity,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                let _ = app.emit(
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
async fn process_intent_drift_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        scene_chars = scene_text.chars().count(),
        "[post_effect] intent_drift: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let raw_response =
        call_post_effect_api(&ai_settings, &api_key, system_prompt, None, scene_text)
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

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

            for finding in &deduped {
                let title = finding["title"].as_str().unwrap_or("");
                let note = finding["note"].as_str().unwrap_or("");
                let relation = finding["relation"].as_str().unwrap_or("ambiguous");
                let found_text = finding["found_text"].as_str().unwrap_or("");
                let found_context = finding["found_context"].as_str().unwrap_or("");

                let dismiss_key = dismiss_key_intent_drift(scene_id, title, found_text);
                if is_annotation_previously_closed(conn, "intent_anchor", &[&dismiss_key]) {
                    continue;
                }

                let (range_start, range_end, orphaned) = if found_text.is_empty() {
                    (0i64, 0i64, true)
                } else {
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    }
                };

                let new_id = Uuid::new_v4().to_string();
                let content = if title.is_empty() { note } else { title };
                let metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "llm_reason": note,
                    "relation": relation,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": ai_settings.model,
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
                        if found_text.is_empty() {
                            None
                        } else {
                            Some(found_text)
                        },
                        content,
                        metadata.to_string(),
                    ],
                )?;

                let _ = app.emit(
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

async fn run_intent_drift_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_intent_drift_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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
async fn process_timeline_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        scene_chars = scene_text.chars().count(),
        "[post_effect] timeline_consistency: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let raw_response =
        call_post_effect_api(&ai_settings, &api_key, system_prompt, None, scene_text)
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

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

            for finding in &deduped {
                let title = finding["title"].as_str().unwrap_or("");
                let note = finding["note"].as_str().unwrap_or("");
                let relation = finding["relation"].as_str().unwrap_or("ambiguous");
                let found_text = finding["found_text"].as_str().unwrap_or("");
                let found_context = finding["found_context"].as_str().unwrap_or("");

                let dismiss_key = dismiss_key_timeline(scene_id, title, found_text);
                if is_annotation_previously_closed(conn, "timeline_anchor", &[&dismiss_key]) {
                    continue;
                }

                let (range_start, range_end, orphaned) = if found_text.is_empty() {
                    (0i64, 0i64, true)
                } else {
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    }
                };

                let new_id = Uuid::new_v4().to_string();
                let content = if title.is_empty() { note } else { title };
                let mut metadata = serde_json::json!({
                    "dismiss_key": dismiss_key,
                    "llm_reason": note,
                    "relation": relation,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": ai_settings.model,
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
                        if found_text.is_empty() {
                            None
                        } else {
                            Some(found_text)
                        },
                        content,
                        metadata.to_string(),
                    ],
                )?;

                let _ = app.emit(
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
async fn process_impact_review_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    codex_payload_json: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

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
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        change_id = change_id,
        entry_id = entry_id,
        codex_bytes = codex_payload_json.len(),
        scene_chars = scene_text.chars().count(),
        "[post_effect] impact_review: calling AI"
    );
    let ai_start = std::time::Instant::now();
    let raw_response = call_post_effect_api(
        &ai_settings,
        &api_key,
        system_prompt,
        Some(codex_payload_json),
        scene_text,
    )
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
    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        elapsed_ms = ai_start.elapsed().as_millis(),
        raw_bytes = raw_response.len(),
        "[post_effect] impact_review: AI response received"
    );

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            raw_preview = %&raw_response.chars().take(200).collect::<String>(),
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

            for judgment in &deduped {
                let found_text = judgment["found_text"].as_str().unwrap_or("");
                let found_context = judgment["found_context"].as_str().unwrap_or("");
                let confidence = judgment["confidence"].as_str().unwrap_or("medium");
                let reason = judgment["reason"].as_str().unwrap_or("");
                let contradiction_score = judgment["contradiction_score"].as_f64().unwrap_or(0.0);

                let dismiss_key = dismiss_key_impact_review(scene_id, change_id, found_text);
                // brand-new カテゴリのため legacy 後方互換 key は不要 (single key path)。
                if is_annotation_previously_closed(conn, "impact_review_anchor", &[&dismiss_key]) {
                    continue;
                }

                let (range_start, range_end, orphaned) =
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    };

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
                        "detected_by_model": ai_settings.model,
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
                        found_text,
                        severity,
                        content,
                        metadata.to_string(),
                    ],
                )?;

                let _ = app.emit(
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
async fn run_impact_review_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    codex_payload_json: String,
    scene_text: String,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_impact_review_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &codex_payload_json,
            &scene_text,
            &system_prompt,
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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

async fn run_review_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_review_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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
async fn process_pseudo_comment_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    persona: Option<&str>,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        provider = %ai_settings.provider,
        model = %ai_settings.model,
        persona = persona.unwrap_or(""),
        "[post_effect] pseudo_comment: calling AI"
    );
    let raw_response =
        call_post_effect_api(&ai_settings, &api_key, system_prompt, None, scene_text)
            .await
            .map_err(|e| anyhow::anyhow!("AI 呼び出し失敗: {e}"))?;

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
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
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut count = 0usize;

            for comment in &deduped {
                let body = comment["content"].as_str().unwrap_or("");
                let found_text = comment["found_text"].as_str().unwrap_or("");
                let found_context = comment["found_context"].as_str().unwrap_or("");

                let (range_start, range_end, orphaned) = if found_text.is_empty() {
                    (0i64, 0i64, true)
                } else {
                    match find_text_position(scene_text, found_text, found_context) {
                        Some((s, e)) => (s as i64, e as i64, false),
                        None => (0i64, 0i64, true),
                    }
                };

                let new_id = Uuid::new_v4().to_string();
                let metadata = serde_json::json!({
                    "persona": persona,
                    "found_text": found_text,
                    "found_context": found_context,
                    "detected_by_model": ai_settings.model,
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
                        if found_text.is_empty() {
                            None
                        } else {
                            Some(found_text)
                        },
                        persona,
                        body,
                        metadata.to_string(),
                    ],
                )?;

                let _ = app.emit(
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
async fn run_pseudo_comment_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    persona: Option<String>,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_pseudo_comment_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            persona.as_deref(),
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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
async fn process_meta_structure_scene(
    app: &AppHandle,
    run_id: &str,
    project_id: &str,
    scene_id: &str,
    scene_text: &str,
    system_prompt: &str,
    ai_settings_path: &std::path::Path,
    on_stage: impl Fn(f32, &str) + Send,
) -> Result<usize, anyhow::Error> {
    let ai_settings = read_ai_settings(ai_settings_path);
    // キー要否はプロバイダ依存 (Ollama/Cli は不要、OpenaiCompatible は任意) —
    // チャット経路と同じ resolve_api_key に判定を一元化する。
    let api_key = resolve_api_key(&ai_settings.provider)?;

    tracing::info!(
        run_id = run_id,
        scene_id = scene_id,
        model = %ai_settings.model,
        "[post_effect] meta_structure: calling AI"
    );
    let raw_response =
        call_post_effect_api(&ai_settings, &api_key, system_prompt, None, scene_text)
            .await
            .map_err(|e| anyhow::anyhow!("AI 呼び出し失敗: {e}"))?;

    on_stage(0.5, "parsing");
    let json_str = extract_json(&raw_response);
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        tracing::error!(
            run_id = run_id,
            scene_id = scene_id,
            extracted_preview = %&json_str.chars().take(200).collect::<String>(),
            error = %e,
            "[post_effect] meta_structure: JSON parse FAILED"
        );
        anyhow::anyhow!("LLM 出力のパース失敗: {e}")
    })?;

    let lenses = extract_array_field(&parsed, "lenses")
        .map_err(|e| anyhow::anyhow!("LLM 出力の構造が不正: {e}"))?;

    on_stage(0.7, "saving");
    let ws_state = app.state::<WorkspaceState>();
    let count: usize = super::with_db(&ws_state, |db| {
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

async fn run_meta_structure_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    scene_id: String,
    scene_text: String,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    run_effect_task(app, run_id, |app, run_id| async move {
        process_meta_structure_scene(
            &app,
            &run_id,
            &project_id,
            &scene_id,
            &scene_text,
            &system_prompt,
            &ai_settings_path,
            |p, s| {
                let _ = app.emit(
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

async fn run_multi_task(
    app: AppHandle,
    run_id: String,
    project_id: String,
    effect_type: String,
    scenes: Vec<ScenePayload>,
    system_prompt: String,
    ai_settings_path: std::path::PathBuf,
) {
    let abort_flag = app.state::<PostEffectAbortFlag>();
    let total = scenes.len();
    let mut total_count = 0usize;
    tracing::info!(
        run_id = %run_id,
        effect_type = %effect_type,
        total_scenes = total,
        "[post_effect] run_multi_task START"
    );

    for (idx, scene) in scenes.into_iter().enumerate() {
        if abort_flag.flag.load(std::sync::atomic::Ordering::Relaxed) {
            tracing::warn!(run_id = %run_id, "[post_effect] aborted by user");
            fail_run(&app, &run_id, "中断されました");
            let _ = app.emit(
                "post_effect:error",
                ErrorEvent {
                    run_id: &run_id,
                    error: "中断されました".to_string(),
                },
            );
            return;
        }

        let progress = (idx as f32) / (total as f32).max(1.0) * 0.9;
        let msg = format!("{}/{}", idx + 1, total);
        let _ = app.emit(
            "post_effect:progress",
            ProgressEvent {
                run_id: &run_id,
                stage: "calling_ai",
                progress,
                message: Some(&msg),
            },
        );

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
                    &app,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.codex_payload_json,
                    &scene.scene_text,
                    &system_prompt,
                    &ai_settings_path,
                    |_p, _s| {},
                )
                .await
            }
            "typo_detection" => {
                process_typo_scene(
                    &app,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    &ai_settings_path,
                    |_p, _s| {},
                )
                .await
            }
            "review" => {
                process_review_scene(
                    &app,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    &ai_settings_path,
                    |_p, _s| {},
                )
                .await
            }
            "meta_structure" => {
                process_meta_structure_scene(
                    &app,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    &ai_settings_path,
                    |_p, _s| {},
                )
                .await
            }
            "timeline_consistency" => {
                process_timeline_scene(
                    &app,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    &ai_settings_path,
                    |_p, _s| {},
                )
                .await
            }
            "impact_review" => {
                process_impact_review_scene(
                    &app,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.codex_payload_json,
                    &scene.scene_text,
                    &system_prompt,
                    &ai_settings_path,
                    |_p, _s| {},
                )
                .await
            }
            _ => {
                process_intra_scene(
                    &app,
                    &run_id,
                    &project_id,
                    &scene.scene_id,
                    &scene.scene_text,
                    &system_prompt,
                    &ai_settings_path,
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
                    "[post_effect] processing scene FAILED"
                );
                let _ = app.emit(
                    "post_effect:error",
                    ErrorEvent {
                        run_id: &run_id,
                        error: e.to_string(),
                    },
                );
                fail_run(&app, &run_id, &e.to_string());
                return;
            }
        }
    }

    tracing::info!(
        run_id = %run_id,
        total_count = total_count,
        "[post_effect] run_multi_task DONE"
    );
    finalize_run(&app, &run_id);
    let _ = app.emit(
        "post_effect:done",
        DoneEvent {
            run_id: &run_id,
            annotation_count: total_count,
            summary: None,
        },
    );
}

// ---------------------------------------------------------------------------
// ヘルパー: run を failed に落とす
// ---------------------------------------------------------------------------

fn fail_run(app: &AppHandle, run_id: &str, error_message: &str) {
    let ws_state = app.state::<WorkspaceState>();
    let _ = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE post_effect_runs
                    SET status = 'failed', error_message = ?, completed_at = datetime('now')
                  WHERE id = ?",
                params![error_message, run_id],
            )?;
            Ok(())
        })
    });
}

fn finalize_run(app: &AppHandle, run_id: &str) {
    let ws_state = app.state::<WorkspaceState>();
    let _ = super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE post_effect_runs
                    SET status = 'completed', completed_at = datetime('now')
                  WHERE id = ?",
                params![run_id],
            )?;
            Ok(())
        })
    });
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
    ws_state: &State<'_, WorkspaceState>,
    project_id: &str,
    effect_type: &str,
    scope_type: &str,
    scope_target_id: Option<&str>,
    model: &str,
    prompt_version: &str,
    input_hash: &str,
) -> Result<EnsureRunOutcome, AppError> {
    let cached_run_id: Option<String> = super::with_db(ws_state, |db| {
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

    super::with_db(ws_state, |db| {
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

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn start_post_effect_run(
    ws_state: State<'_, WorkspaceState>,
    ai_settings_path: State<'_, AiSettingsPath>,
    abort_flag: State<'_, PostEffectAbortFlag>,
    app_handle: AppHandle,
    args: StartPostEffectRunArgs,
) -> Result<StartPostEffectRunResult, AppError> {
    // abort フラグをリセット
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

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

    // キャッシュチェック + running 行 INSERT (ensure_post_effect_run に集約)
    let run_id = match ensure_post_effect_run(
        &ws_state,
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

    // scene_id は scope_target_id から取得 (scope_type='scene' のみ Phase 1b 対応)
    let scene_id = args.scope_target_id.clone().unwrap_or_default();

    let app = app_handle.clone();
    let ai_path = ai_settings_path.path.clone();
    let project_id = args.project_id.clone();
    let effect = args.effect_type.clone();
    let codex_json = args.codex_payload_json.clone();
    let scene_text = args.scene_text.clone();
    let system_prompt = args.system_prompt.clone();
    let persona = args.persona.clone();
    let rid = run_id.clone();

    tokio::task::spawn(async move {
        let app_clone = app.clone();
        let rid_clone = rid.clone();
        let join = tokio::task::spawn(async move {
            match effect.as_str() {
                "consistency" => {
                    run_consistency_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        codex_json,
                        scene_text,
                        system_prompt,
                        ai_path,
                    )
                    .await;
                }
                "impact_review" => {
                    run_impact_review_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        codex_json,
                        scene_text,
                        system_prompt,
                        ai_path,
                    )
                    .await;
                }
                "typo_detection" => {
                    run_typo_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        ai_path,
                    )
                    .await;
                }
                "review" => {
                    run_review_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        ai_path,
                    )
                    .await;
                }
                "intent_drift" => {
                    run_intent_drift_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        ai_path,
                    )
                    .await;
                }
                "pseudo_comment" => {
                    run_pseudo_comment_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        persona,
                        ai_path,
                    )
                    .await;
                }
                "meta_structure" => {
                    run_meta_structure_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        ai_path,
                    )
                    .await;
                }
                _ => {
                    run_intra_task(
                        app,
                        rid,
                        project_id,
                        scene_id,
                        scene_text,
                        system_prompt,
                        ai_path,
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
            let _ = app_clone.emit(
                "post_effect:error",
                ErrorEvent {
                    run_id: &rid_clone,
                    error: msg.clone(),
                },
            );
            fail_run(&app_clone, &rid_clone, &msg);
        }
    });

    Ok(StartPostEffectRunResult {
        run_id,
        from_cache: false,
    })
}

#[tauri::command]
pub(crate) async fn start_post_effect_run_multi(
    ws_state: State<'_, WorkspaceState>,
    ai_settings_path: State<'_, AiSettingsPath>,
    abort_flag: State<'_, PostEffectAbortFlag>,
    app_handle: AppHandle,
    args: StartPostEffectRunMultiArgs,
) -> Result<StartPostEffectRunResult, AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

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

    // キャッシュチェック + running 行 INSERT (ensure_post_effect_run に集約)
    let run_id = match ensure_post_effect_run(
        &ws_state,
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

    let app = app_handle.clone();
    let ai_path = ai_settings_path.path.clone();
    let project_id = args.project_id.clone();
    let effect = args.effect_type.clone();
    let scenes = args.scenes;
    let system_prompt = args.system_prompt.clone();
    let rid = run_id.clone();

    tokio::task::spawn(async move {
        let app_clone = app.clone();
        let rid_clone = rid.clone();
        let join = tokio::task::spawn(async move {
            run_multi_task(app, rid, project_id, effect, scenes, system_prompt, ai_path).await;
        })
        .await;
        if let Err(join_err) = join {
            let msg = if join_err.is_panic() {
                format!("post-effect multi タスクが panic しました: {join_err}")
            } else {
                format!("post-effect multi タスクが異常終了しました: {join_err}")
            };
            let _ = app_clone.emit(
                "post_effect:error",
                ErrorEvent {
                    run_id: &rid_clone,
                    error: msg.clone(),
                },
            );
            fail_run(&app_clone, &rid_clone, &msg);
        }
    });

    Ok(StartPostEffectRunResult {
        run_id,
        from_cache: false,
    })
}

#[tauri::command]
pub(crate) fn abort_post_effect_run(
    abort_flag: State<'_, PostEffectAbortFlag>,
    ws_state: State<'_, WorkspaceState>,
    run_id: String,
    project_id: String,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    // DB 上も cancelled にする (タスクが既に終わっている場合は影響なし)。
    // XPROJ ガード: 現在プロジェクトの run に限定 (他プロジェクトの run_id では 0 行 = no-op)。
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE post_effect_runs
                    SET status = 'cancelled', completed_at = datetime('now')
                  WHERE id = ? AND project_id = ? AND status = 'running'",
                params![run_id, project_id],
            )?;
            Ok(())
        })
    })
}

#[tauri::command]
pub(crate) fn list_post_effect_runs(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    effect_type: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<Value>, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let limit = limit.unwrap_or(20);
            let offset = offset.unwrap_or(0);
            let rows = if let Some(et) = &effect_type {
                let mut stmt = conn.prepare(
                    "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                            model, prompt_version, input_hash, status, summary,
                            error_message, started_at, completed_at
                       FROM post_effect_runs
                      WHERE project_id = ? AND effect_type = ?
                      ORDER BY started_at DESC
                      LIMIT ? OFFSET ?",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, et, limit, offset], row_to_run_value)?
                    .collect();
                r?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                            model, prompt_version, input_hash, status, summary,
                            error_message, started_at, completed_at
                       FROM post_effect_runs
                      WHERE project_id = ?
                      ORDER BY started_at DESC
                      LIMIT ? OFFSET ?",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, limit, offset], row_to_run_value)?
                    .collect();
                r?
            };
            Ok(rows)
        })
    })
}

#[tauri::command]
pub(crate) fn get_post_effect_run(
    ws_state: State<'_, WorkspaceState>,
    run_id: String,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            // XPROJ ガード: 現在プロジェクトの run に限定。run を project で検証すれば
            // run_id 紐付けの annotations/relations/lens も同プロジェクトに閉じる (fail-closed)。
            let run = conn.query_row(
                "SELECT id, project_id, effect_type, scope_type, scope_target_id,
                        model, prompt_version, input_hash, status, summary,
                        error_message, started_at, completed_at
                   FROM post_effect_runs WHERE id = ? AND project_id = ?",
                params![run_id, project_id],
                row_to_run_value,
            )?;

            let annotations = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations WHERE run_id = ? ORDER BY created_at",
                )?;
                let r: Result<Vec<_>, _> =
                    stmt.query_map(params![run_id], row_to_annotation_value)?.collect();
                r?
            };
            let relations = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotation_relations WHERE run_id = ? ORDER BY created_at",
                )?;
                let r: Result<Vec<_>, _> =
                    stmt.query_map(params![run_id], row_to_relation_value)?.collect();
                r?
            };

            let lens_data = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM scene_lens_data WHERE run_id = ? ORDER BY created_at",
                )?;
                let r: Result<Vec<_>, _> =
                    stmt.query_map(params![run_id], row_to_lens_value)?.collect();
                r?
            };

            let mut result = run;
            result["annotations"] = Value::Array(annotations);
            result["relations"] = Value::Array(relations);
            result["lens_data"] = Value::Array(lens_data);
            Ok(result)
        })
    })
}

/// Outline オーバーレイ用クエリ。最新 run の lens を scene ごとに返す。
///
/// 最新判定の MAX(created_at) サブクエリは **外側と同じ母集団** (completed な
/// meta_structure run) に scope しなければならない。lens 行は
/// `process_meta_structure_scene` で run が completed になる **前** に INSERT
/// されるため、再実行・キャンセル・クラッシュ復旧 (migrate.rs の running→failed)
/// で残った failed/running run の新しい lens 行が、scope 漏れの MAX を汚染すると、
/// 直前の completed run の行が `created_at = MAX` 条件から外れて当該シーンが
/// overlay からサイレントに消える。サブクエリ側にも JOIN + status/effect_type
/// 条件を入れて MAX を completed 行のみから取る。
const SCENE_LENS_FOR_PROJECT_SQL: &str = "SELECT l.*, r.completed_at AS run_completed_at
   FROM scene_lens_data l
   JOIN post_effect_runs r ON r.id = l.run_id
  WHERE l.project_id = ?1
    AND r.effect_type = 'meta_structure'
    AND r.status = 'completed'
    AND l.created_at = (
        SELECT MAX(l2.created_at)
          FROM scene_lens_data l2
          JOIN post_effect_runs r2 ON r2.id = l2.run_id
         WHERE l2.target_id = l.target_id
           AND l2.lens_type = l.lens_type
           AND l2.project_id = l.project_id
           AND r2.effect_type = 'meta_structure'
           AND r2.status = 'completed'
    )
  ORDER BY l.created_at";

/// Outline オーバーレイ用: scene ごとに最新 run の lens を返す。
/// 各 lens に run の completed_at (`runCompletedAt`) を付け、stale 判定に使う。
#[tauri::command]
pub(crate) fn list_scene_lens_for_project(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let mut stmt = conn.prepare(SCENE_LENS_FOR_PROJECT_SQL)?;
            let rows: Result<Vec<Value>, _> = stmt
                .query_map(params![project_id], |row| {
                    let mut v = row_to_lens_value(row)?;
                    v["runCompletedAt"] =
                        serde_json::json!(row.get::<_, Option<String>>("run_completed_at")?);
                    Ok(v)
                })?
                .collect();
            Ok(Value::Array(rows?))
        })
    })
}

#[tauri::command]
pub(crate) fn list_annotations_for_scene(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    scene_id: String,
    status: Option<String>,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let annotations = if let Some(st) = &status {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations
                      WHERE project_id = ? AND scene_id = ? AND status = ?
                      ORDER BY range_start, created_at",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, scene_id, st], row_to_annotation_value)?
                    .collect();
                r?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations
                      WHERE project_id = ? AND scene_id = ?
                      ORDER BY range_start, created_at",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, scene_id], row_to_annotation_value)?
                    .collect();
                r?
            };

            // 両端のどちらかが上記 annotations に含まれる relation を返す
            let ann_ids: Vec<String> = annotations
                .iter()
                .filter_map(|a| a["id"].as_str().map(|s: &str| s.to_string()))
                .collect();

            let relations = if ann_ids.is_empty() {
                vec![]
            } else {
                let placeholders = ann_ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                let sql = format!(
                    "SELECT * FROM post_effect_annotation_relations
                      WHERE annotation_a_id IN ({placeholders})
                         OR annotation_b_id IN ({placeholders})"
                );
                let mut stmt = conn.prepare(&sql)?;
                // params は ann_ids を 2 回渡す必要がある
                let all_ids: Vec<&dyn rusqlite::ToSql> = ann_ids
                    .iter()
                    .chain(ann_ids.iter())
                    .map(|s| s as &dyn rusqlite::ToSql)
                    .collect();
                let r: Result<Vec<_>, _> = stmt
                    .query_map(all_ids.as_slice(), row_to_relation_value)?
                    .collect();
                r?
            };

            Ok(serde_json::json!({
                "annotations": annotations,
                "relations": relations,
            }))
        })
    })
}

#[tauri::command]
pub(crate) fn list_annotations_for_project(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    status: Option<String>,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            let annotations = if let Some(st) = &status {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations
                      WHERE project_id = ? AND status = ?
                      ORDER BY scene_id, range_start, created_at",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id, st], row_to_annotation_value)?
                    .collect();
                r?
            } else {
                let mut stmt = conn.prepare(
                    "SELECT * FROM post_effect_annotations
                      WHERE project_id = ?
                      ORDER BY scene_id, range_start, created_at",
                )?;
                let r: Result<Vec<_>, _> = stmt
                    .query_map(params![project_id], row_to_annotation_value)?
                    .collect();
                r?
            };
            Ok(serde_json::json!({ "annotations": annotations }))
        })
    })
}

/// `update_annotation_status` の中核ロジック。
/// **XPROJ ガード**: `WHERE id = ? AND project_id = ?` で現在プロジェクトに限定する
/// (project_id は呼び出し側の現在プロジェクト)。他プロジェクトの annotation id を
/// 渡しても 0 行 = bail し、状態を書き換えられない (fail-closed)。コマンドから分離してテスト可能に。
fn update_annotation_status_inner(
    conn: &rusqlite::Connection,
    annotation_id: &str,
    status: &str,
    project_id: &str,
) -> anyhow::Result<Value> {
    // dismiss_source を status に合わせて更新
    let dismiss_source = if status == "dismissed" {
        Some("manual")
    } else {
        None
    };

    let affected = if let Some(src) = dismiss_source {
        conn.execute(
            "UPDATE post_effect_annotations
                SET status = ?,
                    metadata = json_set(metadata, '$.dismiss_source', ?),
                    updated_at = datetime('now')
              WHERE id = ? AND project_id = ?",
            params![status, src, annotation_id, project_id],
        )?
    } else {
        conn.execute(
            "UPDATE post_effect_annotations
                SET status = ?, updated_at = datetime('now')
              WHERE id = ? AND project_id = ?",
            params![status, annotation_id, project_id],
        )?
    };
    if affected == 0 {
        anyhow::bail!("annotation not found in project (id={annotation_id})");
    }

    let ann = conn.query_row(
        "SELECT * FROM post_effect_annotations WHERE id = ? AND project_id = ?",
        params![annotation_id, project_id],
        row_to_annotation_value,
    )?;
    Ok(ann)
}

#[tauri::command]
pub(crate) fn update_annotation_status(
    ws_state: State<'_, WorkspaceState>,
    annotation_id: String,
    status: String,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            update_annotation_status_inner(conn, &annotation_id, &status, &project_id)
        })
    })
}

#[derive(Deserialize)]
pub(crate) struct ReplyToAnnotationArgs {
    parent_id: String,
    content: String,
    author_role: String,
    /// XPROJ ガード: 親 annotation が属するべき現在プロジェクト。
    project_id: String,
}

/// `reply_to_annotation` の中核ロジック。
/// 親の project_id / scene_id / run_id / persona を継承して子 annotation を
/// INSERT し、read-back した Value を返す。コマンド本体から分離してテスト可能にする。
fn reply_to_annotation_inner(
    conn: &rusqlite::Connection,
    args: &ReplyToAnnotationArgs,
) -> anyhow::Result<Value> {
    // 親の project_id / scene_id / run_id / persona を継承する
    #[allow(clippy::type_complexity)]
    let (project_id, scene_id, run_id, persona): (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        // XPROJ ガード: 親は現在プロジェクトのものに限定 (他プロジェクトの
        // parent_id を渡しても 0 行 = NoRows エラーで fail-closed)。
        "SELECT project_id, scene_id, run_id, persona
           FROM post_effect_annotations WHERE id = ? AND project_id = ?",
        params![args.parent_id, args.project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;

    let author_role = match args.author_role.as_str() {
        "user" | "ai" | "system" => args.author_role.as_str(),
        _ => "user",
    };
    let new_id = Uuid::new_v4().to_string();
    let metadata = serde_json::json!({ "persona": persona });
    conn.execute(
        "INSERT INTO post_effect_annotations
            (id, project_id, run_id, anchor_type, scene_id,
             category, persona, content, author_role, parent_id,
             status, metadata, created_at, updated_at)
         VALUES (?, ?, ?, 'scene_range', ?,
                 'pseudo_comment', ?, ?, ?, ?,
                 'open', ?, datetime('now'), datetime('now'))",
        params![
            new_id,
            project_id,
            run_id,
            scene_id,
            persona,
            args.content,
            author_role,
            args.parent_id,
            metadata.to_string(),
        ],
    )?;

    let ann = conn.query_row(
        "SELECT * FROM post_effect_annotations WHERE id = ?",
        params![new_id],
        row_to_annotation_value,
    )?;
    Ok(ann)
}

/// 疑似コメントへの返信を追加する (設計書 §4: 親の run_id を継承)。
#[tauri::command]
pub(crate) fn reply_to_annotation(
    ws_state: State<'_, WorkspaceState>,
    args: ReplyToAnnotationArgs,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| reply_to_annotation_inner(conn, &args))
    })
}

/// `update_relation_status` の中核ロジック。
/// **XPROJ ガード**: relation・カスケード先 annotation・read-back すべてを
/// `AND project_id = ?` で現在プロジェクトに限定 (fail-closed)。
fn update_relation_status_inner(
    conn: &rusqlite::Connection,
    relation_id: &str,
    status: &str,
    project_id: &str,
) -> anyhow::Result<Value> {
    let affected = conn.execute(
        "UPDATE post_effect_annotation_relations
            SET status = ?, metadata = json_set(metadata, '$.updated_at', datetime('now'))
          WHERE id = ? AND project_id = ?",
        params![status, relation_id, project_id],
    )?;
    if affected == 0 {
        anyhow::bail!("relation not found in project (id={relation_id})");
    }

    // §2: 両端 annotation を同じ status にカスケード (現在プロジェクト内に限定)
    conn.execute(
        "UPDATE post_effect_annotations
            SET status = ?,
                metadata = json_set(metadata, '$.dismiss_source', 'cascade'),
                updated_at = datetime('now')
          WHERE project_id = ?
            AND id IN (
                SELECT annotation_a_id FROM post_effect_annotation_relations
                  WHERE id = ? AND project_id = ?
                UNION
                SELECT annotation_b_id FROM post_effect_annotation_relations
                  WHERE id = ? AND project_id = ?
            )",
        params![
            status,
            project_id,
            relation_id,
            project_id,
            relation_id,
            project_id
        ],
    )?;

    let rel = conn.query_row(
        "SELECT * FROM post_effect_annotation_relations WHERE id = ? AND project_id = ?",
        params![relation_id, project_id],
        row_to_relation_value,
    )?;
    Ok(rel)
}

#[tauri::command]
pub(crate) fn update_relation_status(
    ws_state: State<'_, WorkspaceState>,
    relation_id: String,
    status: String,
    project_id: String,
) -> Result<Value, AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| update_relation_status_inner(conn, &relation_id, &status, &project_id))
    })
}

#[tauri::command]
pub(crate) fn save_post_effect_annotations(
    ws_state: State<'_, WorkspaceState>,
    project_id: String,
    scene_id: String,
    annotations: Vec<Value>,
) -> Result<(), AppError> {
    super::with_db(&ws_state, |db| {
        db.with_conn(|conn| {
            for ann in &annotations {
                let id = ann["id"].as_str().unwrap_or("");
                let range_start = ann["range_start"].as_i64().unwrap_or(0);
                let range_end = ann["range_end"].as_i64().unwrap_or(0);
                let text_snapshot = ann["text_snapshot"].as_str().unwrap_or("");
                conn.execute(
                    "UPDATE post_effect_annotations
                        SET range_start = ?, range_end = ?, text_snapshot = ?,
                            updated_at = datetime('now')
                      WHERE id = ? AND project_id = ? AND scene_id = ?",
                    params![
                        range_start,
                        range_end,
                        text_snapshot,
                        id,
                        project_id,
                        scene_id
                    ],
                )?;
            }
            Ok(())
        })
    })
}

// ---------------------------------------------------------------------------
// Row → serde_json::Value ヘルパー
// ---------------------------------------------------------------------------

fn row_to_run_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(serde_json::json!({
        "id":               row.get::<_, String>(0)?,
        "projectId":        row.get::<_, String>(1)?,
        "effectType":       row.get::<_, String>(2)?,
        "scopeType":        row.get::<_, String>(3)?,
        "scopeTargetId":    row.get::<_, Option<String>>(4)?,
        "model":            row.get::<_, String>(5)?,
        "promptVersion":    row.get::<_, String>(6)?,
        "inputHash":        row.get::<_, Option<String>>(7)?,
        "status":           row.get::<_, String>(8)?,
        "summary":          row.get::<_, Option<String>>(9)?,
        "errorMessage":     row.get::<_, Option<String>>(10)?,
        "startedAt":        row.get::<_, String>(11)?,
        "completedAt":      row.get::<_, Option<String>>(12)?,
    }))
}

fn row_to_annotation_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata_str: String = row.get("metadata").unwrap_or_else(|_| "{}".into());
    let metadata: Value =
        serde_json::from_str(&metadata_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":           row.get::<_, String>("id")?,
        "projectId":    row.get::<_, String>("project_id")?,
        "runId":        row.get::<_, Option<String>>("run_id")?,
        "anchorType":   row.get::<_, String>("anchor_type")?,
        "sceneId":      row.get::<_, Option<String>>("scene_id")?,
        "rangeStart":   row.get::<_, Option<i64>>("range_start")?,
        "rangeEnd":     row.get::<_, Option<i64>>("range_end")?,
        "textSnapshot": row.get::<_, Option<String>>("text_snapshot")?,
        "category":     row.get::<_, String>("category")?,
        "persona":      row.get::<_, Option<String>>("persona")?,
        "severity":     row.get::<_, Option<String>>("severity")?,
        "content":      row.get::<_, String>("content")?,
        "authorRole":   row.get::<_, String>("author_role")?,
        "parentId":     row.get::<_, Option<String>>("parent_id")?,
        "status":       row.get::<_, String>("status")?,
        "metadata":     metadata,
        "createdAt":    row.get::<_, String>("created_at")?,
        "updatedAt":    row.get::<_, String>("updated_at")?,
    }))
}

fn row_to_relation_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metadata_str: String = row.get("metadata").unwrap_or_else(|_| "{}".into());
    let metadata: Value =
        serde_json::from_str(&metadata_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":              row.get::<_, String>("id")?,
        "projectId":       row.get::<_, String>("project_id")?,
        "runId":           row.get::<_, Option<String>>("run_id")?,
        "annotationAId":   row.get::<_, String>("annotation_a_id")?,
        "annotationBId":   row.get::<_, String>("annotation_b_id")?,
        "relationType":    row.get::<_, String>("relation_type")?,
        "direction":       row.get::<_, String>("direction")?,
        "description":     row.get::<_, Option<String>>("description")?,
        "status":          row.get::<_, String>("status")?,
        "metadata":        metadata,
        "createdAt":       row.get::<_, String>("created_at")?,
    }))
}

fn row_to_lens_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let metrics_str: String = row.get("metrics").unwrap_or_else(|_| "{}".into());
    let metrics: Value =
        serde_json::from_str(&metrics_str).unwrap_or(Value::Object(Default::default()));
    Ok(serde_json::json!({
        "id":         row.get::<_, String>("id")?,
        "projectId":  row.get::<_, String>("project_id")?,
        "runId":      row.get::<_, String>("run_id")?,
        "targetId":   row.get::<_, Option<String>>("target_id")?,
        "lensType":   row.get::<_, String>("lens_type")?,
        "metrics":    metrics,
        "finding":    row.get::<_, Option<String>>("finding")?,
        "severity":   row.get::<_, String>("severity")?,
        "createdAt":  row.get::<_, String>("created_at")?,
    }))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod list_scene_lens_for_project_tests {
    use super::SCENE_LENS_FOR_PROJECT_SQL;
    use rusqlite::{params, Connection};

    fn open_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE post_effect_runs (
                id           TEXT PRIMARY KEY,
                effect_type  TEXT,
                status       TEXT,
                completed_at TEXT
            );
            CREATE TABLE scene_lens_data (
                id          TEXT PRIMARY KEY,
                project_id  TEXT,
                run_id      TEXT,
                target_id   TEXT,
                lens_type   TEXT,
                metrics     TEXT NOT NULL DEFAULT '{}',
                finding     TEXT,
                severity    TEXT NOT NULL DEFAULT 'info',
                created_at  TEXT
            );",
        )
        .unwrap();
        conn
    }

    fn add_run(conn: &Connection, id: &str, effect_type: &str, status: &str, completed_at: &str) {
        conn.execute(
            "INSERT INTO post_effect_runs (id, effect_type, status, completed_at)
             VALUES (?, ?, ?, ?)",
            params![id, effect_type, status, completed_at],
        )
        .unwrap();
    }

    fn add_lens(
        conn: &Connection,
        id: &str,
        run_id: &str,
        target_id: &str,
        lens_type: &str,
        created_at: &str,
    ) {
        conn.execute(
            "INSERT INTO scene_lens_data
                (id, project_id, run_id, target_id, lens_type, finding, severity, created_at)
             VALUES (?, 'p1', ?, ?, ?, 'f', 'info', ?)",
            params![id, run_id, target_id, lens_type, created_at],
        )
        .unwrap();
    }

    /// SQL を走らせ、返ってきた lens 行の run_id 一覧を返す。
    fn query_run_ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare(SCENE_LENS_FOR_PROJECT_SQL).unwrap();
        stmt.query_map(params!["p1"], |row| row.get::<_, String>("run_id"))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn newer_failed_run_does_not_shadow_completed_lens() {
        // 回帰ガード: completed run の lens が、後から失敗した re-run の
        // 新しい lens 行 (MAX を汚染) によって overlay から消えてはならない。
        let conn = open_db();
        add_run(
            &conn,
            "rA",
            "meta_structure",
            "completed",
            "2026-01-01T00:00:00",
        );
        add_lens(
            &conn,
            "lA",
            "rA",
            "s1",
            "plot_structure",
            "2026-01-01T00:00:00",
        );
        // 後から走って失敗した re-run。lens 行は finalize 前に INSERT 済みで残る。
        add_run(
            &conn,
            "rB",
            "meta_structure",
            "failed",
            "2026-01-02T00:00:00",
        );
        add_lens(
            &conn,
            "lB",
            "rB",
            "s1",
            "plot_structure",
            "2026-01-02T00:00:00",
        );

        assert_eq!(
            query_run_ids(&conn),
            vec!["rA".to_string()],
            "completed run の lens のみ返るべき"
        );
    }

    #[test]
    fn running_rerun_does_not_shadow_completed_lens() {
        // クラッシュ前 (running のまま) の re-run も同様に shadow してはならない。
        let conn = open_db();
        add_run(
            &conn,
            "rA",
            "meta_structure",
            "completed",
            "2026-01-01T00:00:00",
        );
        add_lens(&conn, "lA", "rA", "s1", "pacing", "2026-01-01T00:00:00");
        add_run(&conn, "rB", "meta_structure", "running", "");
        add_lens(&conn, "lB", "rB", "s1", "pacing", "2026-01-02T00:00:00");

        assert_eq!(query_run_ids(&conn), vec!["rA".to_string()]);
    }

    #[test]
    fn newest_completed_run_wins() {
        // 正常系: 同一 scene+lens を 2 回 completed したら最新だけ返る。
        let conn = open_db();
        add_run(
            &conn,
            "rA",
            "meta_structure",
            "completed",
            "2026-01-01T00:00:00",
        );
        add_lens(
            &conn,
            "lA",
            "rA",
            "s1",
            "plot_structure",
            "2026-01-01T00:00:00",
        );
        add_run(
            &conn,
            "rB",
            "meta_structure",
            "completed",
            "2026-01-03T00:00:00",
        );
        add_lens(
            &conn,
            "lB",
            "rB",
            "s1",
            "plot_structure",
            "2026-01-03T00:00:00",
        );

        assert_eq!(query_run_ids(&conn), vec!["rB".to_string()]);
    }
}

#[cfg(test)]
mod post_effect_live_tests {
    //! 校閲 post-effect grader の **ライブ** 検証（実 OpenRouter）。
    //!
    //! 校閲系はプロンプト構築も応答解析も Rust 側にあり、JS の aiLiveHarness からは
    //! 届かない（docs/AI経路検証.md の経路③）。そこで本番の `call_post_effect_api`
    //! を実プロバイダに直接叩き、`extract_json` + JSON parse の到達経路を検証する。
    //! 検証範囲は「Rust トランスポート × 実モデル応答 × extract_json 解析」。各 effect の
    //! プロンプト文言の権威は FE(src/prompts/*/postEffect.ts)側で、ここでは代表的な
    //! JSON 返却指示を用いる。
    //!
    //! 既定 SKIP（キー無しは即 return）。実行（実トークン課金あり）:
    //!   OPENROUTER_API_KEY=sk-... cargo test --no-default-features \
    //!     post_effect_live -- --nocapture
    //!   モデル上書き: OPENROUTER_MODEL（既定 openai/gpt-4o-mini）。
    use super::extract_json;
    use crate::ai::{call_post_effect_api, AiProvider, AiSettings};

    fn live_key() -> Option<String> {
        std::env::var("OPENROUTER_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
    }

    fn live_settings() -> AiSettings {
        AiSettings {
            provider: AiProvider::OpenRouter,
            model: std::env::var("OPENROUTER_MODEL")
                .unwrap_or_else(|_| "openai/gpt-4o-mini".to_string()),
            ..Default::default()
        }
    }

    /// マルチバイト境界で割らないようにテキストを切り詰める（エラー表示用）。
    fn head(s: &str, n: usize) -> String {
        s.chars().take(n).collect()
    }

    /// 1 つの effect について call_post_effect_api → extract_json → JSON parse を検証。
    fn run_one(label: &str, system_prompt: &str, codex: Option<&str>, scene: &str) {
        let Some(key) = live_key() else {
            eprintln!("[skip] {label}: OPENROUTER_API_KEY 未設定");
            return;
        };
        let settings = live_settings();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        let raw = rt
            .block_on(call_post_effect_api(
                &settings,
                &key,
                system_prompt,
                codex,
                scene,
            ))
            .unwrap_or_else(|e| panic!("{label}: API 呼び出し失敗: {e:#}"));
        let json = extract_json(&raw);
        let parsed: serde_json::Value = serde_json::from_str(json)
            .unwrap_or_else(|e| panic!("{label}: JSON parse 失敗: {e} / raw={}", head(&raw, 200)));
        assert!(
            parsed.is_object(),
            "{label}: 応答が JSON オブジェクトでない"
        );
        eprintln!(
            "[ok] {label}: {} keys",
            parsed.as_object().map_or(0, |o| o.len())
        );
    }

    const SCENE: &str = "朱音は棚の奥で古い真鍮の鍵を見つけた。なぜか胸騒ぎがして、誰にも言わずポケットにしまった。その夜、彼女は鍵の夢を見た。";

    #[test]
    fn intent_drift_live() {
        run_one(
            "intent_drift",
            "あなたは小説の校閲者です。シーン本文が作者の意図からずれていないか分析し、結果を JSON オブジェクトで返してください。前後に説明やコードフェンスを付けないこと。形式: {\"findings\":[{\"issue\":\"...\",\"severity\":\"low|medium|high\"}]}",
            None,
            SCENE,
        );
    }

    #[test]
    fn review_live() {
        run_one(
            "review",
            "あなたは小説の編集者です。シーン本文を講評し、結果を JSON オブジェクトで返してください。説明やコードフェンスは不要。形式: {\"comments\":[{\"point\":\"...\",\"suggestion\":\"...\"}]}",
            None,
            SCENE,
        );
    }

    #[test]
    fn consistency_with_codex_live() {
        run_one(
            "consistency",
            "あなたは小説の校閲者です。Codex 設定とシーン本文の矛盾を検出し、JSON オブジェクトで返してください。説明やコードフェンスは不要。形式: {\"violations\":[{\"detail\":\"...\"}]}",
            Some("{\"name\":\"朱音\",\"note\":\"鍵が大の苦手で、見るのも触るのも嫌う性格\"}"),
            SCENE,
        );
    }

    #[test]
    fn impact_review_with_diff_live() {
        // impact_review は consistency と同様、Codex ブロック (ここでは変更差分の
        // JSON オブジェクト) を Some(..) で渡す。NEW 値に照らして本文の矛盾箇所を
        // judgments[] で返させ、call_post_effect_api → extract_json → parse の
        // 到達経路を検証する。
        run_one(
            "impact_review",
            "あなたは小説の影響度レビュアーです。与えられた Codex 設定の変更 (old→new) に対し、シーン本文の中で矛盾する箇所を検出し、JSON オブジェクトで返してください。NEW 値を基準に判断すること。説明やコードフェンスは不要。形式: {\"judgments\":[{\"found_text\":\"...\",\"found_context\":\"...\",\"contradiction_score\":0.0,\"confidence\":\"high|medium|low\",\"reason\":\"...\"}]}",
            Some(
                "{\"change_id\":\"chg-1\",\"entry_id\":\"e1\",\"entry_name\":\"朱音\",\"entry_type\":\"character\",\"change_summary\":\"鍵への態度: 大好き → 大の苦手\",\"changes\":[{\"field\":\"detail\",\"name\":\"鍵への態度\",\"old\":\"大好き\",\"new\":\"大の苦手\"}]}",
            ),
            SCENE,
        );
    }
}
