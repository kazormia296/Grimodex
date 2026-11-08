//! `verify_ai_audit_chain_for_scope` の高速化（S1 直接直列化＋上限つきの並列）が、
//! 従来の逐次の検証と同じ結果になることの試験。合成の fixture だけを使う。
//!
//! `verify_reference` は、高速化の前の実装（origin/master 5344067d）をそのまま写したもの。
//! 新しい検証は、複数の計画（thread 数・batch の大きさ）で、この oracle と比べる。

use super::*;
use crate::Database;
use serde_json::json;

const PROJECT: &str = "project-1";
const SCOPE: &str = "project:project-1";
/// 複数の batch に分かれ、かつ速く終わる大きさ。
const ROWS: i64 = 400;
const MID: i64 = 200;

/// 高速化の前の実装（oracle）。
fn verify_reference(
    conn: &Connection,
    project_id: Option<&str>,
    high_water_sequence: Option<i64>,
) -> anyhow::Result<AiAuditVerifyResult> {
    let scope_id = ai_audit_scope_id(project_id)?;
    let (tail_sequence, tail_hash) = current_tail(conn, &scope_id)?;
    let high_water_sequence = high_water_sequence.unwrap_or(tail_sequence);
    anyhow::ensure!(
        (0..=tail_sequence).contains(&high_water_sequence),
        "highWaterSequence exceeds current tail"
    );
    let high_water_hash = if high_water_sequence == tail_sequence {
        tail_hash
    } else if high_water_sequence == 0 {
        GENESIS_HASH_HEX.to_string()
    } else {
        conn.query_row(
            "SELECT hash FROM ai_audit_events WHERE scope_id = ? AND sequence = ?",
            params![scope_id, high_water_sequence],
            |row| row.get(0),
        )
        .optional()?
        .context("high-water event is missing")?
    };
    let mut expected_sequence = 1i64;
    let mut prev_hash = GENESIS_HASH_HEX.to_string();
    let mut statement = conn.prepare(
        "SELECT sequence, event_id, scope_id, project_id, execution_id, operation_id,
                parent_execution_id, path_id, event_type, timestamp, recorded_at,
                payload, payload_sha256, prev_hash, hash
         FROM ai_audit_events
         WHERE scope_id = ? AND sequence <= ?
         ORDER BY sequence ASC",
    )?;
    let rows = statement.query_map(params![scope_id, high_water_sequence], event_from_row)?;

    for row in rows {
        let event = row?;
        let broken = |reason: String| AiAuditVerifyResult {
            ok: false,
            verified_through_sequence: expected_sequence - 1,
            broken_at_sequence: Some(expected_sequence),
            reason: Some(reason),
            tail_hash: high_water_hash.clone(),
        };
        if event.sequence != expected_sequence {
            return Ok(broken(format!(
                "sequence gap: expected {expected_sequence}, found {}",
                event.sequence
            )));
        }
        if event.prev_hash != prev_hash {
            return Ok(broken("prevHash mismatch".to_string()));
        }
        if let Err(error) = validate_stored_capture_contract(&event.payload) {
            return Ok(broken(format!("stored payload contract mismatch: {error}")));
        }
        let payload = match canonical_stored_payload(&event.payload) {
            Ok(payload) => payload,
            Err(error) => {
                return Ok(broken(format!("stored payload is invalid: {error}")));
            }
        };
        let payload_sha256 = sha256_hex(payload.as_bytes());
        if event.payload_sha256 != payload_sha256 {
            return Ok(broken("payloadSha256 mismatch".to_string()));
        }
        let hash = compute_hash(HashInput {
            scope_id: &event.scope_id,
            project_id: event.project_id.as_deref(),
            sequence: event.sequence,
            event_id: &event.event_id,
            execution_id: &event.execution_id,
            operation_id: &event.operation_id,
            parent_execution_id: event.parent_execution_id.as_deref(),
            path_id: &event.path_id,
            event_type: &event.event_type,
            timestamp: event.timestamp,
            recorded_at: event.recorded_at,
            payload_sha256: &event.payload_sha256,
            prev_hash: &event.prev_hash,
        })?;
        if event.hash != hash {
            return Ok(broken("hash mismatch".to_string()));
        }
        prev_hash = event.hash;
        expected_sequence += 1;
    }

    if expected_sequence - 1 != high_water_sequence {
        return Ok(AiAuditVerifyResult {
            ok: false,
            verified_through_sequence: expected_sequence - 1,
            broken_at_sequence: Some(expected_sequence),
            reason: Some("sequence gap before pinned high-water mark".to_string()),
            tail_hash: high_water_hash,
        });
    }

    Ok(AiAuditVerifyResult {
        ok: true,
        verified_through_sequence: high_water_sequence,
        broken_at_sequence: None,
        reason: None,
        tail_hash: high_water_hash,
    })
}

