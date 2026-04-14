//! ProseMirror JSON → Markdown 変換

use serde_json::Value;

/// ProseMirror doc JSON を Markdown テキストに変換する。
/// 変換できないノードは graceful fallback（子を再帰）。
pub fn prosemirror_to_markdown(doc: &Value) -> String {
    let mut out = String::new();
    render_node(doc, &mut out, 0);
    // 末尾の余分な改行を1つだけ除去
    if out.ends_with('\n') {
        out.pop();
    }
    out
}

fn render_node(node: &Value, out: &mut String, list_depth: usize) {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    let content = node.get("content");
    let attrs = node.get("attrs");

    match node_type {
        "doc" => {
            if let Some(children) = content.and_then(Value::as_array) {
                for child in children {
                    render_node(child, out, list_depth);
                }
            }
        }
        "paragraph" => {
            render_inline_children(node, out);
            out.push('\n');
        }
        "heading" => {
            let level = attrs
                .and_then(|a| a.get("level"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 6) as usize;
            out.push_str(&"#".repeat(level));
            out.push(' ');
            render_inline_children(node, out);
            out.push('\n');
        }
        "bulletList" => {
            if let Some(children) = content.and_then(Value::as_array) {
                for child in children {
                    render_list_item(child, out, list_depth, false, 0);
                }
            }
        }
        "orderedList" => {
            if let Some(children) = content.and_then(Value::as_array) {
                for (i, child) in children.iter().enumerate() {
                    render_list_item(child, out, list_depth, true, i + 1);
                }
            }
        }
        "codeBlock" => {
            let lang = attrs
                .and_then(|a| a.get("language"))
                .and_then(Value::as_str)
                .unwrap_or("");
            out.push_str("```");
            out.push_str(lang);
            out.push('\n');
            if let Some(children) = content.and_then(Value::as_array) {
                for child in children {
                    if child.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(t) = child.get("text").and_then(Value::as_str) {
                            out.push_str(t);
                        }
                    }
                }
            }
            out.push_str("\n```\n");
        }
        "blockquote" => {
            let mut inner = String::new();
            if let Some(children) = content.and_then(Value::as_array) {
                for child in children {
                    render_node(child, &mut inner, list_depth);
                }
            }
            for line in inner.lines() {
                out.push_str("> ");
                out.push_str(line);
                out.push('\n');
            }
        }
        "horizontalRule" => {
            out.push_str("---\n");
        }
        "table" => {
            render_table(node, out);
        }
        "ruby" => {
            let base = attrs
                .and_then(|a| a.get("base"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let annotation = attrs
                .and_then(|a| a.get("annotation"))
                .and_then(Value::as_str)
                .unwrap_or("");
            out.push('{');
            out.push_str(base);
            out.push('|');
            out.push_str(annotation);
            out.push('}');
        }
        "sceneBreak" => {
            out.push_str("***\n");
        }
        "hardBreak" => {
            out.push('\n');
        }
        _ => {
            // 未知ノード: 子を再帰
            if let Some(children) = content.and_then(Value::as_array) {
                for child in children {
                    render_node(child, out, list_depth);
                }
            }
        }
    }
}

fn render_list_item(node: &Value, out: &mut String, depth: usize, ordered: bool, number: usize) {
    let indent = "  ".repeat(depth);
    let prefix = if ordered {
        format!("{indent}{}. ", number)
    } else {
        format!("{indent}- ")
    };

    let content = node.get("content").and_then(Value::as_array);
    if let Some(children) = content {
        let mut first = true;
        for child in children {
            let child_type = child.get("type").and_then(Value::as_str).unwrap_or("");
            match child_type {
                "paragraph" => {
                    if first {
                        out.push_str(&prefix);
                        render_inline_children(child, out);
                        out.push('\n');
                        first = false;
                    } else {
                        out.push_str(&"  ".repeat(depth + 1));
                        render_inline_children(child, out);
                        out.push('\n');
                    }
                }
                "bulletList" => {
                    if let Some(items) = child.get("content").and_then(Value::as_array) {
                        for item in items {
                            render_list_item(item, out, depth + 1, false, 0);
                        }
                    }
                }
                "orderedList" => {
                    if let Some(items) = child.get("content").and_then(Value::as_array) {
                        for (i, item) in items.iter().enumerate() {
                            render_list_item(item, out, depth + 1, true, i + 1);
                        }
                    }
                }
                _ => {
                    if first {
                        out.push_str(&prefix);
                        first = false;
                    }
                    render_node(child, out, depth + 1);
                }
            }
        }
    }
}

fn render_inline_children(node: &Value, out: &mut String) {
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            render_inline_node(child, out);
        }
    }
}

