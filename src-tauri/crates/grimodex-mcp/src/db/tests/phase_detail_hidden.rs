//! Codex の詳細読み（`get_codex_entry_full`）と、hidden の Phase（案 (b)）。
//!
//! 項目そのもの（base が公開）は今までどおり見え、詳細の `phases[]` の行だけが対象。
//! `db::tests` の子 module なので、親の private な helper（`insert_project` など）を使える。

use super::*;

/// hidden の Phase の中身（外部の AI クライアントに出てはならない文字列）。
const SECRET_LABEL: &str = "secret-phase-label";
const SECRET_SUMMARY: &str = "secret-phase-summary";
const SECRET_CONTENT: &str = "secret-phase-content";
const SECRET_ANCHOR: &str = "scene-secret-anchor";

#[allow(clippy::too_many_arguments)]
fn insert_phase(
    conn: &Connection,
    id: &str,
    entry_id: &str,
    label: &str,
    summary_override: Option<&str>,
    content_override: Option<&str>,
    mode_override: Option<&str>,
    anchor: Option<&str>,
    created_at: &str,
) {
    conn.execute(
        "INSERT INTO codex_entry_phases \
         (id, entry_id, label, summary_override, content_override, context_mode_override, \
          anchor_node_id, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            id,
            entry_id,
            label,
            summary_override,
            content_override,
            mode_override,
            anchor,
            created_at
        ],
    )
    .unwrap();
}

/// base がすべて公開（mentioned）の項目と、その Phase を置く。
fn seed_phase_entries(conn: &Connection) {
    insert_project(conn, "p1", "Novel");
    for (id, name) in [
        ("e-none", "None"),
        ("e-mentioned", "Mentioned"),
        ("e-always", "Always"),
        ("e-suppress", "Suppress"),
        ("e-text-only", "TextOnly"),
        ("e-hidden-phase", "HiddenPhase"),
        ("e-unknown", "Unknown"),
        ("e-inherit", "Inherit"),
        ("e-order", "Order"),
        ("e-other", "Other"),
    ] {
        insert_codex_entry(conn, id, "p1", name, "character");
    }
    // 項目そのものは今までどおり見える（base の要約・本文・タグ・子）。
    conn.execute(
        "UPDATE codex_entries SET summary = 'base-summary', content = 'base-content' \
         WHERE id = 'e-hidden-phase'",
        [],
    )
    .unwrap();
    link_tag(conn, "p1", "e-hidden-phase", "kept-tag");
    insert_codex_entry(conn, "e-child", "p1", "Child", "character");
    conn.execute(
        "UPDATE codex_entries SET parent_id = 'e-hidden-phase' WHERE id = 'e-child'",
        [],
    )
    .unwrap();

    insert_phase(
        conn,
        "ph-mentioned",
        "e-mentioned",
        "m-label",
        Some("m-summary"),
        None,
        Some("mentioned"),
        None,
        "2024-01-01",
    );
    insert_phase(
        conn,
        "ph-always",
        "e-always",
        "a-label",
        None,
        None,
        Some("always"),
        None,
        "2024-01-01",
    );
    insert_phase(
        conn,
        "ph-suppress",
        "e-suppress",
        "s-label",
        None,
        None,
        Some("suppress"),
        None,
        "2024-01-01",
    );
    // always／suppress の Phase と同じ項目にある override NULL の Phase。hidden の Phase が無い
    // ので返る（NOT EXISTS の内側の allowlist から always／suppress を落とす変異を守る）。
    insert_phase(
        conn,
        "ph-always-null",
        "e-always",
        "a-null-label",
        None,
        Some("always-null-content"),
        None,
        None,
        "2024-01-02",
    );
    insert_phase(
        conn,
        "ph-suppress-null",
        "e-suppress",
        "s-null-label",
        None,
        Some("suppress-null-content"),
        None,
        None,
        "2024-01-02",
    );
    // override が NULL（本文だけ上書き）。hidden の Phase が無い項目では今までどおり返る。
    insert_phase(
        conn,
        "ph-text-only",
        "e-text-only",
        "t-label",
        None,
        Some("text-only-content"),
        None,
        None,
        "2024-01-01",
    );
    insert_phase(
        conn,
        "ph-hidden",
        "e-hidden-phase",
        SECRET_LABEL,
        Some(SECRET_SUMMARY),
        Some(SECRET_CONTENT),
        Some("hidden"),
        Some(SECRET_ANCHOR),
        "2024-01-01",
    );
    // 本番の CHECK は不明値を通さない。試験用 schema にだけ入れて fail-closed を確かめる。
    insert_phase(
        conn,
        "ph-unknown",
        "e-unknown",
        "u-label",
        None,
        Some("unknown-content"),
        Some("weird"),
        None,
        "2024-01-01",
    );
    // 不明な mode の Phase がある項目では、override NULL の Phase も除く（不明も hidden 扱い）。
    insert_phase(
        conn,
        "ph-unknown-null",
        "e-unknown",
        "u-null-label",
        None,
        Some("unknown-null-content"),
        None,
        None,
        "2024-01-02",
    );
    // hidden の Phase（早い）→ override NULL の Phase（遅い）→ mentioned の Phase（最後）。
    insert_phase(
        conn,
        "ph-inh-hidden",
        "e-inherit",
        "i-hidden",
        None,
        None,
        Some("hidden"),
        None,
        "2024-01-01",
    );
    insert_phase(
        conn,
        "ph-inh-null",
        "e-inherit",
        "i-null",
        None,
        Some("inherit-null-content"),
        None,
        None,
        "2024-01-02",
    );
    insert_phase(
        conn,
        "ph-inh-mentioned",
        "e-inherit",
        "i-mentioned",
        None,
        None,
        Some("mentioned"),
        None,
        "2024-01-03",
    );
    // created_at の順と挿入順を逆にして、ORDER BY created_at を守る。
    insert_phase(
        conn,
        "ph-order-late",
        "e-order",
        "o-late",
        None,
        None,
        Some("always"),
        None,
        "2024-03-01",
    );
    insert_phase(
        conn,
        "ph-order-early",
        "e-order",
        "o-early",
        None,
        None,
        Some("mentioned"),
        None,
        "2024-01-01",
    );
    // 別の項目の hidden の Phase は、他の項目（e-text-only など）の結果に効かない。
    insert_phase(
        conn,
        "ph-other-hidden",
        "e-other",
        "x-hidden",
        None,
        None,
        Some("hidden"),
        None,
        "2024-01-01",
    );
}

