//! 「未確定の固有名詞候補」抽出コマンド。
//!
//! 本文(全シーン)を lindera で形態素解析し、**固有名詞 (`pos_major=="名詞"`
//! かつ `pos_sub1=="固有名詞"`)** のうち、既存 Codex の name/alias に無いものを
//! 候補として返す。形態素=決定的な全件列挙、後段の LLM 判定/受理 UI=意味判断、
//! という分業の前半 (B1)。日本語プロジェクト専用 (UniDic 依存)。
//!
//! 戻り値はあくまで候補。自動で Codex には書かない (受理/却下は UI 側)。

use std::collections::{HashMap, HashSet};

use grimodex_lint::morph::{tokenize_block, MorphToken};
use rusqlite::params;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::database::Database;
use crate::semantic::chunker::extract_paragraph_texts;
use crate::semantic::index::project_language;

use super::{with_db, AppError, WorkspaceState};

/// UI に返す未確定固有名詞候補。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexCandidate {
    /// 代表表層形 (読書順で最初に出現したときの surface)。
    pub surface: String,
    /// UniDic 語彙素。空なら surface で埋める。
    pub lemma: String,
    /// プロジェクト全体での総出現数。
    pub count: usize,
    /// 読書順で最初に出現したシーン (初出シーンへのジャンプ用)。
    pub first_scene_id: String,
    /// 初出箇所の周辺一文 (LLM 種別判定の文脈サンプル用)。
    pub context: String,
}

/// tree_nodes の 1 行 (読書順 DFS 用の最小情報)。
struct NodeRow {
    id: String,
    parent_id: Option<String>,
    node_type: String,
    sort_order: String,
    content: Option<String>,
}

/// 照合キー正規化。trim → NFC → ASCII 小文字化 (A–Z のみ a–z へ)。NFC を挟むのは、
/// 固有名詞が NFC/NFD (例: 濁点付き仮名や macOS 由来の分解形) で揺れても重複検出が
/// 外れないようにするため。
/// **フロントの `candidateKey` (codexCandidates.ts) と必ず同じ規則に保つこと**
/// (ズレると Rust が出した候補をクライアントが誤って消す/残す)。
///
/// 小文字化を ASCII に限定する理由: 候補生成は日本語プロジェクト専用で固有名詞は
/// 実質 ASCII 折り畳み可能だが、Unicode のフル小文字化は特殊ケース (トルコ語の
/// 点付き/点なし I・末尾シグマ等) で Rust の `char::to_lowercase` と JS の
/// `String.prototype.toLowerCase` が一致する保証がない。両ランタイムで確実に同一な
/// ASCII 折り畳みに絞ることで、受理/却下キーのズレを構造的に防ぐ。
fn normalize_name(s: &str) -> String {
    s.trim()
        .nfc()
        .map(|c| {
            if c.is_ascii_uppercase() {
                c.to_ascii_lowercase()
            } else {
                c
            }
        })
        .collect()
}

/// codex_entries.aliases (JSON 文字列 `["a","b"]`) を配列へ。壊れていれば空。
fn parse_aliases(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

/// ProseMirror JSON 本文を平文へ (段落のみ。sceneBeat 等のプロンプトは除外)。
fn plaintext_of(content_json: &str) -> String {
    if content_json.trim().is_empty() {
        return String::new();
    }
    match serde_json::from_str::<Value>(content_json) {
        Ok(doc) => extract_paragraph_texts(&doc).join("\n"),
        Err(_) => String::new(),
    }
}

/// tree をツリー DFS して **読書順** の (scene_id, content_json) 列を返す。
///
/// フロントの `computeGlobalSceneOrder` (phaseResolver.ts) と同じ規則:
/// 兄弟は sort_order 文字列の辞書順、folder は再帰、scene は leaf、note は除外。
/// フラットな `ORDER BY sort_order` は別フォルダの兄弟を混ぜるため不可。
fn reading_order_scenes(nodes: &[NodeRow]) -> Vec<(String, String)> {
    let mut children: HashMap<Option<String>, Vec<usize>> = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        children.entry(n.parent_id.clone()).or_default().push(i);
    }
    for group in children.values_mut() {
        group.sort_by(|&a, &b| {
            nodes[a]
                .sort_order
                .cmp(&nodes[b].sort_order)
                .then_with(|| nodes[a].id.cmp(&nodes[b].id))
        });
    }

    let mut out: Vec<(String, String)> = Vec::new();
    let mut visited: HashSet<usize> = HashSet::new();
    walk_reading_order(&None, nodes, &children, &mut visited, &mut out);
    out
}