fn render_inline_node(node: &Value, out: &mut String) {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "text" => {
            let text = node.get("text").and_then(Value::as_str).unwrap_or("");
            let marks = node.get("marks").and_then(Value::as_array);
            render_marked_text(text, marks, out);
        }
        "ruby" => {
            let attrs = node.get("attrs");
            let base = attrs
                .and_then(|a| a.get("base"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let annotation = attrs
                .and_then(|a| a.get("annotation"))
                .and_then(Value::as_str)
                .unwrap_or("");
            out.push('{');
            out.push_str(base);
            out.push('|');
            out.push_str(annotation);
            out.push('}');
        }
        "hardBreak" => {
            out.push('\n');
        }
        _ => {
            // Unknown inline: recurse children
            if let Some(children) = node.get("content").and_then(Value::as_array) {
                for child in children {
                    render_inline_node(child, out);
                }
            }
        }
    }
}

fn render_marked_text(text: &str, marks: Option<&Vec<Value>>, out: &mut String) {
    let marks = match marks {
        Some(m) if !m.is_empty() => m,
        _ => {
            out.push_str(text);
            return;
        }
    };

    // Filter out authorship marks (not rendered)
    let active_marks: Vec<&Value> = marks
        .iter()
        .filter(|m| m.get("type").and_then(Value::as_str) != Some("authorship"))
        .collect();

    if active_marks.is_empty() {
        out.push_str(text);
        return;
    }

    // Build prefix/suffix from all marks (innermost first)
    let mut prefix = String::new();
    let mut suffix = String::new();
    let mut link_href: Option<&str> = None;

    for mark in &active_marks {
        let mark_type = mark.get("type").and_then(Value::as_str).unwrap_or("");
        match mark_type {
            "bold" => {
                prefix.insert_str(0, "**");
                suffix.push_str("**");
            }
            "italic" => {
                prefix.insert(0, '*');
                suffix.push('*');
            }
            "strike" => {
                prefix.insert_str(0, "~~");
                suffix.push_str("~~");
            }
            "code" => {
                prefix.insert(0, '`');
                suffix.push('`');
            }
            "underline" => {
                prefix.insert_str(0, "<u>");
                suffix.push_str("</u>");
            }
            "emphasisDots" => {
                prefix.insert_str(0, "《《");
                suffix.push_str("》》");
            }
            "link" => {
                let href = mark
                    .get("attrs")
                    .and_then(|a| a.get("href"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                link_href = Some(href);
            }
            _ => {}
        }
    }

    if let Some(href) = link_href {
        out.push('[');
        out.push_str(&prefix);
        out.push_str(text);
        out.push_str(&suffix);
        out.push_str("](");
        out.push_str(href);
        out.push(')');
    } else {
        out.push_str(&prefix);
        out.push_str(text);
        out.push_str(&suffix);
    }
}

fn render_table(node: &Value, out: &mut String) {
    let rows = match node.get("content").and_then(Value::as_array) {
        Some(r) => r,
        None => return,
    };

    let mut table_rows: Vec<Vec<String>> = Vec::new();
    let mut has_header = false;

    for row in rows {
        let cells = match row.get("content").and_then(Value::as_array) {
            Some(c) => c,
            None => continue,
        };
        let mut row_cells: Vec<String> = Vec::new();
        let mut row_is_header = false;
        for cell in cells {
            let cell_type = cell.get("type").and_then(Value::as_str).unwrap_or("");
            if cell_type == "tableHeader" {
                row_is_header = true;
            }
            let mut cell_content = String::new();
            if let Some(children) = cell.get("content").and_then(Value::as_array) {
                for child in children {
                    render_node(child, &mut cell_content, 0);
                }
            }
            // Trim trailing newlines from cell content
            let trimmed = cell_content.trim_end_matches('\n').to_string();
            row_cells.push(trimmed);
        }
        if row_is_header {
            has_header = true;
        }
        table_rows.push(row_cells);
    }

    if table_rows.is_empty() {
        return;
    }

    let col_count = table_rows.iter().map(|r| r.len()).max().unwrap_or(0);

    for (i, row) in table_rows.iter().enumerate() {
        out.push('|');
        for j in 0..col_count {
            let cell = row.get(j).map(String::as_str).unwrap_or("");
            out.push(' ');
            out.push_str(cell);
            out.push_str(" |");
        }
        out.push('\n');
        // After first row if it was a header, insert separator
        if i == 0 && has_header {
            out.push('|');
            for _ in 0..col_count {
                out.push_str(" --- |");
            }
            out.push('\n');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn md(doc: serde_json::Value) -> String {
        prosemirror_to_markdown(&doc)
    }

    // --- paragraph ---
    #[test]
    fn test_empty_doc() {
        let doc = json!({"type": "doc", "content": []});
        assert_eq!(md(doc), "");
    }

    #[test]
    fn test_paragraph_plain() {
        let doc = json!({
            "type": "doc",
            "content": [{
                "type": "paragraph",
                "content": [{"type": "text", "text": "Hello world"}]
            }]
        });
        assert_eq!(md(doc), "Hello world");
    }

    #[test]
    fn test_multiple_paragraphs() {
        let doc = json!({
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "First"}]},
                {"type": "paragraph", "content": [{"type": "text", "text": "Second"}]}
            ]
        });
        assert_eq!(md(doc), "First\nSecond");
    }

    // --- heading ---
    #[test]
    fn test_heading_levels() {
        for level in 1u64..=6 {
            let doc = json!({
                "type": "doc",
                "content": [{
                    "type": "heading",
                    "attrs": {"level": level},
                    "content": [{"type": "text", "text": "Title"}]
                }]
            });
            let expected = format!("{} Title", "#".repeat(level as usize));
            assert_eq!(md(doc), expected, "level={level}");
        }
    }

    // --- marks ---
    #[test]
    fn test_bold() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "bold", "marks": [{"type": "bold"}]}
            ]}]
        });
        assert_eq!(md(doc), "**bold**");
    }

    #[test]
    fn test_italic() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "em", "marks": [{"type": "italic"}]}
            ]}]
        });
        assert_eq!(md(doc), "*em*");
    }

    #[test]
    fn test_strike() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "del", "marks": [{"type": "strike"}]}
            ]}]
        });
        assert_eq!(md(doc), "~~del~~");
    }

    #[test]
    fn test_code_mark() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "code", "marks": [{"type": "code"}]}
            ]}]
        });
        assert_eq!(md(doc), "`code`");
    }

    #[test]
    fn test_underline() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "ul", "marks": [{"type": "underline"}]}
            ]}]
        });
        assert_eq!(md(doc), "<u>ul</u>");
    }

    #[test]
    fn test_emphasis_dots() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "点", "marks": [{"type": "emphasisDots"}]}
            ]}]
        });
        assert_eq!(md(doc), "《《点》》");
    }

    #[test]
    fn test_link() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "click", "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}]}
            ]}]
        });
        assert_eq!(md(doc), "[click](https://example.com)");
    }

    #[test]
    fn test_authorship_mark_stripped() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "text", "marks": [{"type": "authorship", "attrs": {"source": "ai"}}]}
            ]}]
        });
        // authorship mark should be stripped, plain text
        assert_eq!(md(doc), "text");
    }

    #[test]
    fn test_bold_italic_combined() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": "bi", "marks": [{"type": "bold"}, {"type": "italic"}]}
            ]}]
        });
        let result = md(doc);
        assert!(result.contains("bi"), "text should appear");
        assert!(result.contains("**"), "bold markers");
        assert!(result.contains('*'), "italic markers");
    }

    // --- lists ---
    #[test]
    fn test_bullet_list() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "bulletList", "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]},
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]}
            ]}]
        });
        assert_eq!(md(doc), "- A\n- B");
    }

    #[test]
    fn test_ordered_list() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "orderedList", "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "One"}]}]},
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Two"}]}]}
            ]}]
        });
        assert_eq!(md(doc), "1. One\n2. Two");
    }

    // --- codeBlock ---
    #[test]
    fn test_code_block_with_lang() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "codeBlock", "attrs": {"language": "rust"}, "content": [
                {"type": "text", "text": "fn main() {}"}
            ]}]
        });
        assert_eq!(md(doc), "```rust\nfn main() {}\n```");
    }

    #[test]
    fn test_code_block_no_lang() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "codeBlock", "content": [
                {"type": "text", "text": "hello"}
            ]}]
        });
        assert_eq!(md(doc), "```\nhello\n```");
    }

    // --- blockquote ---
    #[test]
    fn test_blockquote() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "blockquote", "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "quote"}]}
            ]}]
        });
        assert_eq!(md(doc), "> quote");
    }

    // --- horizontalRule ---
    #[test]
    fn test_horizontal_rule() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "horizontalRule"}]
        });
        assert_eq!(md(doc), "---");
    }

    // --- sceneBreak ---
    #[test]
    fn test_scene_break() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "sceneBreak"}]
        });
        assert_eq!(md(doc), "***");
    }

    // --- ruby ---
    #[test]
    fn test_ruby_inline() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "ruby", "attrs": {"base": "漢字", "annotation": "かんじ"}}
            ]}]
        });
        assert_eq!(md(doc), "{漢字|かんじ}");
    }

    // --- table ---
    #[test]
    fn test_simple_table() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "table", "content": [
                {"type": "tableRow", "content": [
                    {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "H1"}]}]},
                    {"type": "tableHeader", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "H2"}]}]}
                ]},
                {"type": "tableRow", "content": [
                    {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "A"}]}]},
                    {"type": "tableCell", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "B"}]}]}
                ]}
            ]}]
        });
        let result = md(doc);
        assert!(result.contains("| H1 | H2 |"), "header row: {result}");
        assert!(result.contains("| --- |"), "separator: {result}");
        assert!(result.contains("| A | B |"), "data row: {result}");
    }

    // --- unknown node fallback ---
    #[test]
    fn test_unknown_node_recurses() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "unknownBlock", "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "inside"}]}
            ]}]
        });
        assert_eq!(md(doc), "inside");
    }

    // --- edge cases ---
    #[test]
    fn test_null_content() {
        let doc = json!({"type": "doc"});
        assert_eq!(md(doc), "");
    }

    #[test]
    fn test_invalid_json_value() {
        // Not a real ProseMirror doc, just a string value
        let doc = json!("not a doc");
        assert_eq!(md(doc), "");
    }

    #[test]
    fn test_empty_text_node() {
        let doc = json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [
                {"type": "text", "text": ""}
            ]}]
        });
        assert_eq!(md(doc), "");
    }
}
