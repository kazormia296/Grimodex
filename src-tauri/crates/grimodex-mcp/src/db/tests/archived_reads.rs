//! lane E2-c（DR-ARC-2）：archived の場面・folder を、外部 AI へ出る読み系 tool から外す。
//!
//! 規則は行単位。場面（または folder）自身の `archived_at IS NULL` だけを見て、祖先は見ない。
//! この file の db 層の試験は `make_simple_db`（`archived_at` 列あり）で、本番 schema の試験は
//! 末尾（`production_schema_*`）で `grimodex_db::Database::migrate()` を使う。
use super::*;
use rusqlite::params;

const ARCHIVED_AT: &str = "2026-11-01T00:00:00Z";

fn node(
    conn: &Connection,
    (id, project_id, parent_id, node_type): (&str, &str, Option<&str>, &str),
    (title, synopsis, sort_order, story_time_order): (&str, Option<&str>, &str, Option<&str>),
    (content, archived): (&str, bool),
) {
    conn.execute(
        "INSERT INTO tree_nodes
         (id, project_id, parent_id, node_type, title, synopsis, sort_order,
          story_time_order, story_time_label, status, content, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10, ?11)",
        params![
            id,
            project_id,
            parent_id,
            node_type,
            title,
            synopsis,
            sort_order,
            story_time_order,
            story_time_order.map(|o| format!("label-{o}")),
            content,
            archived.then_some(ARCHIVED_AT),
        ],
    )
    .unwrap();
}

/// 木（p1）。archived は a-* の行だけ。
///
/// ```text
/// f-live   (folder, live)       a0  synopsis "live-chapter-outline"
///   s1     (scene, live)        a0  story a1
///   a-s2   (scene, ARCHIVED)    a1  story a2
///   s3     (scene, live)        a2  story a3
/// a-fold   (folder, ARCHIVED)   a1  synopsis "archived-chapter-outline"
///   s4     (scene, live)        a0  story a4   ← 祖先だけ archived
/// s5       (scene, live, root)  a2  story a5
/// ```
/// 別 project p2 に live の x1 と archived の a-x2。content はどれも `moonlight` を含む。
pub(crate) fn seed_archive_tree(conn: &Connection) {
    insert_project(conn, "p1", "Novel");
    insert_project(conn, "p2", "Other");
    let p1 = |id, parent, node_type| (id, "p1", parent, node_type);
    node(
        conn,
        p1("f-live", None, "folder"),
        ("Live Chapter", Some("live-chapter-outline"), "a0", None),
        ("{}", false),
    );
    node(
        conn,
        p1("s1", Some("f-live"), "scene"),
        ("Alpha live", Some("alpha-syn"), "a0", Some("a1")),
        ("moonlight", false),
    );
    node(
        conn,
        p1("a-s2", Some("f-live"), "scene"),
        ("Archived scene", Some("archived-syn"), "a1", Some("a2")),
        ("moonlight moonlight moonlight", true),
    );
    node(
        conn,
        p1("s3", Some("f-live"), "scene"),
        ("Gamma live", Some("gamma-syn"), "a2", Some("a3")),
        ("moonlight", false),
    );
    node(
        conn,
        p1("a-fold", None, "folder"),
        (
            "Archived Chapter",
            Some("archived-chapter-outline"),
            "a1",
            None,
        ),
        ("{}", true),
    );
    node(
        conn,
        p1("s4", Some("a-fold"), "scene"),
        (
            "Delta under archived folder",
            Some("delta-syn"),
            "a0",
            Some("a4"),
        ),
        ("moonlight", false),
    );
    node(
        conn,
        p1("s5", None, "scene"),
        ("Epsilon root", Some("epsilon-syn"), "a2", Some("a5")),
        ("moonlight", false),
    );
    node(
        conn,
        ("x1", "p2", None, "scene"),
        ("Foreign live", Some("foreign-syn"), "a0", Some("a1")),
        ("moonlight", false),
    );
    node(
        conn,
        ("a-x2", "p2", None, "scene"),
        ("Foreign archived", Some("foreign-archived-syn"), "a1", None),
        ("moonlight", true),
    );
}

