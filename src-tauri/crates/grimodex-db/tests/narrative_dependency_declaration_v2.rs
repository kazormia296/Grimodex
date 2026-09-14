//! D1 public-behaviour contract for sealed Dependency Declaration storage.
//!
//! These tests intentionally exercise the typed writer through the public
//! `grimodex_db::narrative_extraction` surface.  They are the RED contract for
//! SCHEMA 33: the SCHEMA 32 parent has no declaration-set storage yet.

#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_db::narrative_extraction::{
    read_active_dependency_declaration_set, verify_dependency_declaration_storage,
    write_dependency_declaration_set, DependencyDeclaration, DependencyDeclarationSetRequest,
    DependencyDeclarationSetState,
};
use grimodex_db::Database;
use rusqlite::params;

const PROJECT_ID: &str = "d1-project";
const CONSUMER_KIND: &str = "proposal-revision";
const CONSUMER_KEY: &str = "revision-1";
const CREATED_AT: &str = "2026-08-24T00:00:00.000Z";

fn migrated_db() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    seed_project(db)
}

fn fresh_migrated_db() -> Database {
    let db = test_support::fresh_migrated_memory().expect("migrate database");
    seed_project(db)
}

fn seed_project(db: Database) -> Database {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'D1 fixture')",
            [PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed project");
    db
}

fn request(
    producer_id: &str,
    producer_generation: i64,
    expected_head_version: i64,
    declarations: Vec<DependencyDeclaration>,
) -> DependencyDeclarationSetRequest {
    DependencyDeclarationSetRequest {
        project_id: PROJECT_ID.to_owned(),
        consumer_kind: CONSUMER_KIND.to_owned(),
        consumer_key: CONSUMER_KEY.to_owned(),
        producer_id: producer_id.to_owned(),
        producer_generation,
        expected_head_version,
        declarations,
        created_at: CREATED_AT.to_owned(),
    }
}

fn scene_declaration(source: &str) -> DependencyDeclaration {
    DependencyDeclaration {
        source_object_identity: source.to_owned(),
        role: DependencyRole::DirectEvidence,
        selector: DependencySelector::WholeSource,
    }
}

fn text_range_declaration(source: &str, from: u64, to: u64) -> DependencyDeclaration {
    DependencyDeclaration {
        source_object_identity: source.to_owned(),
        role: DependencyRole::DirectEvidence,
        selector: DependencySelector::TextRange {
            unit: "utf16".to_owned(),
            from,
            to,
            normalizer_version: "nfc-v1".to_owned(),
            anchor_digest: None,
        },
    }
}

#[test]
fn migration_adds_schema_33_sealed_declaration_storage() {
    let db = fresh_migrated_db();
    let (version, tables): (i32, Vec<String>) = db
        .with_conn(|conn| {
            let version = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
            let mut statement = conn.prepare(
                "SELECT name FROM sqlite_master
                   WHERE type = 'table'
                     AND name LIKE 'narrative_dependency_declaration%'
                  ORDER BY name",
            )?;
            let tables = statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            Ok::<_, anyhow::Error>((version, tables))
        })
        .expect("inspect D1 schema");

    // D1's declaration tables are introduced at SCHEMA 33; the current
    // migration continues through the NIR-1 SCHEMA 36 checkpoint.
    assert_eq!(version, 36);
    assert_eq!(
        tables,
        vec![
            "narrative_dependency_declaration_entries",
            "narrative_dependency_declaration_heads",
            "narrative_dependency_declaration_sets",
        ]
    );
}