fn walk_reading_order(
    parent: &Option<String>,
    nodes: &[NodeRow],
    children: &HashMap<Option<String>, Vec<usize>>,
    visited: &mut HashSet<usize>,
    out: &mut Vec<(String, String)>,
) {
    let Some(idxs) = children.get(parent) else {
        return;
    };
    for &i in idxs {
        // データ不整合 (循環参照) で無限再帰しないようガード。
        if !visited.insert(i) {
            continue;
        }
        let n = &nodes[i];
        match n.node_type.as_str() {
            "scene" => out.push((n.id.clone(), n.content.clone().unwrap_or_default())),
            "folder" => walk_reading_order(&Some(n.id.clone()), nodes, children, visited, out),
            // note 等は読書順に含めない。
            _ => {}
        }
    }
}

/// `plain` 内の `[byte_start, byte_end)` を含む周辺一文を返す (LLM 文脈用)。
/// 文境界 (。！？!?改行) まで広げ、長すぎる場合は前後 `RADIUS` 文字でクランプ。
/// char 単位で走査するのでバイト境界 panic を起こさない。範囲外オフセットは丸める。
fn context_window(plain: &str, byte_start: usize, byte_end: usize) -> String {
    const RADIUS: usize = 50;
    const TERMINATORS: [char; 6] = ['。', '！', '？', '!', '?', '\n'];

    let chars: Vec<(usize, char)> = plain.char_indices().collect();
    if chars.is_empty() {
        return String::new();
    }
    // start_ci / end_ci: byte_start/byte_end 以上の最初の char index。
    let start_ci = chars
        .iter()
        .position(|&(b, _)| b >= byte_start)
        .unwrap_or(chars.len());
    let end_ci = chars
        .iter()
        .position(|&(b, _)| b >= byte_end)
        .unwrap_or(chars.len());

    // 左へ: 直前文字が終端 or RADIUS 超過まで。
    let mut l = start_ci;
    while l > 0 {
        let (_, c) = chars[l - 1];
        if TERMINATORS.contains(&c) || start_ci.saturating_sub(l - 1) > RADIUS {
            break;
        }
        l -= 1;
    }
    // 右へ: 終端文字を含めて 1 つ先まで or RADIUS 超過まで。
    let mut r = end_ci;
    while r < chars.len() {
        let (_, c) = chars[r];
        r += 1;
        if TERMINATORS.contains(&c) || r.saturating_sub(end_ci) >= RADIUS {
            break;
        }
    }

    let lb = chars.get(l).map(|&(b, _)| b).unwrap_or(0);
    let rb = chars.get(r).map(|&(b, _)| b).unwrap_or(plain.len());
    plain.get(lb..rb).unwrap_or("").trim().to_string()
}

/// 読書順に並んだ (scene_id, plain, tokens) から固有名詞を集約し、既知 Codex 名を
/// 差し引いて候補を返す。初出箇所の周辺一文を context に詰める。
/// 純ロジック (DB/lindera 非依存) なのでテスト可能。
fn aggregate_candidates(
    scenes: &[(String, String, Vec<MorphToken>)],
    known: &HashSet<String>,
    min_count: usize,
) -> Vec<CodexCandidate> {
    struct Agg {
        surface: String,
        lemma: String,
        count: usize,
        first_scene_idx: usize,
        first_scene_id: String,
        first_token_idx: usize,
        context: String,
    }

    let mut map: HashMap<String, Agg> = HashMap::new();
    for (scene_idx, (scene_id, plain, tokens)) in scenes.iter().enumerate() {
        for (tok_idx, t) in tokens.iter().enumerate() {
            if t.pos_major != "名詞" || t.pos_sub1 != "固有名詞" {
                continue;
            }
            let key = normalize_name(&t.surface);
            if key.is_empty() || known.contains(&key) {
                continue;
            }
            // 読書順で走査しているので、最初に挿入された時が初出。
            map.entry(key).or_insert_with(|| Agg {
                surface: t.surface.clone(),
                lemma: if t.lemma.is_empty() {
                    t.surface.clone()
                } else {
                    t.lemma.clone()
                },
                count: 0,
                first_scene_idx: scene_idx,
                first_scene_id: scene_id.clone(),
                first_token_idx: tok_idx,
                context: context_window(plain, t.byte_start, t.byte_end),
            });
            // unwrap 不可避を避けるため再取得して加算。
            if let Some(agg) = map.get_mut(&normalize_name(&t.surface)) {
                agg.count += 1;
            }
        }
    }

    let mut aggs: Vec<Agg> = map.into_values().filter(|a| a.count >= min_count).collect();
    // 出現数 desc → 初出シーン順 asc → シーン内トークン順 asc → surface で決定化。
    aggs.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.first_scene_idx.cmp(&b.first_scene_idx))
            .then_with(|| a.first_token_idx.cmp(&b.first_token_idx))
            .then_with(|| a.surface.cmp(&b.surface))
    });
    aggs.into_iter()
        .map(|a| CodexCandidate {
            surface: a.surface,
            lemma: a.lemma,
            count: a.count,
            first_scene_id: a.first_scene_id,
            context: a.context,
        })
        .collect()
}