fn database() -> Database {
    let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, created_at, updated_at)
             VALUES ('project-1', 'Project', datetime('now'), datetime('now'))",
            [],
        )?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn event(index: i64) -> AppendAiAuditEvent {
    // 行ごとに別の execution を開始する（execution の規則に触れず、chain だけを伸ばす）。
    AppendAiAuditEvent {
        event_id: format!("event-{index}"),
        execution_id: format!("execution-{index}"),
        operation_id: "operation-1".to_string(),
        parent_execution_id: None,
        path_id: "chat.direct".to_string(),
        event_type: "execution.started".to_string(),
        timestamp: 1_000 + index,
        // key の順・入れ子・小数・非 ASCII・エスケープを混ぜる（保存は正規形になる）。
        payload: json!({
            "zeta": [1, 2.5, -0.125, {"b": 1, "a": [true, null]}],
            "captureState": "complete",
            "credentialsExcluded": true,
            "message": format!("合成 {index} \"quote\"\n\t\u{1}"),
            "nested": {"y": {"k2": 2, "k1": 1}, "x": index},
            "alpha": 1.0e-7,
        }),
    }
}

fn fixture() -> Database {
    let db = database();
    for start in (0..ROWS).step_by(100) {
        let events: Vec<_> = (start..(start + 100).min(ROWS)).map(event).collect();
        db.append_ai_audit_events(PROJECT, &events).expect("append");
    }
    db
}

fn plans() -> Vec<(&'static str, Option<VerifyPlan>)> {
    let plan = |workers, batch_rows| {
        Some(VerifyPlan {
            workers,
            batch_rows,
        })
    };
    vec![
        ("default", None),
        ("w1 b64", plan(1, 64)),
        ("w2 b64", plan(2, 64)),
        ("w4 b50", plan(4, 50)),
        ("w3 b7", plan(3, 7)),
        ("w4 b1024 (single batch)", plan(4, 1_024)),
        ("w8 b1 (degenerate)", plan(8, 1)),
        ("w4 b399 (tail batch of 1)", plan(4, 399)),
    ]
}

fn show(result: &anyhow::Result<AiAuditVerifyResult>) -> String {
    match result {
        Ok(result) => format!("{result:?}"),
        Err(error) => format!("ERR {error:#}"),
    }
}

/// 改ざんを transaction の中で行い、oracle と全 plan を比べて、最後に ROLLBACK する。
/// oracle の結果を返す（試験が「検出できている」ことを確かめるため）。
fn assert_all_plans_match(
    conn: &Connection,
    high_water: Option<i64>,
    name: &str,
    tamper: impl FnOnce(&Connection),
) -> anyhow::Result<AiAuditVerifyResult> {
    conn.execute_batch("BEGIN").unwrap();
    tamper(conn);
    let expected = verify_reference(conn, Some(PROJECT), high_water);
    for (plan_name, plan) in plans() {
        let actual = verify_ai_audit_chain_with_plan(conn, Some(PROJECT), high_water, plan);
        assert_eq!(
            show(&expected),
            show(&actual),
            "case `{name}` differs under plan `{plan_name}`"
        );
    }
    conn.execute_batch("ROLLBACK").unwrap();
    expected
}

fn execute(conn: &Connection, sql: &str, sequence: i64) {
    let updated = conn
        .execute(sql, params![SCOPE, sequence])
        .expect("tamper sql");
    assert!(updated <= 1);
}