#[test]
fn typed_writer_seals_a_complete_set_and_updates_head_atomically() {
    let db = migrated_db();
    let receipt = write_dependency_declaration_set(
        &db,
        request(
            "chronicle-v2",
            1,
            0,
            vec![
                text_range_declaration("project:scene:scene-2", 1, 4),
                scene_declaration("project:scene:scene-1"),
            ],
        ),
    )
    .expect("write sealed declaration set");

    assert_eq!(receipt.state, DependencyDeclarationSetState::Sealed);
    assert_eq!(receipt.head_version, 1);
    assert!(receipt.dependency_set_digest.starts_with("sha256:"));

    db.with_conn(|conn| {
        let set: (String, String, i64, String, String) = conn.query_row(
            "SELECT state, dependency_set_digest, producer_generation,
                    producer_id, consumer_kind
               FROM narrative_dependency_declaration_sets
              WHERE id = ?1",
            [receipt.declaration_set_id.as_str()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(set.0, "sealed");
        assert_eq!(set.1, receipt.dependency_set_digest);
        assert_eq!(set.2, 1);
        assert_eq!(set.3, "chronicle-v2");
        assert_eq!(set.4, CONSUMER_KIND);

        let entry_count: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_dependency_declaration_entries
              WHERE declaration_set_id = ?1",
            [receipt.declaration_set_id.as_str()],
            |row| row.get(0),
        )?;
        assert_eq!(entry_count, 2);

        let head: (String, i64, i64, String) = conn.query_row(
            "SELECT active_declaration_set_id, producer_generation, version, producer_id
               FROM narrative_dependency_declaration_heads
              WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
            params![PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(head.0, receipt.declaration_set_id);
        assert_eq!(head.1, 1);
        assert_eq!(head.2, 1);
        assert_eq!(head.3, "chronicle-v2");
        Ok::<_, anyhow::Error>(())
    })
    .expect("inspect sealed set and head");

    let active =
        read_active_dependency_declaration_set(&db, PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY)
            .expect("read active declaration set")
            .expect("active V2 declaration set");
    assert_eq!(active.declaration_set_id, receipt.declaration_set_id);
    assert_eq!(active.entries.len(), 2);
    assert!(verify_dependency_declaration_storage(&db).expect("verify D1 storage"));
}

#[test]
fn writer_rolls_back_every_row_when_one_declaration_is_invalid() {
    let db = migrated_db();
    let error = write_dependency_declaration_set(
        &db,
        request(
            "chronicle-v2",
            1,
            0,
            vec![
                scene_declaration("project:scene:valid"),
                DependencyDeclaration {
                    source_object_identity: "project:scene:invalid".to_owned(),
                    role: DependencyRole::DirectEvidence,
                    selector: DependencySelector::TextRange {
                        unit: "utf8".to_owned(),
                        from: 0,
                        to: 1,
                        normalizer_version: "nfc-v1".to_owned(),
                        anchor_digest: None,
                    },
                },
            ],
        ),
    )
    .expect_err("invalid selector must fail before commit");
    assert!(error.to_string().contains("UTF-16") || error.to_string().contains("text-range"));

    db.with_conn(|conn| {
        for table in [
            "narrative_dependency_declaration_entries",
            "narrative_dependency_declaration_sets",
            "narrative_dependency_declaration_heads",
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 0, "invalid set must not leave rows in {table}");
        }
        Ok::<_, anyhow::Error>(())
    })
    .expect("inspect rollback");
}

#[test]
fn head_requires_expected_version_and_strictly_increasing_producer_generation() {
    let db = migrated_db();
    let first = write_dependency_declaration_set(
        &db,
        request(
            "producer-a",
            4,
            0,
            vec![scene_declaration("project:scene:one")],
        ),
    )
    .expect("first generation");

    let stale_version = write_dependency_declaration_set(
        &db,
        request(
            "producer-b",
            5,
            0,
            vec![scene_declaration("project:scene:two")],
        ),
    )
    .expect_err("stale head version must fail");
    assert!(stale_version.to_string().contains("version"));

    let old_generation = write_dependency_declaration_set(
        &db,
        request(
            "producer-b",
            3,
            1,
            vec![scene_declaration("project:scene:two")],
        ),
    )
    .expect_err("same or older generation must fail");
    assert!(old_generation.to_string().contains("generation"));

    let second = write_dependency_declaration_set(
        &db,
        request(
            "producer-b",
            5,
            first.head_version,
            vec![scene_declaration("project:scene:two")],
        ),
    )
    .expect("new generation with matching CAS");
    assert_eq!(second.head_version, 2);

    let replay = write_dependency_declaration_set(
        &db,
        request(
            "producer-b",
            5,
            0,
            vec![scene_declaration("project:scene:two")],
        ),
    )
    .expect("exact same-generation replay reuses the sealed head");
    assert_eq!(replay.declaration_set_id, second.declaration_set_id);
    assert_eq!(replay.head_version, second.head_version);

    db.with_conn(|conn| {
        let set_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_declaration_sets",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(set_count, 2);
        Ok::<_, anyhow::Error>(())
    })
    .expect("inspect replay idempotency");
}

#[test]
fn incomplete_or_corrupt_v2_storage_fails_closed_without_hiding_v1() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, created_at)
             VALUES ('v1-edge', ?1, ?2, ?3, 'project:scene:v1', '[]', ?4)",
            params![PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY, CREATED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_declaration_sets
                (id, project_id, consumer_kind, consumer_key, producer_id,
                 producer_generation, dependency_set_digest, state, created_at)
             VALUES ('partial-set', ?1, ?2, ?3, 'producer', 1,
                     'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                     'sealed', ?4)",
            params![PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY, CREATED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_declaration_heads
                (project_id, consumer_kind, consumer_key, active_declaration_set_id,
                 producer_id, producer_generation, version, updated_at)
             VALUES (?1, ?2, ?3, 'partial-set', 'producer', 1, 1, ?4)",
            params![PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY, CREATED_AT],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed incomplete V2 state");

    assert!(!verify_dependency_declaration_storage(&db).expect("verify corruption"));
    let active =
        read_active_dependency_declaration_set(&db, PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY)
            .expect("read fallback result");
    assert!(
        active.is_none(),
        "incomplete V2 must not become an active V2 read"
    );

    let v1_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE project_id = ?1 AND consumer_kind = ?2 AND consumer_key = ?3",
                params![PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY],
                |row| row.get(0),
            )?)
        })
        .expect("read V1 compatibility edge");
    assert_eq!(v1_count, 1);
}