fn load_project_nodes(db: &Database, project_id: &str) -> anyhow::Result<Vec<NodeRow>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, node_type, sort_order, content
               FROM tree_nodes
              WHERE project_id = ?",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok(NodeRow {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                node_type: row.get(2)?,
                sort_order: row.get(3)?,
                content: row.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    })
}

fn load_known_codex_names(db: &Database, project_id: &str) -> anyhow::Result<HashSet<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name, COALESCE(aliases, '') FROM codex_entries WHERE project_id = ?",
        )?;
        let rows = stmt.query_map(params![project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut known: HashSet<String> = HashSet::new();
        for r in rows {
            let (name, aliases_json) = r?;
            let n = normalize_name(&name);
            if !n.is_empty() {
                known.insert(n);
            }
            for alias in parse_aliases(&aliases_json) {
                let a = normalize_name(&alias);
                if !a.is_empty() {
                    known.insert(a);
                }
            }
        }
        Ok(known)
    })
}

/// 本文中の未知 (Codex 未登録) 固有名詞候補を抽出する。
///
/// `min_count` 未満の出現はノイズ (誤判定・一回限りの語) として除外する
/// (既定 2)。日本語以外のプロジェクトは空を返す。
#[tauri::command]
pub(crate) fn extract_codex_candidates(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    min_count: Option<usize>,
) -> Result<Vec<CodexCandidate>, AppError> {
    let min_count = min_count.unwrap_or(2).max(1);

    // フェーズ 1 (ロック保持は最小): DB から読書順シーンと既知名だけ取り出す。
    // 形態素解析 (CPU バウンド) はロックの**外**で行い、大規模プロジェクトで
    // ワークスペースの DB アクセス全体をブロックしないようにする。
    let (scenes, known): (Vec<(String, String)>, HashSet<String>) = with_db(&ws_state, |db| {
        // 日本語専用 (lindera/UniDic)。それ以外は候補なし。
        if project_language(db, &project_id)? != "ja" {
            return Ok((Vec::new(), HashSet::new()));
        }
        let nodes = load_project_nodes(db, &project_id)?;
        let known = load_known_codex_names(db, &project_id)?;
        Ok((reading_order_scenes(&nodes), known))
    })?;

    // フェーズ 2 (ロック外): 各シーンを形態素解析。平文も持ち回して文脈窓に使う。
    let mut scenes_tokens: Vec<(String, String, Vec<MorphToken>)> =
        Vec::with_capacity(scenes.len());
    for (scene_id, content_json) in scenes {
        let plain = plaintext_of(&content_json);
        let tokens = if plain.is_empty() {
            Vec::new()
        } else {
            match tokenize_block(&plain) {
                Ok(t) => t,
                Err(e) => {
                    // best-effort: そのシーンは空扱いにするが、握り潰さず記録する。
                    tracing::warn!(
                        scene_id = %scene_id,
                        error = %e,
                        "[codex_candidates] morph tokenize 失敗; このシーンを空扱い"
                    );
                    Vec::new()
                }
            }
        };
        scenes_tokens.push((scene_id, plain, tokens));
    }

    Ok(aggregate_candidates(&scenes_tokens, &known, min_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(surface: &str, pos_major: &str, pos_sub1: &str, byte_start: usize) -> MorphToken {
        MorphToken {
            surface: surface.to_string(),
            byte_start,
            byte_end: byte_start + surface.len(),
            pos_major: pos_major.to_string(),
            pos_sub1: pos_sub1.to_string(),
            lemma: String::new(),
        }
    }

    fn node(id: &str, parent: Option<&str>, ty: &str, order: &str) -> NodeRow {
        NodeRow {
            id: id.to_string(),
            parent_id: parent.map(|s| s.to_string()),
            node_type: ty.to_string(),
            sort_order: order.to_string(),
            content: Some(format!("content-of-{id}")),
        }
    }

    #[test]
    fn normalize_name_lowercases_and_trims() {
        assert_eq!(normalize_name("  Alice "), "alice");
        assert_eq!(normalize_name("円明"), "円明");
    }

    #[test]
    fn normalize_name_unifies_nfc_and_nfd() {
        // 「ガ」: NFC = U+30AC 単一 / NFD = U+30AB U+3099 (カ + 結合濁点)。
        // NFC 正規化を挟むので両者は同じキーになる (重複検出が外れない)。
        let nfc = "ガ";
        let nfd = "\u{30AB}\u{3099}";
        assert_ne!(nfc, nfd, "前提: NFC と NFD は元の文字列としては異なる");
        assert_eq!(normalize_name(nfc), normalize_name(nfd));
    }

    #[test]
    fn reading_order_is_dfs_not_flat_sort_order() {
        // root: folderB(a1) と folderA(a0)。各 folder に scene。
        // フラット sort_order だと scene の sort_order だけで並ぶが、
        // 正しい読書順は folderA の中 → folderB の中。
        let nodes = vec![
            node("fB", None, "folder", "a1"),
            node("fA", None, "folder", "a0"),
            node("s2", Some("fB"), "scene", "a0"),
            node("s1", Some("fA"), "scene", "a5"), // sort_order は s2 より後ろでも fA が先
            node("note1", Some("fA"), "note", "a0"), // note は読書順に含めない
        ];
        let order: Vec<String> = reading_order_scenes(&nodes)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        assert_eq!(order, vec!["s1".to_string(), "s2".to_string()]);
    }

    #[test]
    fn aggregate_counts_excludes_known_and_non_proper_nouns() {
        // s1: 円明(固有,2回) + 走る(動詞=無視) ; s2: 円明 + 帝都(固有) + 既知の朱(固有)
        let scenes = vec![
            (
                "s1".to_string(),
                "円明走る円明".to_string(),
                vec![
                    tok("円明", "名詞", "固有名詞", 0),
                    tok("走る", "動詞", "一般", 6),
                    tok("円明", "名詞", "固有名詞", 12),
                ],
            ),
            (
                "s2".to_string(),
                "帝都円明朱".to_string(),
                vec![
                    tok("帝都", "名詞", "固有名詞", 0),
                    tok("円明", "名詞", "固有名詞", 6),
                    tok("朱", "名詞", "固有名詞", 12),
                ],
            ),
        ];
        let mut known = HashSet::new();
        known.insert(normalize_name("朱")); // 既知 Codex 名

        let cands = aggregate_candidates(&scenes, &known, 1);
        // 既知の朱は除外、動詞は無視。円明(3)・帝都(1)。
        assert_eq!(cands.len(), 2);
        // 出現数 desc → 円明が先頭
        assert_eq!(cands[0].surface, "円明");
        assert_eq!(cands[0].count, 3);
        assert_eq!(cands[0].first_scene_id, "s1");
        assert_eq!(cands[1].surface, "帝都");
        assert_eq!(cands[1].count, 1);
        assert_eq!(cands[1].first_scene_id, "s2");
        // 初出箇所の文脈が詰まっている (本文の一部)。
        assert!(cands[0].context.contains("円明"));
    }

    #[test]
    fn aggregate_min_count_filters_one_offs() {
        let scenes = vec![(
            "s1".to_string(),
            "円明円明帝都".to_string(),
            vec![
                tok("円明", "名詞", "固有名詞", 0),
                tok("円明", "名詞", "固有名詞", 6),
                tok("帝都", "名詞", "固有名詞", 12), // 1 回のみ
            ],
        )];
        let cands = aggregate_candidates(&scenes, &HashSet::new(), 2);
        // min_count=2 で帝都(1回)は落ちる。
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].surface, "円明");
    }

    #[test]
    fn context_window_extends_to_sentence_boundaries() {
        // 「円明」を含む文を、前後の句点境界まで切り出す。
        let plain = "朝だった。円明は走った。夜が来た。";
        let start = plain.find("円明").expect("present");
        let ctx = context_window(plain, start, start + "円明".len());
        assert!(ctx.contains("円明は走った"), "ctx={ctx}");
        assert!(!ctx.contains("朝だった"), "前の文は含めない: ctx={ctx}");
    }

    #[test]
    fn context_window_tolerates_out_of_range_offsets() {
        // 範囲外オフセットでも panic せず空などを返す。
        assert_eq!(context_window("", 0, 5), "");
        let _ = context_window("短い", 100, 200);
    }
}
