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
fn cached_read_cannot_survive_a_temporary_repair_rolled_back_with_a_reused_sequence() {
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
        f.db.with_conn_mut(|conn| {
            let committed = crate::read_db_clock(conn)?.seq;
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            if use_savepoint {
                tx.execute_batch("SAVEPOINT temporary_repair")?;
            }
            tx.execute(
                "UPDATE narrative_consumer_freshness SET build_action='none'
                WHERE consumer_kind='semantic-index'",
                [],
            )?;
            assert!(validate_chronicle_query_snapshot(&mut tx, &f.runtime, &batch)?);
            assert!(
                super::read_identity::ReadIdentity::read(&tx)?.is_none(),
                "an uncommitted write cannot seed or hit the read cache"
            );
            // The write moved the sequence inside the transaction. A rollback
            // gives the same value back, so a value read here must never be kept.
            assert!(crate::read_db_clock(&tx)?.seq > committed);
            if use_savepoint {
                tx.execute_batch("ROLLBACK TO temporary_repair; RELEASE temporary_repair")?;
                assert!(super::read_identity::ReadIdentity::read(&tx)?.is_none());
                assert!(!validate_chronicle_query_snapshot(&mut tx, &f.runtime, &batch)?);
            }
            tx.rollback()?;
            assert_eq!(
                crate::read_db_clock(conn)?.seq,
                committed,
                "a rolled-back write leaves the committed sequence (DR-DBC-5)"
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

/// DR-DBC-5 §1.5: a sequence read in a write transaction is reused after a
/// rollback by an unrelated commit. The identity is therefore never observable
/// there, and the same value read after the rollback names a different state.
#[test]
fn a_sequence_value_read_in_a_write_transaction_is_reused_by_another_commit() {
    let f = Fixture::new();
    f.db.with_conn(|conn| {
        let committed = crate::read_db_clock(conn)?.seq;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO app_settings(key, value) VALUES ('aba-probe', 'rolled-back')",
            [],
        )?;
        let in_tx = crate::read_db_clock(&tx)?.seq;
        assert!(super::read_identity::ReadIdentity::read(&tx)?.is_none());
        tx.rollback()?;
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES ('aba-probe', 'committed')",
            [],
        )?;
        assert_eq!(
            crate::read_db_clock(conn)?.seq,
            in_tx,
            "another content reached the same sequence value"
        );
        assert_eq!(in_tx, committed + 1);
        Ok(())
    })
    .expect("sequence reuse after rollback");
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
        let before = crate::read_db_clock(conn)?.seq;
        conn.execute_batch(
            "ALTER TABLE narrative_consumer_freshness RENAME TO unavailable_freshness",
        )?;
        assert_eq!(
            crate::read_db_clock(conn)?.seq,
            before,
            "a schema change writes no row, so only the schema version names it"
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

/// DR-DBC-5: the TEMP schema is private to one connection and no covered read
/// depends on it, so it no longer moves the identity (the former H-e). A runtime
/// revocation is still not hidden by an identical main database.
#[test]
fn temp_schema_changes_do_not_move_the_identity_and_runtime_revocation_is_not_hidden() {
    let (f, batch) = prepared();
    let before =
        f.db.with_read_transaction(|conn| super::read_identity::ReadIdentity::read(conn))
            .expect("read identity");
    f.db.with_conn(|conn| {
        conn.execute_batch("CREATE TEMP TABLE proof_identity_test(value INTEGER)")?;
        Ok(())
    })
    .expect("private temp schema change");
    let after =
        f.db.with_read_transaction(|conn| super::read_identity::ReadIdentity::read(conn))
            .expect("new read identity");
    assert_eq!(before, after);
    assert!(valid(&f, &batch), "unchanged authority passes");
    f.runtime.pause().expect("pause runtime");
    f.runtime
        .resume()
        .expect("resume without borrowing the old proof");
    assert!(!valid(&f, &batch));
}

/// DR-DBC-5: the identity is the in-database write clock, so it depends on the clock
/// triggers. With them a write moves it; the invariant `has_v46_write_clock` is what
/// keeps a database without them from being opened for writes (the fail-open case is
/// refused there, not here).
#[test]
fn read_identity_follows_the_clock_triggers_and_the_invariant_names_their_absence() {
    let mut verdicts = Vec::new();
    for drop_clock_triggers in [false, true] {
        let f = Fixture::new();
        f.db.with_conn(|conn| {
            let names: Vec<String> = conn
                .prepare(
                    "SELECT name FROM sqlite_master
                      WHERE type = 'trigger' AND name GLOB 'grimodex_clock_*'",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            assert!(
                !names.is_empty(),
                "the fixture is a current-schema database with clock triggers"
            );
            if drop_clock_triggers {
                for name in names {
                    conn.execute_batch(&format!("DROP TRIGGER \"{name}\""))?;
                }
            }
            Ok(())
        })
        .expect("arrange triggers");
        let read = || {
            f.db.with_read_transaction(|conn| super::read_identity::ReadIdentity::read(conn))
                .expect("read identity")
        };
        let first = read();
        let second = read();
        assert!(first.is_some());
        let unchanged = first == second;
        f.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO app_settings(key, value) VALUES ('identity-probe', '1')",
                [],
            )?;
            Ok(())
        })
        .expect("write");
        let after_write = read();
        let invariant =
            f.db.with_conn(grimodex_core::write_clock::has_v46_write_clock)
                .expect("invariant");
        verdicts.push((unchanged, first != after_write, invariant));
    }
    assert_eq!(verdicts, [(true, true, true), (true, false, false)]);
}
