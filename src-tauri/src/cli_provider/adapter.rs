//! CLI 別の NDJSON / JSON 行 出力を統一 `CliEvent` ストリームに変換するアダプタ。
//!
//! Phase C.1: Claude Code (`--output-format stream-json`) 用パーサのみ実装。
//! Codex / OpenCode 用は Phase C.2 で実装する。

use super::{CliEvent, CliKind};

/// 1 行を受け取り 0 個以上のイベントに変換するパーサ。
///
/// CLI ごとにストリーム形式が異なる:
/// - Claude Code: 1 行 = 1 JSON オブジェクト。`type` で `system` / `assistant` /
///   `user` / `result` を区別
/// - Codex CLI: 1 行 = 1 JSON。形式 TBD (Phase C.2)
/// - OpenCode: 1 行 = 1 JSON。形式 TBD (Phase C.2)
pub trait LineAdapter: Send {
    fn parse_line(&mut self, line: &str) -> Vec<CliEvent>;
}

pub fn for_cli(kind: CliKind) -> Box<dyn LineAdapter> {
    match kind {
        CliKind::Claude => Box::new(ClaudeAdapter::default()),
        CliKind::Codex => Box::new(StubAdapter),
        CliKind::Opencode => Box::new(StubAdapter),
    }
}

// ---------------------------------------------------------------------------
// Claude Code (`--output-format stream-json`) の NDJSON 形式
// ---------------------------------------------------------------------------
//
// 観察上の各行のスキーマ:
// - {"type":"system","subtype":"init","tools":[...],"model":"...",...}
// - {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]},...}
// - {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
// - {"type":"result","is_error":false,"usage":{"input_tokens":N,"output_tokens":N},
//    "total_cost_usd":0.x,"stop_reason":"end_turn"}
//
// `--allowed-tools ""` を指定しているため tool_use / tool_result は出ない想定だが、
// 念のため tool_* 系は無視する設計にしている (ユーザーが UI で誤設定しても本パネル
// 側でテキスト応答だけを抽出する保証になる)。
//
// テキストの delta はフルテキストの累積で来ることが多いので、前回の累積からの
// 差分を取り出して emit する (二重表示防止)。

#[derive(Default)]
pub struct ClaudeAdapter {
    /// 最後に emit した assistant テキストの累積長 (UTF-8 chars 単位)
    last_emitted_chars: usize,
}

impl LineAdapter for ClaudeAdapter {
    fn parse_line(&mut self, line: &str) -> Vec<CliEvent> {
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let ty = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ty {
            "assistant" => {
                // assistant message の content[].text を集約してテキスト delta に
                let mut full = String::new();
                if let Some(content) = json.pointer("/message/content").and_then(|v| v.as_array()) {
                    for block in content {
                        let block_ty = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if block_ty == "text" {
                            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                full.push_str(t);
                            }
                        }
                        // tool_use 等は無視 (本パネルでは tools 全 OFF 前提)
                    }
                }
                let total_chars = full.chars().count();
                if total_chars > self.last_emitted_chars {
                    let delta: String = full.chars().skip(self.last_emitted_chars).collect();
                    self.last_emitted_chars = total_chars;
                    if !delta.is_empty() {
                        out.push(CliEvent::TextDelta(delta));
                    }
                }
            }
            "result" => {
                let input_tokens = json.pointer("/usage/input_tokens").and_then(|v| v.as_u64());
                let output_tokens = json
                    .pointer("/usage/output_tokens")
                    .and_then(|v| v.as_u64());
                let stop_reason = json
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("end_turn")
                    .to_string();
                out.push(CliEvent::Done {
                    input_tokens,
                    output_tokens,
                    stop_reason,
                });
            }
            // system / user / その他は無視
            _ => {}
        }
        out
    }
}

/// Phase C.2 で実装予定の no-op adapter。Codex / OpenCode 用。
#[derive(Default)]
pub struct StubAdapter;

impl LineAdapter for StubAdapter {
    fn parse_line(&mut self, _line: &str) -> Vec<CliEvent> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_text(events: &[CliEvent]) -> String {
        let mut s = String::new();
        for e in events {
            if let CliEvent::TextDelta(t) = e {
                s.push_str(t);
            }
        }
        s
    }

    #[test]
    fn claude_emits_incremental_text_deltas() {
        let mut a = ClaudeAdapter::default();
        // 1 行目: "Hello"
        let e1 = a.parse_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
        );
        assert_eq!(collect_text(&e1), "Hello");
        // 2 行目: 累積で "Hello, world" → 差分 ", world" だけ
        let e2 = a.parse_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello, world"}]}}"#,
        );
        assert_eq!(collect_text(&e2), ", world");
    }

    #[test]
    fn claude_ignores_system_and_user_lines() {
        let mut a = ClaudeAdapter::default();
        let e1 = a.parse_line(r#"{"type":"system","subtype":"init"}"#);
        assert!(e1.is_empty());
        let e2 = a.parse_line(r#"{"type":"user","message":{"content":[]}}"#);
        assert!(e2.is_empty());
    }

    #[test]
    fn claude_emits_done_with_usage_on_result() {
        let mut a = ClaudeAdapter::default();
        let events = a.parse_line(
            r#"{"type":"result","is_error":false,"usage":{"input_tokens":42,"output_tokens":17},"stop_reason":"end_turn"}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            CliEvent::Done {
                input_tokens,
                output_tokens,
                stop_reason,
            } => {
                assert_eq!(*input_tokens, Some(42));
                assert_eq!(*output_tokens, Some(17));
                assert_eq!(stop_reason, "end_turn");
            }
            _ => panic!("expected Done"),
        }
    }

    #[test]
    fn claude_handles_invalid_json_gracefully() {
        let mut a = ClaudeAdapter::default();
        let events = a.parse_line("not json");
        assert!(events.is_empty());
    }

    #[test]
    fn claude_ignores_tool_use_blocks_when_tools_off() {
        let mut a = ClaudeAdapter::default();
        // tool_use ブロックが混在しても無視され、text だけ抽出される
        let events = a.parse_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"x","name":"y","input":{}}]}}"#,
        );
        assert_eq!(collect_text(&events), "hello");
    }
}
