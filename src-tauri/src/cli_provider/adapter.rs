//! CLI 別の NDJSON / JSON 行出力を統一 `CliEvent` ストリームに変換するアダプタ。
//!
//! - Claude Code: `--output-format stream-json`
//! - Codex CLI: `codex exec --json` の item / turn イベント
//! - OpenCode: `opencode run --format json` の text / step_finish イベント

use std::collections::HashMap;

use super::{CliEvent, CliKind};

/// 1 行を受け取り 0 個以上のイベントに変換するパーサ。
pub trait LineAdapter: Send {
    fn parse_line(&mut self, line: &str) -> Vec<CliEvent>;
}

pub fn for_cli(kind: CliKind) -> Box<dyn LineAdapter> {
    match kind {
        CliKind::Claude => Box::new(ClaudeAdapter::default()),
        CliKind::Codex => Box::new(CodexAdapter::default()),
        CliKind::Opencode => Box::new(OpenCodeAdapter::default()),
    }
}

/// `id` ごとに UTF-8 文字単位で累積テキストが伸びたぶんだけ差分を返す。
fn take_utf8_suffix_delta(
    state: &mut HashMap<String, usize>,
    id: impl Into<String>,
    full: &str,
) -> Option<String> {
    let id = id.into();
    let total_chars = full.chars().count();
    let prev = state.get(&id).copied().unwrap_or(0);
    if total_chars <= prev {
        return None;
    }
    let delta: String = full.chars().skip(prev).collect();
    state.insert(id, total_chars);
    if delta.is_empty() {
        None
    } else {
        Some(delta)
    }
}

// ---------------------------------------------------------------------------
// Claude Code (`--output-format stream-json`)
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ClaudeAdapter {
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
                let mut full = String::new();
                if let Some(content) = json.pointer("/message/content").and_then(|v| v.as_array()) {
                    for block in content {
                        let block_ty = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if block_ty == "text" {
                            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                                full.push_str(t);
                            }
                        }
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
            _ => {}
        }
        out
    }
}

// ---------------------------------------------------------------------------
// OpenAI Codex CLI (`codex exec --json`)
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct CodexAdapter {
    /// assistant / agent メッセージの item.id ごとの累積長
    message_chars: HashMap<String, usize>,
    /// reasoning の item.id ごとの累積長
    reasoning_chars: HashMap<String, usize>,
}

fn codex_item_text_events(
    item: &serde_json::Value,
    map: &mut HashMap<String, usize>,
    thinking: bool,
) -> Vec<CliEvent> {
    let mut out = Vec::new();
    let id_raw = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let id = if id_raw.is_empty() {
        "_anon".to_string()
    } else {
        id_raw.to_string()
    };

    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
        if let Some(delta) = take_utf8_suffix_delta(map, id, text) {
            if thinking {
                out.push(CliEvent::ThinkingDelta(delta));
            } else {
                out.push(CliEvent::TextDelta(delta));
            }
        }
        return out;
    }

    if let Some(delta) = item.get("delta").and_then(|v| v.as_str()) {
        if !delta.is_empty() {
            if thinking {
                out.push(CliEvent::ThinkingDelta(delta.to_string()));
            } else {
                out.push(CliEvent::TextDelta(delta.to_string()));
            }
        }
    }
    out
}

impl CodexAdapter {
    fn codex_item_type(item: &serde_json::Value) -> Option<&str> {
        item.get("item_type")
            .or_else(|| item.get("type"))
            .and_then(|v| v.as_str())
    }

    fn push_usage_done(v: &serde_json::Value) -> Option<CliEvent> {
        let u = v.get("usage")?;
        let input_tokens = u
            .get("input_tokens")
            .or_else(|| u.get("prompt_tokens"))
            .and_then(|x| x.as_u64());
        let output_tokens = u
            .get("output_tokens")
            .or_else(|| u.get("completion_tokens"))
            .and_then(|x| x.as_u64());
        if input_tokens.is_none() && output_tokens.is_none() {
            return None;
        }
        Some(CliEvent::Done {
            input_tokens,
            output_tokens,
            stop_reason: "end_turn".to_string(),
        })
    }
}