fn expect_broken(result: anyhow::Result<AiAuditVerifyResult>, sequence: i64, reason: &str) {
    let result = result.expect("verification result");
    assert!(!result.ok);
    assert_eq!(result.broken_at_sequence, Some(sequence));
    assert_eq!(result.verified_through_sequence, sequence - 1);
    assert_eq!(result.reason.as_deref(), Some(reason));
}

fn stored_payload(conn: &Connection, sequence: i64) -> String {
    conn.query_row(
        "SELECT payload FROM ai_audit_events WHERE scope_id = ? AND sequence = ?",
        params![SCOPE, sequence],
        |row| row.get(0),
    )
    .unwrap()
}

/// key の順を逆にして、同じ JSON で正規形でない text を作る。
fn reversed_keys(value: &Value, recursive: bool) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .rev()
                .map(|(key, value)| {
                    let value = if recursive {
                        reversed_keys(value, true)
                    } else {
                        value.clone()
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        Value::Array(items) if recursive => {
            Value::Array(items.iter().map(|item| reversed_keys(item, true)).collect())
        }
        other => other.clone(),
    }
}

fn non_canonical_text(conn: &Connection, sequence: i64, recursive: bool) -> String {
    let stored: Value = serde_json::from_str(&stored_payload(conn, sequence)).unwrap();
    let text = serde_json::to_string(&reversed_keys(&stored, recursive)).unwrap();
    assert_ne!(
        text,
        stored_payload(conn, sequence),
        "must be non-canonical"
    );
    text
}

/// `start` 以降の全行の hash を、保存された列から計算し直し、chain を自己整合させる。
fn rechain_from(conn: &Connection, start: i64) {
    let mut previous: Option<String> = None;
    for sequence in start..=ROWS {
        if let Some(previous) = &previous {
            conn.execute(
                "UPDATE ai_audit_events SET prev_hash = ? WHERE scope_id = ? AND sequence = ?",
                params![previous, SCOPE, sequence],
            )
            .unwrap();
        }
        let row = conn
            .query_row(
                "SELECT sequence, event_id, scope_id, project_id, execution_id, operation_id,
                        parent_execution_id, path_id, event_type, timestamp, recorded_at,
                        payload, payload_sha256, prev_hash, hash
                 FROM ai_audit_events WHERE scope_id = ? AND sequence = ?",
                params![SCOPE, sequence],
                stored_row_from_row,
            )
            .unwrap();
        let hash = compute_hash(HashInput {
            scope_id: &row.scope_id,
            project_id: row.project_id.as_deref(),
            sequence: row.sequence,
            event_id: &row.event_id,
            execution_id: &row.execution_id,
            operation_id: &row.operation_id,
            parent_execution_id: row.parent_execution_id.as_deref(),
            path_id: &row.path_id,
            event_type: &row.event_type,
            timestamp: row.timestamp,
            recorded_at: row.recorded_at,
            payload_sha256: &row.payload_sha256,
            prev_hash: &row.prev_hash,
        })
        .unwrap();
        conn.execute(
            "UPDATE ai_audit_events SET hash = ? WHERE scope_id = ? AND sequence = ?",
            params![hash, SCOPE, sequence],
        )
        .unwrap();
        previous = Some(hash);
    }
}

const APPEND_KEY: &str =
    "UPDATE ai_audit_events SET payload = substr(payload, 1, length(payload) - 1) || ',\"zz\":1}'
     WHERE scope_id = ? AND sequence = ?";
const FLIP_HASH: &str =
    "UPDATE ai_audit_events SET hash = 'ff' || substr(hash, 3) WHERE scope_id = ? AND sequence = ?";
const FLIP_PREV: &str = "UPDATE ai_audit_events SET prev_hash = 'ff' || substr(prev_hash, 3)
     WHERE scope_id = ? AND sequence = ?";
const FLIP_PAYLOAD_SHA: &str =
    "UPDATE ai_audit_events SET payload_sha256 = 'ff' || substr(payload_sha256, 3)
     WHERE scope_id = ? AND sequence = ?";
const SET_PAYLOAD_INVALID: &str =
    "UPDATE ai_audit_events SET payload = '{\"a\":' WHERE scope_id = ? AND sequence = ?";

fn with_fixture(test: impl FnOnce(&Connection)) {
    let db = fixture();
    db.with_conn(|conn| {
        // 試験の前提：改ざんの前は、どの plan でも正常。
        for (name, plan) in plans() {
            let result =
                verify_ai_audit_chain_with_plan(conn, Some(PROJECT), None, plan).expect("verify");
            assert!(result.ok, "{name}");
            assert_eq!(result.verified_through_sequence, ROWS);
        }
        test(conn);
        Ok(())
    })
    .unwrap();
}

#[test]
fn intact_chain_and_pinned_high_water_match_the_reference() {
    with_fixture(|conn| {
        let intact = assert_all_plans_match(conn, None, "intact", |_| {}).unwrap();
        assert!(intact.ok);
        assert_eq!(intact.verified_through_sequence, ROWS);
        let pinned = assert_all_plans_match(conn, Some(MID), "pinned", |_| {}).unwrap();
        assert!(pinned.ok);
        assert_eq!(pinned.verified_through_sequence, MID);
        // pin より後の改ざんは見ない。
        let ok = assert_all_plans_match(conn, Some(MID), "tamper after pin", |c| {
            execute(c, FLIP_HASH, MID + 50)
        })
        .unwrap();
        assert!(ok.ok);
        // 空の scope。
        let empty = verify_ai_audit_chain_with_plan(conn, Some("no-such"), None, None).unwrap();
        assert!(empty.ok);
        assert_eq!(empty.verified_through_sequence, 0);
    });
}

#[test]
fn field_tampering_is_reported_at_the_same_row_with_the_same_reason() {
    with_fixture(|conn| {
        let case = |name: &str, sql: &'static str, sequence: i64, reason: &str| {
            let result = assert_all_plans_match(conn, None, name, |c| execute(c, sql, sequence));
            expect_broken(result, sequence, reason);
        };
        case(
            "payload tampered",
            APPEND_KEY,
            MID,
            "payloadSha256 mismatch",
        );
        case("hash tampered", FLIP_HASH, MID, "hash mismatch");
        case(
            "hash tampered at last row",
            FLIP_HASH,
            ROWS,
            "hash mismatch",
        );
        case("prev_hash tampered", FLIP_PREV, MID, "prevHash mismatch");
        case(
            "prev_hash tampered at first row",
            FLIP_PREV,
            1,
            "prevHash mismatch",
        );
        case(
            "payload_sha256 tampered",
            FLIP_PAYLOAD_SHA,
            MID,
            "payloadSha256 mismatch",
        );
        case(
            "contract: recorder changed",
            "UPDATE ai_audit_events SET payload = json_set(payload, '$.recorder', 'x')
             WHERE scope_id = ? AND sequence = ?",
            MID,
            "stored payload contract mismatch: payload.recorder is unsupported",
        );
        case(
            "payload is a JSON array",
            "UPDATE ai_audit_events SET payload = '[1,2]' WHERE scope_id = ? AND sequence = ?",
            MID,
            "stored payload contract mismatch: payload must be a JSON object",
        );
    });
}

