//! AI のべりすと専用の定数・ヘルパ。
//!
//! レガシー `/api` (独自フォーマット) と v1 `/v1` (OpenAI 互換) のハイブリッド運用。

/// レガシー Text / Messages API
pub const BASE_URL: &str = "https://api.tringpt.com/api";

/// OpenAI 互換 v1 エンドポイント
pub const V1_BASE_URL: &str = "https://api.tringpt.com/v1";

/// v1 モデル一覧取得 URL
pub const V1_MODELS_URL: &str = "https://api.tringpt.com/v1/models";

/// v1 取得失敗時の静的 fallback allowlist
pub const V1_KNOWN_MODELS: &[&str] = &["spiko_ultra"];

/// v1 未知モデルの保守的デフォルト出力長
pub const V1_DEFAULT_LENGTH: u32 = 32_768;

/// リクエストボディに素通しできる独自サンプリングキー (KoboldAI 系、legacy のみ)
pub const EXTRA_SAMPLING_KEYS: &[&str] = &[
    "top_a",
    "tailfree",
    "typical_p",
    "min_p",
    "rep_pen",
    "badwords",
    "stoptokens",
    "logit_bias",
];

/// レガシー モデル別の最大出力トークン数 (`length` / `max_tokens`)
/// TS 側 `AINOVERIST_MODEL_CAPS.maxOutputTokens` と一致させること。
const LEGACY_MAX_OUTPUT_TOKENS: &[(&str, u32)] = &[
    ("derrida_03", 4_096),
    ("spiko", 4_096),
    ("spiko_solid", 4_096),
    ("spiko_max", 4_096),
    ("damsel_ray", 400),
    ("supertrin_highpres", 400),
    ("supertrin_maxpres", 400),
    ("supertrin", 400),
    ("damsel", 400),
];

/// v1 モデル別の最大出力トークン数
const V1_MAX_OUTPUT_TOKENS: &[(&str, u32)] = &[("spiko_ultra", 32_768)];

/// レガシー未知モデル時のフォールバック出力長
pub const DEFAULT_LENGTH: u32 = 400;

/// 明示 api_variant またはモデル名から v1 経路か判定する。
pub fn is_v1_variant(api_variant: Option<&str>, model: &str) -> bool {
    if api_variant == Some("v1") {
        return true;
    }
    if api_variant == Some("legacy") {
        return false;
    }
    V1_KNOWN_MODELS.contains(&model)
}

/// モデル名から `length` / `max_tokens` を返す。
pub fn length_for(model: &str) -> u32 {
    if let Some((_, l)) = V1_MAX_OUTPUT_TOKENS.iter().find(|(m, _)| *m == model) {
        return *l;
    }
    if V1_KNOWN_MODELS.contains(&model) {
        return V1_DEFAULT_LENGTH;
    }
    LEGACY_MAX_OUTPUT_TOKENS
        .iter()
        .find(|(m, _)| *m == model)
        .map(|(_, l)| *l)
        .unwrap_or(DEFAULT_LENGTH)
}

/// レガシー静的モデル一覧
pub fn legacy_models() -> Vec<(&'static str, &'static str)> {
    vec![
        ("derrida_03", "derrida_03"),
        ("spiko", "spiko"),
        ("spiko_solid", "spiko_solid"),
        ("spiko_max", "spiko_max"),
        ("damsel_ray", "damsel_ray"),
        ("supertrin_highpres", "supertrin_highpres"),
        ("supertrin_maxpres", "supertrin_maxpres"),
        ("supertrin", "supertrin (legacy)"),
        ("damsel", "damsel (legacy)"),
    ]
}

/// 既知 v1 モデルの静的 fallback 一覧
pub fn known_v1_models_static() -> Vec<(&'static str, &'static str)> {
    vec![("spiko_ultra", "Spiko Ultra")]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_for_legacy_models() {
        assert_eq!(length_for("spiko"), 4_096);
        assert_eq!(length_for("derrida_03"), 4_096);
        assert_eq!(length_for("damsel_ray"), 400);
        assert_eq!(length_for("damsel"), 400);
    }

    #[test]
    fn length_for_spiko_ultra() {
        assert_eq!(length_for("spiko_ultra"), 32_768);
    }

    #[test]
    fn length_for_unknown_v1_known_falls_back_to_v1_default() {
        assert!(V1_KNOWN_MODELS.contains(&"spiko_ultra"));
        assert_eq!(length_for("unknown_v1_future"), DEFAULT_LENGTH);
    }

    #[test]
    fn length_for_unknown_falls_back() {
        assert_eq!(length_for(""), DEFAULT_LENGTH);
        assert_eq!(length_for("unknown_model"), DEFAULT_LENGTH);
    }

    #[test]
    fn is_v1_variant_explicit() {
        assert!(is_v1_variant(Some("v1"), "spiko"));
        assert!(!is_v1_variant(Some("legacy"), "spiko_ultra"));
    }

    #[test]
    fn is_v1_variant_infers_from_known_models() {
        assert!(is_v1_variant(None, "spiko_ultra"));
        assert!(!is_v1_variant(None, "spiko"));
    }

    #[test]
    fn v1_known_models_contains_spiko_ultra() {
        assert!(V1_KNOWN_MODELS.contains(&"spiko_ultra"));
    }
}