#[test]
fn rewinding_the_marker_and_removing_d1_objects_replays_migration() {
    let db = fresh_migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch(
            "DROP TABLE narrative_dependency_declaration_heads;
             DROP TABLE narrative_dependency_declaration_entries;
             DROP TABLE narrative_dependency_declaration_sets;
             PRAGMA user_version = 32;",
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("rewind fixture to C2-ZB schema");

    db.migrate().expect("replay D1 schema migration");
    let version: i32 = db
        .with_conn(|conn| Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?))
        .expect("read replayed marker");
    // Replaying from the historical SCHEMA 32 parent runs D1 (33) and then
    // reaches the current NIR-1 checkpoint (36).
    assert_eq!(version, 36);
    assert!(verify_dependency_declaration_storage(&db).expect("verify replayed schema"));
}

#[test]
fn repeated_selectors_cannot_borrow_another_entries_binding_or_a_previous_read() {
    use grimodex_core::narrative_dependency::{
        compute_dependency_set_digest, DependencySetDigestEntry,
    };
    for field in [
        "dependency_role",
        "selector_json",
        "selector_digest",
        "dependency_key",
    ] {
        let db = migrated_db();
        let receipt = write_dependency_declaration_set(
            &db,
            request(
                "repeated-selector",
                1,
                0,
                (0..8)
                    .map(|i| scene_declaration(&format!("project:scene:repeated-{i}")))
                    .collect(),
            ),
        )
        .expect("seal repeated complete selectors");
        let read = || {
            read_active_dependency_declaration_set(&db, PROJECT_ID, CONSUMER_KIND, CONSUMER_KEY)
                .expect("read complete set")
        };
        assert_eq!(read().expect("valid set").entries.len(), 8);
        assert_eq!(read().expect("fresh independent read").entries.len(), 8);
        db.with_conn(|conn| {
            let value = match field {
                "dependency_role" => "ranking-only".to_owned(),
                "selector_json" => "{ \"kind\": \"whole-source\" }".to_owned(),
                _ => format!("sha256:{}", "0".repeat(64)),
            };
            conn.execute(
                &format!("UPDATE narrative_dependency_declaration_entries SET {field}=?1
                    WHERE id=(SELECT id FROM narrative_dependency_declaration_entries
                    WHERE declaration_set_id=?2 ORDER BY id DESC LIMIT 1)"),
                params![value, receipt.declaration_set_id],
            )?;
            // Bind the aggregate to the altered tuple: rejection must also
            // validate that tuple, not depend only on a stale set digest.
            let mut statement = conn.prepare("SELECT source_object_identity,dependency_key,selector_digest
                FROM narrative_dependency_declaration_entries WHERE declaration_set_id=?1")?;
            let entries = statement.query_map([&receipt.declaration_set_id], |row| Ok(
                DependencySetDigestEntry {
                    source_object_identity: row.get(0)?,
                    dependency_key: row.get(1)?,
                    selector_digest: row.get(2)?,
                }
            ))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let digest = compute_dependency_set_digest(&entries)?;
            conn.execute("UPDATE narrative_dependency_declaration_sets SET dependency_set_digest=?1 WHERE id=?2",
                params![digest, receipt.declaration_set_id])?;
            Ok(())
        }).expect("bounded storage-corruption fixture");
        assert!(read().is_none(), "altered {field} must be revalidated");
    }
}
