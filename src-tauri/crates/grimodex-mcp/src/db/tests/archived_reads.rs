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

// ─── list_tree_nodes / get_scene_meta / find_scene_by_title / get_scene_content ───

#[test]
fn list_tree_nodes_returns_archived_rows_today() {
    let conn = tree_db();
    let nodes = list_tree_nodes(&conn, "p1", &TreeFilter::default()).unwrap();
    assert_eq!(
        sorted_ids(&nodes),
        ["a-fold", "a-s2", "f-live", "s1", "s3", "s4", "s5"]
    );
}

#[test]
fn get_scene_meta_and_content_return_archived_scene_today() {
    let conn = tree_db();
    assert_eq!(get_scene_meta(&conn, "p1", "a-s2").unwrap().id, "a-s2");
    assert!(get_scene_content(&conn, "p1", "a-s2").is_ok());
    assert_eq!(get_scene_meta(&conn, "p1", "s1").unwrap().id, "s1");
}

#[test]
fn find_scene_by_title_returns_archived_scene_today() {
    let conn = tree_db();
    let hits = find_scene_by_title(&conn, "p1", "scene").unwrap();
    assert_eq!(sorted_ids(&hits), ["a-s2"]);
}

// ─── search_fts（scenes）：LIKE の arm と FTS の arm ───

#[test]
fn search_fts_like_arm_returns_archived_scene_today() {
    let conn = tree_db();
    // 2 文字は trigram に載らないので LIKE（`to_fts_match` が空）。
    let hits = search_fts(&conn, "p1", "mo", "scenes", 20).unwrap();
    assert_eq!(
        sorted_hit_ids(&hits),
        ["a-s2", "s1", "s3", "s4", "s5"],
        "p2 の行は出ない。archived の a-s2 は今は出る"
    );
}

#[test]
fn search_fts_fts_arm_returns_archived_scene_today() {
    let conn = tree_db();
    seed_tree_nodes_fts(&conn);
    let hits = search_fts(&conn, "p1", "moonlight", "scenes", 20).unwrap();
    assert_eq!(sorted_hit_ids(&hits), ["a-s2", "s1", "s3", "s4", "s5"]);
}

#[test]
fn search_fts_fts_arm_limit_is_spent_on_archived_rows_today() {
    // archived が rank の上位を占めると、LIMIT が archived で埋まって live が押し出される。
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
    let hits = search_fts(&conn, "p1", "moonlight", "scenes", 2).unwrap();
    assert_eq!(hits.len(), 2);
    assert!(
        !hit_ids(&hits).contains(&"n4"),
        "live の n4 は LIMIT で押し出されている: {:?}",
        hit_ids(&hits)
    );
}

fn hit_ids(hits: &[SearchResult]) -> Vec<&str> {
    hits.iter().map(|h| h.id.as_str()).collect()
}

// ─── get_chapter_summaries / get_scene_timeline_neighbors ───

#[test]
fn chapter_summaries_include_archived_folder_and_scene_today() {
    let conn = tree_db();
    let summaries = get_chapter_summaries(&conn, "p1").unwrap();
    let mut folder_ids: Vec<&str> = summaries.iter().map(|c| c.id.as_str()).collect();
    folder_ids.sort_unstable();
    assert_eq!(folder_ids, ["a-fold", "f-live"]);
    let live = summaries.iter().find(|c| c.id == "f-live").unwrap();
    let mut scene_ids: Vec<&str> = live.scenes.iter().map(|s| s.id.as_str()).collect();
    scene_ids.sort_unstable();
    assert_eq!(scene_ids, ["a-s2", "s1", "s3"]);
    let archived = summaries.iter().find(|c| c.id == "a-fold").unwrap();
    assert_eq!(
        archived.scenes.len(),
        1,
        "live の s4 は archived の folder の下"
    );
}

#[test]
fn timeline_neighbors_include_archived_scene_today() {
    let conn = tree_db();
    // s3（story a3）の前は a-s2（a2）→ s1（a1）。
    let n = get_scene_timeline_neighbors(&conn, "p1", "s3").unwrap();
    let prev: Vec<&str> = n.previous.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(prev, ["a-s2", "s1"]);
    // archived の場面自身を target にしても今は読める。
    let own = get_scene_timeline_neighbors(&conn, "p1", "a-s2").unwrap();
    assert_eq!(
        own.current_scene_story_time_label.as_deref(),
        Some("label-a2")
    );
    assert_eq!(own.next.first().map(|t| t.id.as_str()), Some("s3"));
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
    for (id, scene, orphan) in [
        ("su-live", "s1", 0),
        ("su-arch", "a-s2", 0),
        ("su-gone", "s-missing", 1),
    ] {
        conn.execute(
            "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, kind, is_orphan, created_at, updated_at)
             VALUES (?1, 'f1', ?2, 'designated_existing', ?3, ?4, ?4)",
            params![id, scene, orphan, now],
        )
        .unwrap();
    }
}

#[test]
fn foreshadow_detail_shows_archived_payoff_and_setup_today() {
    let conn = tree_db();
    seed_foreshadow_on_archived(&conn);
    let d = get_foreshadow_detail(&conn, "p1", "f1").unwrap().unwrap();
    assert_eq!(d.payoff_scene.as_ref().map(|p| p.id.as_str()), Some("a-s2"));
    let mut setup_scenes: Vec<&str> = d.setups.iter().map(|s| s.scene_id.as_str()).collect();
    setup_scenes.sort_unstable();
    assert_eq!(setup_scenes, ["a-s2", "s1"]);
}

#[test]
fn list_open_foreshadows_counts_archived_setup_today() {
    let conn = tree_db();
    seed_foreshadow_on_archived(&conn);
    let open = list_open_foreshadows(&conn, "p1").unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(
        open[0].setup_count, 2,
        "s1 と archived の a-s2（orphan は数えない）"
    );
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
fn production_schema_reads_archived_scene_today() {
    with_production_db(|conn| {
        let hits = search_fts(conn, "p1", "moonlight", "scenes", 20)?;
        assert_eq!(sorted_hit_ids(&hits), ["arch", "live"]);
        assert_eq!(get_scene_meta(conn, "p1", "arch")?.id, "arch");
        let nodes = list_tree_nodes(conn, "p1", &TreeFilter::default())?;
        assert_eq!(sorted_ids(&nodes), ["arch", "live"]);
        Ok(())
    });
}
