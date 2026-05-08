//! OpenAI 互換プロバイダのプリセット定義 (Rust 側)。
//!
//! TS 側 `src/features/chat/openaiCompatPresets.ts` と同じ ID 空間を共有する。
//! プリセット ID から固定 baseURL / 許可サンプリングキー / レート制限を引く。
//!
//! Phase A.2: "custom" / "ainoverist" の 2 種類

/// プリセット ID 定数
#[allow(dead_code)] // テストでのみ参照、TS 側との対応のため public 名を残す
pub const PRESET_CUSTOM: &str = "custom";
pub const PRESET_AINOVERIST: &str = "ainoverist";

/// AI のべりすとの固定 baseURL
pub const AINOVERIST_BASE_URL: &str = "https://api.tringpt.com/api";

/// AI のべりすとが受け付ける独自サンプリングキー
pub const AINOVERIST_EXTRA_SAMPLING_KEYS: &[&str] = &[
    "top_a",
    "tailfree",
    "typical_p",
    "min_p",
    "rep_pen",
    "badwords",
    "stoptokens",
    "logit_bias",
];

/// レート制限値 (req/分)。429 リトライロジックの呼び出し側で参照する。
#[derive(Debug, Clone, Copy)]
pub struct PresetRateLimit {
    pub requests_per_minute: u32,
    /// モデル別の上書き ((model, rpm) のスライス)
    pub per_model_override: &'static [(&'static str, u32)],
}

pub const AINOVERIST_RATE_LIMIT: PresetRateLimit = PresetRateLimit {
    requests_per_minute: 200,
    per_model_override: &[("damsel", 90)],
};

/// プリセット ID から固定 baseURL を返す。"custom" や未知の ID は None。
pub fn fixed_base_url(preset_id: &str) -> Option<&'static str> {
    match preset_id {
        PRESET_AINOVERIST => Some(AINOVERIST_BASE_URL),
        _ => None,
    }
}

/// プリセット ID から許可サンプリングキーを返す。
pub fn extra_sampling_keys(preset_id: &str) -> &'static [&'static str] {
    match preset_id {
        PRESET_AINOVERIST => AINOVERIST_EXTRA_SAMPLING_KEYS,
        _ => &[],
    }
}

/// プリセット ID + モデル名から rpm 上限を返す。設定なしは None。
pub fn rate_limit_for(preset_id: &str, model: &str) -> Option<u32> {
    match preset_id {
        PRESET_AINOVERIST => {
            for (m, rpm) in AINOVERIST_RATE_LIMIT.per_model_override {
                if *m == model {
                    return Some(*rpm);
                }
            }
            Some(AINOVERIST_RATE_LIMIT.requests_per_minute)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_base_url_returns_ainoverist() {
        assert_eq!(
            fixed_base_url(PRESET_AINOVERIST),
            Some("https://api.tringpt.com/api")
        );
        assert_eq!(fixed_base_url(PRESET_CUSTOM), None);
        assert_eq!(fixed_base_url("unknown"), None);
    }

    #[test]
    fn extra_sampling_keys_for_ainoverist() {
        let keys = extra_sampling_keys(PRESET_AINOVERIST);
        assert!(keys.contains(&"top_a"));
        assert!(keys.contains(&"tailfree"));
        assert!(keys.contains(&"rep_pen"));
        assert_eq!(extra_sampling_keys(PRESET_CUSTOM).len(), 0);
    }

    #[test]
    fn rate_limit_per_model_override() {
        assert_eq!(rate_limit_for(PRESET_AINOVERIST, "spiko"), Some(200));
        assert_eq!(rate_limit_for(PRESET_AINOVERIST, "damsel"), Some(90));
        assert_eq!(rate_limit_for(PRESET_CUSTOM, "anything"), None);
    }
}