impl LineAdapter for CodexAdapter {
    fn parse_line(&mut self, line: &str) -> Vec<CliEvent> {
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let ty = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match ty {
            "item.completed" | "item.updated" | "item.added" => {
                if let Some(item) = json.get("item") {
                    let Some(item_ty) = Self::codex_item_type(item) else {
                        return out;
                    };
                    match item_ty {
                        "assistant_message" | "agent_message" => {
                            out.extend(codex_item_text_events(
                                item,
                                &mut self.message_chars,
                                false,
                            ));
                        }
                        "reasoning" => {
                            out.extend(codex_item_text_events(
                                item,
                                &mut self.reasoning_chars,
                                true,
                            ));
                        }
                        _ => {}
                    }
                }
            }
            "turn.completed" | "thread.completed" => {
                if let Some(done) = Self::push_usage_done(&json) {
                    out.push(done);
                }
            }
            "error" => {
                let msg = json
                    .pointer("/error/message")
                    .or_else(|| json.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Codex CLI error");
                out.push(CliEvent::TextDelta(format!("[error] {msg}\n")));
                out.push(CliEvent::Done {
                    input_tokens: None,
                    output_tokens: None,
                    stop_reason: "error".to_string(),
                });
            }
            _ => {}
        }
        out
    }
}

// ---------------------------------------------------------------------------
// OpenCode (`opencode run --format json`)
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct OpenCodeAdapter {
    text_part_chars: HashMap<String, usize>,
}

impl LineAdapter for OpenCodeAdapter {
    fn parse_line(&mut self, line: &str) -> Vec<CliEvent> {
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let ty = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match ty {
            "text" => {
                if let Some(part) = json.get("part") {
                    let id_raw = part.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let id = if id_raw.is_empty() {
                        "_text".to_string()
                    } else {
                        id_raw.to_string()
                    };
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        if let Some(delta) =
                            take_utf8_suffix_delta(&mut self.text_part_chars, id, text)
                        {
                            out.push(CliEvent::TextDelta(delta));
                        }
                    }
                }
            }
            "step_finish" => {
                if let Some(part) = json.get("part") {
                    if let Some(t) = part.get("type").and_then(|v| v.as_str()) {
                        if t != "step-finish" {
                            return out;
                        }
                    }
                    let reason = part.get("reason").and_then(|v| v.as_str());
                    if reason == Some("tool-calls") {
                        return out;
                    }
                    let tokens = part.get("tokens");
                    let input_tokens = tokens.and_then(|t| t.get("input")).and_then(|x| x.as_u64());
                    let output_tokens =
                        tokens.and_then(|t| t.get("output")).and_then(|x| x.as_u64());
                    let stop_reason = reason.unwrap_or("end_turn").to_string();
                    out.push(CliEvent::Done {
                        input_tokens,
                        output_tokens,
                        stop_reason,
                    });
                }
            }
            "error" => {
                let msg = json
                    .pointer("/error/data/message")
                    .or_else(|| json.pointer("/error/message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("OpenCode CLI error");
                out.push(CliEvent::TextDelta(format!("[error] {msg}\n")));
                out.push(CliEvent::Done {
                    input_tokens: None,
                    output_tokens: None,
                    stop_reason: "error".to_string(),
                });
            }
            _ => {}
        }
        out
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
        let e1 = a.parse_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
        );
        assert_eq!(collect_text(&e1), "Hello");
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
        let events = a.parse_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","id":"x","name":"y","input":{}}]}}"#,
        );
        assert_eq!(collect_text(&events), "hello");
    }

    #[test]
    fn codex_assistant_message_emits_text() {
        let mut a = CodexAdapter::default();
        let e = a.parse_line(
            r#"{"type":"item.completed","item":{"id":"itm_0","item_type":"assistant_message","text":"Hello"}}"#,
        );
        assert_eq!(collect_text(&e), "Hello");
    }

    #[test]
    fn codex_agent_message_variant_emits_text() {
        let mut a = CodexAdapter::default();
        let e = a.parse_line(
            r#"{"type":"item.completed","item":{"id":"itm_0","type":"agent_message","text":"Hi"}}"#,
        );
        assert_eq!(collect_text(&e), "Hi");
    }

    #[test]
    fn codex_streaming_assistant_same_id_emits_suffix_only() {
        let mut a = CodexAdapter::default();
        let e1 = a.parse_line(
            r#"{"type":"item.updated","item":{"id":"itm_9","item_type":"assistant_message","text":"Hello"}}"#,
        );
        assert_eq!(collect_text(&e1), "Hello");
        let e2 = a.parse_line(
            r#"{"type":"item.updated","item":{"id":"itm_9","item_type":"assistant_message","text":"Hello, world"}}"#,
        );
        assert_eq!(collect_text(&e2), ", world");
    }

    #[test]
    fn codex_reasoning_emits_thinking() {
        let mut a = CodexAdapter::default();
        let events = a.parse_line(
            r#"{"type":"item.completed","item":{"id":"itm_2","item_type":"reasoning","text":"think"}}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            CliEvent::ThinkingDelta(t) => assert_eq!(t, "think"),
            _ => panic!("expected ThinkingDelta"),
        }
    }

    #[test]
    fn codex_turn_completed_emits_done() {
        let mut a = CodexAdapter::default();
        let events = a.parse_line(
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            CliEvent::Done {
                input_tokens,
                output_tokens,
                stop_reason,
            } => {
                assert_eq!(*input_tokens, Some(10));
                assert_eq!(*output_tokens, Some(20));
                assert_eq!(stop_reason, "end_turn");
            }
            _ => panic!("expected Done"),
        }
    }

    #[test]
    fn opencode_text_emits_delta() {
        let mut a = OpenCodeAdapter::default();
        let e1 = a.parse_line(
            r#"{"type":"text","sessionID":"ses_x","part":{"id":"prt_1","type":"text","text":"Hi"}}"#,
        );
        assert_eq!(collect_text(&e1), "Hi");
        let e2 = a.parse_line(
            r#"{"type":"text","sessionID":"ses_x","part":{"id":"prt_1","type":"text","text":"Hi!"}}"#,
        );
        assert_eq!(collect_text(&e2), "!");
    }

    #[test]
    fn opencode_step_finish_stop_emits_done() {
        let mut a = OpenCodeAdapter::default();
        let events = a.parse_line(
            r#"{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":100,"output":5}}}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            CliEvent::Done {
                input_tokens,
                output_tokens,
                stop_reason,
            } => {
                assert_eq!(*input_tokens, Some(100));
                assert_eq!(*output_tokens, Some(5));
                assert_eq!(stop_reason, "stop");
            }
            _ => panic!("expected Done"),
        }
    }

    #[test]
    fn opencode_step_finish_tool_calls_skips_done() {
        let mut a = OpenCodeAdapter::default();
        let events = a.parse_line(
            r#"{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"input":1,"output":2}}}"#,
        );
        assert!(events.is_empty());
    }
}