fn phase_ids(conn: &Connection, entry_id: &str) -> Vec<String> {
    get_codex_entry_full(conn, "p1", entry_id)
        .unwrap()
        .phases
        .into_iter()
        .map(|p| p.id)
        .collect()
}

#[test]
fn hidden_phase_row_is_not_returned_but_the_entry_itself_is() {
    let conn = make_simple_db();
    seed_phase_entries(&conn);
    let full = get_codex_entry_full(&conn, "p1", "e-hidden-phase").unwrap();
    // 行ごと除く（label・要約・本文・mode・anchor の全部）。外した印は付けない。
    assert!(full.phases.is_empty());
    let json = serde_json::to_string(&full).unwrap();
    for leaked in [SECRET_LABEL, SECRET_SUMMARY, SECRET_CONTENT, SECRET_ANCHOR] {
        assert!(!json.contains(leaked), "{leaked} leaked: {json}");
    }
    // 項目そのもの（base）は今までどおり返る。
    assert_eq!(full.summary.summary.as_deref(), Some("base-summary"));
    assert_eq!(full.content, "base-content");
    assert_eq!(full.tags, vec!["kept-tag".to_string()]);
    assert_eq!(codex_ids(&full.children), vec!["e-child"]);
}

#[test]
fn only_public_phases_are_returned() {
    let conn = make_simple_db();
    seed_phase_entries(&conn);
    assert!(phase_ids(&conn, "e-none").is_empty());
    assert_eq!(phase_ids(&conn, "e-mentioned"), vec!["ph-mentioned"]);
    assert_eq!(
        phase_ids(&conn, "e-always"),
        vec!["ph-always", "ph-always-null"]
    );
    assert_eq!(
        phase_ids(&conn, "e-suppress"),
        vec!["ph-suppress", "ph-suppress-null"]
    );
    // hidden の Phase が無い項目の、override が NULL の Phase（本文だけ上書き）は返る。
    // 別の項目（e-other）の hidden の Phase の影響を受けない。
    assert_eq!(phase_ids(&conn, "e-text-only"), vec!["ph-text-only"]);
    // 不明な mode は hidden 扱い（allowlist。fail-closed）。
    assert!(phase_ids(&conn, "e-unknown").is_empty());
    assert!(phase_ids(&conn, "e-other").is_empty());
}

