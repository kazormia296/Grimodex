use super::{test_support::Fixture, *};

fn prepared() -> (Fixture, NirQualifiedBatch) {
    let f = Fixture::new();
    let (plan, documents) = f.prepare();
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(documents))
            .expect("publish current proof"),
        NirIndexPublishRead::Published {
            newly_usable_published: true,
            ..
        }
    ));
    let batch =
        f.db.with_read_transaction(|conn| {
            let NirQualifiedRead::Qualified(batch) = qualify_chronicle_index_query(
                conn,
                &f.runtime,
                f.project(),
                f.manifest["s2"].as_str().expect("S2"),
            )?
            else {
                panic!("current query");
            };
            assert!(super::read_identity::ReadIdentity::read(conn)?.is_some());
            Ok(batch)
        })
        .expect("first committed read");
    (f, batch)
}

fn valid(f: &Fixture, batch: &NirQualifiedBatch) -> bool {
    f.db.with_read_transaction(|conn| validate_chronicle_query_snapshot(conn, &f.runtime, batch))
        .expect("query validation")
}

#[test]
fn cached_read_cannot_survive_a_temporary_repair_rolled_back_with_unchanged_change_count() {
    for use_savepoint in [false, true] {
        let (f, batch) = prepared();
        assert!(valid(&f, &batch));
        f.db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_consumer_freshness SET build_action='revalidate-exact'
                WHERE consumer_kind='semantic-index'",
                [],
            )?;
            Ok(())
        })
        .expect("canonical row is no longer usable");
        assert!(!valid(&f, &batch));
        f.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            if use_savepoint {
                tx.execute_batch("SAVEPOINT temporary_repair")?;
            }
            tx.execute(
                "UPDATE narrative_consumer_freshness SET build_action='none'
                WHERE consumer_kind='semantic-index'",
                [],
            )?;
            assert!(validate_chronicle_query_snapshot(&tx, &f.runtime, &batch)?);
            assert!(
                super::read_identity::ReadIdentity::read(&tx)?.is_none(),
                "an uncommitted write cannot seed or hit the read cache"
            );
            let changes = crate::read_sqlite_source_revision(&tx)?.total_changes;
            if use_savepoint {
                tx.execute_batch("ROLLBACK TO temporary_repair; RELEASE temporary_repair")?;
                assert!(super::read_identity::ReadIdentity::read(&tx)?.is_none());
                assert!(!validate_chronicle_query_snapshot(&tx, &f.runtime, &batch)?);
            }
            tx.rollback()?;
            assert_eq!(
                crate::read_sqlite_source_revision(conn)?.total_changes,
                changes
            );
            Ok(())
        })
        .expect("rollback preserves the stale committed authority");
        assert!(
            !valid(&f, &batch),
            "temporary repair must not escape rollback"
        );
    }
}

#[test]
fn external_commit_invalidates_the_next_snapshot_without_rewriting_the_held_read_snapshot() {
    let (f, batch) = prepared();
    assert!(valid(&f, &batch));
    let path =
        f.db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT file FROM pragma_database_list WHERE name='main'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("own fixture path");
    let other = rusqlite::Connection::open(path).expect("second fixture connection");
    f.db.with_read_transaction(|conn| {
        assert!(validate_chronicle_query_snapshot(conn, &f.runtime, &batch)?);
        let before = super::read_identity::ReadIdentity::read(conn)?;
        other.execute(
            "UPDATE narrative_consumer_freshness SET build_action='revalidate-exact'
            WHERE consumer_kind='semantic-index'",
            [],
        )?;
        assert_eq!(
            super::read_identity::ReadIdentity::read(conn)?,
            before,
            "a pinned read keeps its own database version"
        );
        assert!(validate_chronicle_query_snapshot(conn, &f.runtime, &batch)?);
        Ok(())
    })
    .expect("coherent snapshot across an external commit");
    assert!(
        !valid(&f, &batch),
        "new snapshot must observe the external commit"
    );
}

#[test]
fn schema_only_changes_cannot_reuse_a_cached_canonical_verdict() {
    let (f, batch) = prepared();
    assert!(valid(&f, &batch));
    f.db.with_conn(|conn| {
        let before = crate::read_sqlite_source_revision(conn)?.total_changes;
        conn.execute_batch(
            "ALTER TABLE narrative_consumer_freshness RENAME TO unavailable_freshness",
        )?;
        assert_eq!(
            crate::read_sqlite_source_revision(conn)?.total_changes,
            before
        );
        Ok(())
    })
    .expect("schema mutation without row changes");
    assert!(
        f.db.with_read_transaction(|conn| validate_chronicle_query_snapshot(
            conn, &f.runtime, &batch
        ))
        .is_err(),
        "the missing canonical table remains a storage error"
    );
}

#[test]
fn temp_schema_changes_and_runtime_revocation_are_not_hidden_by_an_identical_main_database() {
    let (f, batch) = prepared();
    let before =
        f.db.with_read_transaction(super::read_identity::ReadIdentity::read)
            .expect("read identity");
    f.db.with_conn(|conn| {
        conn.execute_batch("CREATE TEMP TABLE proof_identity_test(value INTEGER)")?;
        Ok(())
    })
    .expect("private temp schema change");
    let after =
        f.db.with_read_transaction(super::read_identity::ReadIdentity::read)
            .expect("new read identity");
    assert_ne!(before, after);
    assert!(
        valid(&f, &batch),
        "unchanged authority can pass a fresh full check"
    );
    f.runtime.pause().expect("pause runtime");
    f.runtime
        .resume()
        .expect("resume without borrowing the old proof");
    assert!(!valid(&f, &batch));
}