#[test]
fn sequence_gaps_match_the_reference() {
    with_fixture(|conn| {
        let delete = "DELETE FROM ai_audit_events WHERE scope_id = ? AND sequence = ?";
        let gap = assert_all_plans_match(conn, None, "row deleted", |c| execute(c, delete, MID));
        expect_broken(
            gap,
            MID,
            &format!("sequence gap: expected {MID}, found {}", MID + 1),
        );
        // 最終行の削除は、tail が前の行になるので検出されない（元の実装と同じ）。
        let tail =
            assert_all_plans_match(conn, None, "last row deleted", |c| execute(c, delete, ROWS))
                .unwrap();
        assert!(tail.ok);
        assert_eq!(tail.verified_through_sequence, ROWS - 1);
        // pin した high-water の行が消えたら error。
        let missing = assert_all_plans_match(conn, Some(MID), "pinned row deleted", |c| {
            execute(c, delete, MID)
        });
        assert!(missing.is_err());
    });
}

#[test]
fn unreadable_payloads_error_before_the_row_is_judged() {
    with_fixture(|conn| {
        let set =
            |sql: &'static str, sequence: i64| move |c: &Connection| execute(c, sql, sequence);
        for (name, payload) in [
            ("invalid json", "{\"a\":"),
            ("trailing garbage", "{} x"),
            ("number out of range", "{\"a\":1e999}"),
        ] {
            let result = assert_all_plans_match(conn, None, name, |c| {
                c.execute(
                    "UPDATE ai_audit_events SET payload = ? WHERE scope_id = ? AND sequence = ?",
                    params![payload, SCOPE, MID],
                )
                .unwrap();
            });
            assert!(result.is_err(), "{name}");
        }
        // 先の行の壊れが先に報告される（後の行の読めない payload は見ない）。
        let earlier = assert_all_plans_match(conn, None, "hash at 100, unreadable at 300", |c| {
            execute(c, FLIP_HASH, 100);
            execute(c, SET_PAYLOAD_INVALID, 300);
        });
        expect_broken(earlier, 100, "hash mismatch");
        // 読めない payload が先なら error。
        let later = assert_all_plans_match(conn, None, "unreadable at 100, hash at 300", |c| {
            execute(c, SET_PAYLOAD_INVALID, 100);
            execute(c, FLIP_HASH, 300);
        });
        assert!(later.is_err());
        // 同じ行に連番の欠けがあっても、読めない payload の error が先。
        let same_row = assert_all_plans_match(conn, None, "unreadable row after a gap", |c| {
            execute(
                c,
                "DELETE FROM ai_audit_events WHERE scope_id = ? AND sequence = ?",
                MID - 1,
            );
            execute(c, SET_PAYLOAD_INVALID, MID);
        });
        assert!(same_row.is_err());
        let _ = set;
    });
}

