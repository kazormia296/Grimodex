//! AI のべりすと専用の定数・ヘルパ。
//!
//! エンドポイント: POST https://api.tringpt.com/api (これ以外は 404)
//! 独自フォーマット: text / length / サンプリング → data ラップ応答
//! OpenAI 互換エンドポイントは存在しない。

pub const BASE_URL: &str = "https://api.tringpt.com/api";

/// リクエストボディに素通しできる独自サンプリングキー (KoboldAI 系)
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

/// デフォルトのレート制限 (req/分)
pub const RATE_LIMIT_RPM: u32 = 200;
/// damsel 系モデルのレート制限
pub const DAMSEL_RATE_LIMIT_RPM: u32 = 90;

/// モデル別の最大出力トークン数 (API 必須パラメータ `length` に使用)
/// TS 側 `AINOVERIST_MODEL_CAPS.maxOutputTokens` と一致させること。
const MAX_OUTPUT_TOKENS: &[(&str, u32)] = &[
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

/// 未知モデル時のフォールバック出力長 (最小クラスに合わせた保守値)
pub const DEFAULT_LENGTH: u32 = 400;

/// モデル名から `length` パラメータ値を返す。未知は `DEFAULT_LENGTH`。
pub fn length_for(model: &str) -> u32 {
    MAX_OUTPUT_TOKENS
        .iter()
        .find(|(m, _)| *m == model)
        .map(|(_, l)| *l)
        .unwrap_or(DEFAULT_LENGTH)
}

/// モデル名からレート制限 RPM を返す。
pub fn rate_limit_rpm(model: &str) -> u32 {
    if model.starts_with("damsel") {
        DAMSEL_RATE_LIMIT_RPM
    } else {
        RATE_LIMIT_RPM
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_for_known_models() {
        assert_eq!(length_for("spiko"), 4_096);
        assert_eq!(length_for("derrida_03"), 4_096);
        assert_eq!(length_for("damsel_ray"), 400);
        assert_eq!(length_for("damsel"), 400);
    }

    #[test]
    fn length_for_unknown_falls_back() {
        assert_eq!(length_for(""), DEFAULT_LENGTH);
        assert_eq!(length_for("unknown_model"), DEFAULT_LENGTH);
    }

    #[test]
    fn rate_limit_rpm_per_model() {
        assert_eq!(rate_limit_rpm("spiko"), RATE_LIMIT_RPM);
        assert_eq!(rate_limit_rpm("damsel"), DAMSEL_RATE_LIMIT_RPM);
        assert_eq!(rate_limit_rpm("damsel_ray"), DAMSEL_RATE_LIMIT_RPM);
    }
}