/// 本番の `tree_nodes_fts`（`migrate.rs`）と同じ定義。試験用 schema には無いので足す。
pub(crate) fn seed_tree_nodes_fts(conn: &Connection) {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE tree_nodes_fts USING fts5(
             title, content,
             content=tree_nodes, content_rowid=rowid, tokenize='trigram'
         );
         INSERT INTO tree_nodes_fts(tree_nodes_fts) VALUES('rebuild');",
    )
    .unwrap();
}

fn tree_db() -> Connection {
    let conn = make_simple_db();
    seed_archive_tree(&conn);
    conn
}

fn sorted_ids(nodes: &[TreeNode]) -> Vec<&str> {
    let mut v: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    v.sort_unstable();
    v
}

fn sorted_hit_ids(hits: &[SearchResult]) -> Vec<&str> {
    let mut v: Vec<&str> = hits.iter().map(|h| h.id.as_str()).collect();
    v.sort_unstable();
    v
}

fn hit_ids(hits: &[SearchResult]) -> Vec<&str> {
    hits.iter().map(|h| h.id.as_str()).collect()
}

// ─── list_tree_nodes / get_scene_meta / find_scene_by_title / get_scene_content ───

#[test]
fn list_tree_nodes_excludes_archived_rows() {
    let conn = tree_db();
    let nodes = list_tree_nodes(&conn, "p1", &TreeFilter::default()).unwrap();
    // 祖先だけ archived の s4 は行単位の規則で残る。別 project の行は出ない。
    assert_eq!(sorted_ids(&nodes), ["f-live", "s1", "s3", "s4", "s5"]);
    let by_status = list_tree_nodes(
        &conn,
        "p1",
        &TreeFilter {
            node_type: Some("scene".into()),
            status: Some("draft".into()),
        },
    )
    .unwrap();
    assert_eq!(sorted_ids(&by_status), ["s1", "s3", "s4", "s5"]);
}

#[test]
fn list_tree_nodes_with_archived_keeps_rows_and_flags_them() {
    let conn = tree_db();
    let rows = list_tree_nodes_with_archived(&conn, "p1", &TreeFilter::default()).unwrap();
    let mut flags: Vec<(&str, bool)> = rows.iter().map(|(n, a)| (n.id.as_str(), *a)).collect();
    flags.sort_unstable();
    assert_eq!(
        flags,
        [
            ("a-fold", true),
            ("a-s2", true),
            ("f-live", false),
            ("s1", false),
            ("s3", false),
            ("s4", false),
            ("s5", false),
        ]
    );
}