#[test]
fn the_first_broken_row_wins_among_many_tamperings() {
    with_fixture(|conn| {
        let result = assert_all_plans_match(conn, None, "multiple", |c| {
            execute(c, FLIP_HASH, 300);
            execute(c, FLIP_HASH, MID);
            execute(c, APPEND_KEY, 100);
            execute(c, FLIP_PREV, 350);
        });
        expect_broken(result, 100, "payloadSha256 mismatch");
        // 同じ行の複数の違反は、逐次の判定の順（prevHash、契約、payloadSha256、hash）。
        let same = assert_all_plans_match(conn, None, "one row, several faults", |c| {
            execute(c, FLIP_HASH, MID);
            execute(c, FLIP_PAYLOAD_SHA, MID);
            execute(c, FLIP_PREV, MID);
        });
        expect_broken(same, MID, "prevHash mismatch");
        let same = assert_all_plans_match(conn, None, "payload sha and hash", |c| {
            execute(c, FLIP_HASH, MID);
            execute(c, FLIP_PAYLOAD_SHA, MID);
        });
        expect_broken(same, MID, "payloadSha256 mismatch");
    });
}

#[test]
fn duplicate_keys_follow_the_last_value_like_the_reference() {
    with_fixture(|conn| {
        let result = assert_all_plans_match(conn, None, "duplicate recorder key", |c| {
            execute(
                c,
                "UPDATE ai_audit_events SET payload = '{\"recorder\":\"x\",' || substr(payload, 2)
                 WHERE scope_id = ? AND sequence = ?",
                MID,
            );
        })
        .unwrap();
        // 最後の key が勝ち、正規形では重複が 1 つになる。元の実装は通すので、同じく通す。
        assert!(result.ok);
    });
}

#[test]
fn non_canonical_payload_text_matches_the_reference() {
    with_fixture(|conn| {
        for recursive in [false, true] {
            let text = non_canonical_text(conn, MID, recursive);
            // 正当に保存されうる形：payload_sha256 は正規形の sha256 のまま。通る。
            let legit = assert_all_plans_match(conn, None, "non-canonical, canonical sha", |c| {
                c.execute(
                    "UPDATE ai_audit_events SET payload = ? WHERE scope_id = ? AND sequence = ?",
                    params![text, SCOPE, MID],
                )
                .unwrap();
            })
            .unwrap();
            assert!(legit.ok, "recursive={recursive}");
            // 自己整合した改ざん：payload_sha256 を生の text の sha256 にし、以降の chain を計算し直す。
            // 今の検証は正規形の sha256 と比べるので止まる（生 bytes の hash だけで通すと弱くなる）。
            let forged =
                assert_all_plans_match(conn, None, "non-canonical, raw sha, rechained", |c| {
                    c.execute(
                        "UPDATE ai_audit_events SET payload = ?, payload_sha256 = ?
                         WHERE scope_id = ? AND sequence = ?",
                        params![text, sha256_hex(text.as_bytes()), SCOPE, MID],
                    )
                    .unwrap();
                    rechain_from(c, MID);
                });
            expect_broken(forged, MID, "payloadSha256 mismatch");
        }
    });
}