#[test]
fn null_phase_is_dropped_when_the_entry_has_a_hidden_phase() {
    let conn = make_simple_db();
    seed_phase_entries(&conn);
    // hidden（早い）・NULL（遅い）・mentioned（最後）：hidden と、継承しうる NULL を除き、
    // 明示的に mentioned を指定した Phase は返す（順序は見ない）。
    assert_eq!(phase_ids(&conn, "e-inherit"), vec!["ph-inh-mentioned"]);
    // hidden の Phase より前にある NULL の Phase も除く（保守的）。
    insert_phase(
        &conn,
        "ph-inh-null-early",
        "e-inherit",
        "i-null-early",
        None,
        Some("early-null-content"),
        None,
        None,
        "2023-12-31",
    );
    assert_eq!(phase_ids(&conn, "e-inherit"), vec!["ph-inh-mentioned"]);
}

#[test]
fn returned_phases_keep_created_at_order() {
    let conn = make_simple_db();
    seed_phase_entries(&conn);
    assert_eq!(
        phase_ids(&conn, "e-order"),
        vec!["ph-order-early", "ph-order-late"]
    );
}

#[test]
fn base_hidden_entry_stays_not_found_even_with_a_public_phase() {
    let conn = make_simple_db();
    seed_phase_entries(&conn);
    insert_codex_entry(&conn, "e-base-hidden", "p1", "BaseHidden", "character");
    conn.execute(
        "UPDATE codex_entries SET context_mode = 'hidden' WHERE id = 'e-base-hidden'",
        [],
    )
    .unwrap();
    insert_phase(
        &conn,
        "ph-unhide",
        "e-base-hidden",
        "unhide",
        None,
        None,
        Some("mentioned"),
        None,
        "2024-01-01",
    );
    assert!(get_codex_entry_full(&conn, "p1", "e-base-hidden").is_err());
}

/// 本番 schema（`migrate()` 済みの DB。CHECK・外部キー・`version` あり）でも同じ結果になること。
/// `make_simple_db` は手書きの DDL なので、列名や制約の drift をここで拾う。
#[test]
fn production_schema_omits_hidden_phases() {
    let database = grimodex_db::Database::new(std::path::Path::new(":memory:"))
        .expect("open production schema fixture");
    database.migrate().expect("create current schema");
    database
        .with_conn(|conn| {
            insert_project(conn, "p1", "Novel");
            for id in ["e-plain", "e-secret", "e-other"] {
                insert_codex_entry(conn, id, "p1", id, "character");
            }
            // e-plain：hidden の Phase が無い項目（NULL の Phase も返る）。
            insert_phase(
                conn,
                "ph-plain-mentioned",
                "e-plain",
                "plain-m",
                None,
                None,
                Some("mentioned"),
                None,
                "2024-01-01",
            );
            insert_phase(
                conn,
                "ph-plain-null",
                "e-plain",
                "plain-null",
                None,
                Some("plain-null-content"),
                None,
                None,
                "2024-01-02",
            );
            // e-secret：mentioned・NULL・hidden の 3 つ。
            insert_phase(
                conn,
                "ph-secret-mentioned",
                "e-secret",
                "secret-m",
                None,
                None,
                Some("mentioned"),
                None,
                "2024-01-01",
            );
            insert_phase(
                conn,
                "ph-secret-null",
                "e-secret",
                "secret-null",
                None,
                Some("secret-null-content"),
                None,
                None,
                "2024-01-02",
            );
            insert_phase(
                conn,
                "ph-secret-hidden",
                "e-secret",
                SECRET_LABEL,
                Some(SECRET_SUMMARY),
                Some(SECRET_CONTENT),
                Some("hidden"),
                None,
                "2024-01-03",
            );
            insert_phase(
                conn,
                "ph-other-hidden",
                "e-other",
                "x-hidden",
                None,
                None,
                Some("hidden"),
                None,
                "2024-01-01",
            );
            assert_eq!(
                phase_ids(conn, "e-plain"),
                vec!["ph-plain-mentioned", "ph-plain-null"]
            );
            // hidden の Phase と、継承しうる NULL の Phase は返らず、mentioned の Phase は返る。
            assert_eq!(phase_ids(conn, "e-secret"), vec!["ph-secret-mentioned"]);
            // 別の項目の hidden の Phase は、他の項目に効かない。
            assert!(phase_ids(conn, "e-other").is_empty());
            let json = serde_json::to_string(&get_codex_entry_full(conn, "p1", "e-secret")?)?;
            for leaked in [
                SECRET_LABEL,
                SECRET_SUMMARY,
                SECRET_CONTENT,
                "secret-null-content",
            ] {
                assert!(!json.contains(leaked), "{leaked} leaked: {json}");
            }
            Ok(())
        })
        .expect("production schema read");
}