fn tn(id: &str, parent: Option<&str>) -> TreeNode {
    TreeNode {
        id: id.into(),
        project_id: "p1".into(),
        parent_id: parent.map(Into::into),
        node_type: "scene".into(),
        title: id.into(),
        synopsis: None,
        sort_order: "a0".into(),
        status: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn parents(nodes: &[TreeNode]) -> Vec<(&str, Option<&str>)> {
    nodes
        .iter()
        .map(|n| (n.id.as_str(), n.parent_id.as_deref()))
        .collect()
}

#[test]
fn collapse_promotes_live_rows_into_the_archived_row_slot() {
    let conn = tree_db();
    let rows = list_tree_nodes_with_archived(&conn, "p1", &TreeFilter::default()).unwrap();
    let collapsed = collapse_archived_nodes(rows);
    // 先行順：f-live の子 → a-fold の位置に s4 → s5。archived の 2 行は出ない。
    assert_eq!(
        parents(&collapsed),
        [
            ("f-live", None),
            ("s1", Some("f-live")),
            ("s3", Some("f-live")),
            ("s4", None),
            ("s5", None),
        ]
    );
}

#[test]
fn collapse_reparents_to_the_nearest_live_ancestor_through_nested_archived_rows() {
    let rows = vec![
        (tn("live", None), false),
        (tn("arch1", Some("live")), true),
        (tn("arch2", Some("arch1")), true),
        (tn("deep", Some("arch2")), false),
        (tn("sibling", Some("live")), false),
    ];
    assert_eq!(
        parents(&collapse_archived_nodes(rows)),
        [
            ("live", None),
            ("deep", Some("live")),
            ("sibling", Some("live"))
        ]
    );
}

#[test]
fn collapse_is_identity_without_archived_rows_and_drops_unreachable_rows() {
    let rows = vec![
        (tn("a", None), false),
        (tn("b", Some("a")), false),
        (tn("c", None), false),
        (tn("lost", Some("missing-parent")), false),
    ];
    assert_eq!(
        parents(&collapse_archived_nodes(rows)),
        [("a", None), ("b", Some("a")), ("c", None)],
        "親が見つからない行は、従来どおり root から届かず返らない"
    );
}

#[test]
fn get_scene_meta_and_content_hide_archived_scene() {
    let conn = tree_db();
    let err = get_scene_meta(&conn, "p1", "a-s2").unwrap_err();
    assert!(err.to_string().contains("Scene 'a-s2' not found"), "{err}");
    assert!(get_scene_content(&conn, "p1", "a-s2").is_err());
    // live は読める。祖先だけ archived の s4 も（行単位）。別 project の id は元から読めない。
    assert_eq!(get_scene_meta(&conn, "p1", "s1").unwrap().id, "s1");
    assert_eq!(get_scene_meta(&conn, "p1", "s4").unwrap().id, "s4");
    assert!(get_scene_content(&conn, "p1", "s4").is_ok());
    assert!(get_scene_meta(&conn, "p1", "x1").is_err());
}

#[test]
fn find_scene_by_title_hides_archived_scene() {
    let conn = tree_db();
    assert!(find_scene_by_title(&conn, "p1", "scene")
        .unwrap()
        .is_empty());
    let live = find_scene_by_title(&conn, "p1", "Delta").unwrap();
    assert_eq!(sorted_ids(&live), ["s4"]);
}

// ─── search_fts（scenes）：LIKE の arm と FTS の arm ───

#[test]
fn search_fts_like_arm_excludes_archived_scene() {
    let conn = tree_db();
    // 2 文字は trigram に載らないので LIKE（`to_fts_match` が空）。
    let hits = search_fts(&conn, "p1", "mo", "scenes", 20).unwrap();
    assert_eq!(sorted_hit_ids(&hits), ["s1", "s3", "s4", "s5"]);
    let all = search_fts(&conn, "p1", "mo", "all", 20).unwrap();
    assert!(!hit_ids(&all).contains(&"a-s2"));
}

#[test]
fn search_fts_fts_arm_excludes_archived_scene() {
    let conn = tree_db();
    seed_tree_nodes_fts(&conn);
    let hits = search_fts(&conn, "p1", "moonlight", "scenes", 20).unwrap();
    assert_eq!(sorted_hit_ids(&hits), ["s1", "s3", "s4", "s5"]);
}

fn rank_crowded_db() -> Connection {
    // archived が rank の上位を 3 件占める（語の出現が多い）。live は n4 の 1 件。
    let conn = make_simple_db();
    insert_project(&conn, "p1", "Novel");
    for (i, archived) in [(1, true), (2, true), (3, true), (4, false)] {
        let content = if archived {
            "moonlight moonlight moonlight moonlight moonlight moonlight"
        } else {
            "moonlight"
        };
        node(
            &conn,
            (&format!("n{i}"), "p1", None, "scene"),
            (&format!("Scene {i}"), None, &format!("a{i}"), None),
            (content, archived),
        );
    }
    seed_tree_nodes_fts(&conn);
    conn
}

#[test]
fn search_fts_fts_arm_filters_archived_before_limit() {
    let conn = rank_crowded_db();
    let hits = search_fts(&conn, "p1", "moonlight", "scenes", 2).unwrap();
    assert_eq!(
        hit_ids(&hits),
        ["n4"],
        "LIMIT の前に絞る。archived で枠が埋まって live が押し出されない"
    );
}

#[test]
fn search_fts_like_arm_filters_archived_before_limit() {
    let conn = rank_crowded_db();
    let hits = search_fts(&conn, "p1", "mo", "scenes", 1).unwrap();
    assert_eq!(hit_ids(&hits), ["n4"]);
}

// ─── get_chapter_summaries / get_scene_timeline_neighbors ───

#[test]
fn chapter_summaries_exclude_archived_folder_and_scene() {
    let conn = tree_db();
    let summaries = get_chapter_summaries(&conn, "p1").unwrap();
    // archived の folder は出ない。その下の live の s4 も出ない（folder ごとの一覧。
    // アプリ内の agent tool と同じ）。
    let folder_ids: Vec<&str> = summaries.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(folder_ids, ["f-live"]);
    let mut scene_ids: Vec<&str> = summaries[0].scenes.iter().map(|s| s.id.as_str()).collect();
    scene_ids.sort_unstable();
    assert_eq!(scene_ids, ["s1", "s3"]);
}

#[test]
fn timeline_neighbors_skip_archived_scenes_and_fill_the_window_with_live_ones() {
    let conn = tree_db();
    // s3（story a3）の前は s1 だけ（a-s2 は archived）。
    let n = get_scene_timeline_neighbors(&conn, "p1", "s3").unwrap();
    let prev: Vec<&str> = n.previous.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(prev, ["s1"]);
    let s1 = get_scene_timeline_neighbors(&conn, "p1", "s1").unwrap();
    let next: Vec<&str> = s1.next.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(next, ["s3", "s4", "s5"]);
    // archived の場面自身を target にすると、場面が無い場合と同じ空の形。
    let own = get_scene_timeline_neighbors(&conn, "p1", "a-s2").unwrap();
    assert_eq!(own.current_scene_story_time_label, None);
    assert!(own.previous.is_empty() && own.next.is_empty());
}

#[test]
fn timeline_neighbor_window_of_three_is_not_spent_on_archived_scenes() {
    let conn = make_simple_db();
    insert_project(&conn, "p1", "Novel");
    for (i, archived) in [
        (1, false),
        (2, true),
        (3, true),
        (4, true),
        (5, false),
        (6, false),
    ] {
        node(
            &conn,
            (&format!("n{i}"), "p1", None, "scene"),
            (&format!("Scene {i}"), None, "a0", Some(&format!("a{i}"))),
            ("{}", archived),
        );
    }
    let n = get_scene_timeline_neighbors(&conn, "p1", "n1").unwrap();
    let next: Vec<&str> = n.next.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(next, ["n5", "n6"]);
}

// ─── foreshadow ───

fn seed_foreshadow_on_archived(conn: &Connection) {
    let now = 1_700_000_000_000_i64;
    conn.execute(
        "INSERT INTO foreshadows (id, project_id, title, intent, secret, payoff_scene_id, created_at, updated_at)
         VALUES ('f1', 'p1', 'Gun', 'hint', 0, 'a-s2', ?1, ?1)",
        params![now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO foreshadows (id, project_id, title, intent, secret, created_at, updated_at)
         VALUES ('f2', 'p1', 'OnlyArchivedSetup', 'hint', 0, ?1, ?1)",
        params![now],
    )
    .unwrap();
    for (id, foreshadow, scene, orphan) in [
        ("su-live", "f1", "s1", 0),
        ("su-arch", "f1", "a-s2", 0),
        ("su-gone", "f1", "s-missing", 1),
        ("su-arch2", "f2", "a-s2", 0),
    ] {
        conn.execute(
            "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, kind, is_orphan, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'designated_existing', ?4, ?5, ?5)",
            params![id, foreshadow, scene, orphan, now],
        )
        .unwrap();
    }
}

#[test]
fn foreshadow_detail_hides_archived_payoff_and_setup() {
    let conn = tree_db();
    seed_foreshadow_on_archived(&conn);
    let d = get_foreshadow_detail(&conn, "p1", "f1").unwrap().unwrap();
    assert!(d.payoff_scene.is_none(), "archived の payoff は null");
    let setup_scenes: Vec<&str> = d.setups.iter().map(|s| s.scene_id.as_str()).collect();
    assert_eq!(setup_scenes, ["s1"], "setups の件数は配列の長さで見る");
}

#[test]
fn list_open_foreshadows_does_not_count_archived_setups() {
    let conn = tree_db();
    seed_foreshadow_on_archived(&conn);
    let open = list_open_foreshadows(&conn, "p1").unwrap();
    let count = |id: &str| open.iter().find(|f| f.id == id).unwrap().setup_count;
    assert_eq!(
        count("f1"),
        1,
        "live の s1 だけ。orphan と archived は数えない"
    );
    assert_eq!(count("f2"), 0, "archived の場面にだけある setup は数えない");
    assert_eq!(open.len(), 2, "伏線そのものは今までどおり出る");
}

// ─── 古い DB（archived_at 列が無い）：probe は入れない ───

#[test]
fn database_without_archived_at_column_fails_reads_instead_of_returning_archived_rows() {
    // 条件を無条件に足している（列の有無を probe しない。`foreshadows.secret` と同じ先例）。
    // 列が無い DB では読みが「no such column」で失敗する。archived の行が漏れる向きではない。
    let conn = tree_db();
    conn.execute_batch("ALTER TABLE tree_nodes DROP COLUMN archived_at;")
        .unwrap();
    let err = list_tree_nodes(&conn, "p1", &TreeFilter::default()).unwrap_err();
    assert!(format!("{err:#}").contains("archived_at"), "{err:#}");
    assert!(get_scene_meta(&conn, "p1", "s1").is_err());
    assert!(search_fts(&conn, "p1", "mo", "scenes", 20).is_err());
}

// ─── 本番 schema（`grimodex_db::Database::migrate()`）─────────────────────────
// 手書きの試験用 DDL と本番の `tree_nodes`・`tree_nodes_fts`・`archived_at` が
// 名前・型で食い違わないことを確かめる（drift の検出）。

fn with_production_db(f: impl FnOnce(&Connection) -> anyhow::Result<()>) {
    let database = grimodex_db::Database::new(std::path::Path::new(":memory:"))
        .expect("open production-schema fixture");
    database.migrate().expect("create current schema");
    database
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'Novel')",
                [],
            )?;
            for (id, title, content, archived) in [
                ("live", "Live scene", "moonlight", None),
                ("arch", "Archived scene", "moonlight", Some(ARCHIVED_AT)),
            ] {
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content, archived_at)
                     VALUES (?1, 'p1', 'scene', ?2, ?3, ?4)",
                    params![id, title, content, archived],
                )?;
            }
            f(conn)
        })
        .expect("production-schema fixture");
}

#[test]
fn production_schema_hides_archived_scene() {
    with_production_db(|conn| {
        let hits = search_fts(conn, "p1", "moonlight", "scenes", 20)?;
        assert_eq!(sorted_hit_ids(&hits), ["live"], "FTS の arm");
        let like = search_fts(conn, "p1", "mo", "scenes", 20)?;
        assert_eq!(sorted_hit_ids(&like), ["live"], "LIKE の arm");
        assert!(get_scene_meta(conn, "p1", "arch").is_err());
        assert_eq!(get_scene_meta(conn, "p1", "live")?.id, "live");
        let nodes = list_tree_nodes(conn, "p1", &TreeFilter::default())?;
        assert_eq!(sorted_ids(&nodes), ["live"]);
        let rows = list_tree_nodes_with_archived(conn, "p1", &TreeFilter::default())?;
        let mut flags: Vec<(&str, bool)> = rows.iter().map(|(n, a)| (n.id.as_str(), *a)).collect();
        flags.sort_unstable();
        assert_eq!(flags, [("arch", true), ("live", false)]);
        Ok(())
    });
}