#[test]
fn canonical_sha256_helper_equals_the_canonical_form_hash() {
    let sorted = json!({"a": [1, {"b": 2, "c": [3.5, "x"]}], "d": null});
    let unsorted: Value =
        serde_json::from_str(r#"{"d":null,"a":[1,{"c":[3.5,"x"],"b":2}]}"#).unwrap();
    for value in [&sorted, &unsorted] {
        let expected = sha256_hex(canonical_stored_payload(value).unwrap().as_bytes());
        assert_eq!(canonical_stored_payload_sha256(value).unwrap(), expected);
    }
    assert!(json_keys_sorted(&sorted));
    assert!(!json_keys_sorted(&unsorted));
    // object でなければ従来と同じ error。
    let array = json!([1]);
    assert_eq!(
        canonical_stored_payload_sha256(&array)
            .unwrap_err()
            .to_string(),
        canonical_stored_payload(&array).unwrap_err().to_string()
    );
}

#[test]
fn plan_is_sequential_for_small_chains_and_capped_for_large_ones() {
    assert_eq!(VerifyPlan::for_row_count(0).workers, 1);
    assert_eq!(
        VerifyPlan::for_row_count(VERIFY_PARALLEL_MIN_ROWS).workers,
        1
    );
    let large = VerifyPlan::for_row_count(VERIFY_PARALLEL_MIN_ROWS + 1);
    assert!((1..=VERIFY_MAX_WORKERS).contains(&large.workers));
    assert_eq!(large.batch_rows, VERIFY_BATCH_ROWS);
    assert_eq!(
        VerifyPlan::for_row_count(1_000_000).batch_rows,
        VERIFY_BATCH_ROWS
    );
}

/// 製品の関数の前後の時間と memory（合成ではなく実 DB の写しが要るので既定では走らない）。
/// `AUDIT_BENCH_DB=<写し> AUDIT_BENCH_FN=new|reference AUDIT_BENCH_PROJECT=<id>` で実行する。
#[test]
#[ignore]
fn real_db_copy_timing() {
    let path = std::env::var("AUDIT_BENCH_DB").expect("AUDIT_BENCH_DB");
    let which = std::env::var("AUDIT_BENCH_FN").unwrap_or_else(|_| "new".to_string());
    let project = std::env::var("AUDIT_BENCH_PROJECT").unwrap_or_else(|_| "fusion-ir".to_string());
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .unwrap();
    conn.execute_batch("PRAGMA cache_size=-16000;").unwrap();
    let hwm = || -> u64 {
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("VmHWM:"))
            .and_then(|rest| rest.trim().trim_end_matches("kB").trim().parse().ok())
            .unwrap_or(0)
    };
    let before = hwm();
    let mut walls = Vec::new();
    for _ in 0..8 {
        let started = std::time::Instant::now();
        let result = match which.as_str() {
            "reference" => verify_reference(&conn, Some(&project), None),
            _ => verify_ai_audit_chain_for_scope(&conn, Some(&project), None),
        }
        .unwrap();
        assert!(result.ok);
        walls.push(started.elapsed().as_secs_f64() * 1e3);
    }
    let first = walls[0];
    let mut rest = walls[1..].to_vec();
    rest.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "fn={which} first={first:.0}ms median(7 warm)={:.0}ms min={:.0}ms max={:.0}ms VmHWM before={before}kB after={}kB",
        rest[rest.len() / 2],
        rest[0],
        rest[rest.len() - 1],
        hwm()
    );
}
