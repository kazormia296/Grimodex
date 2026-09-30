use super::*;

const PROJECT: &str = "project-a";
const SCENE: &str = "scene-a";
const CONTENT: &str =
    r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}"#;

fn source_connection(
    content: &str,
    version: i64,
    updated_at: &str,
    archived_at: Option<&str>,
) -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch(
        "CREATE TABLE projects (
             id TEXT PRIMARY KEY,
             phase_resolution_mode TEXT NOT NULL
         );
         CREATE TABLE tree_nodes (
             id TEXT PRIMARY KEY,
             project_id TEXT NOT NULL,
             node_type TEXT NOT NULL,
             version INTEGER NOT NULL,
             updated_at TEXT NOT NULL,
             content TEXT NOT NULL,
             archived_at TEXT
         );",
    )?;
    conn.execute(
        "INSERT INTO projects (id, phase_resolution_mode) VALUES (?1, ?2)",
        params![PROJECT, "reading"],
    )?;
    conn.execute(
        "INSERT INTO tree_nodes
             (id, project_id, node_type, version, updated_at, content, archived_at)
         VALUES (?1, ?2, 'scene', ?3, ?4, ?5, ?6)",
        params![SCENE, PROJECT, version, updated_at, content, archived_at],
    )?;
    conn.execute_batch("BEGIN")?;
    Ok(conn)
}

fn persisted_bytes(content: &str, updated_at: &str, archived_at: Option<&str>) -> usize {
    "reading".len() + updated_at.len() + content.len() + archived_at.map(str::len).unwrap_or(0)
}

#[test]
fn bounded_reader_preserves_source_binding_and_reports_monotone_peak() -> Result<()> {
    let updated_at = "2026-09-23T00:00:00Z";
    let archived_at = Some("archived");
    let conn = source_connection(CONTENT, 7, updated_at, archived_at)?;
    let mut peaks = Vec::new();
    let mut admit_peak = |bytes| {
        peaks.push(bytes);
        Ok(())
    };
    let mut checkpoints = 0;
    let mut checkpoint = || {
        checkpoints += 1;
        Ok(())
    };

    let result = read_retrieval_scene_source_bounded(
        &conn,
        PROJECT,
        SCENE,
        persisted_bytes(CONTENT, updated_at, archived_at),
        128,
        &mut checkpoint,
        &mut admit_peak,
    )?;
    let RetrievalSceneSourceRead::Available(source) = result else {
        anyhow::bail!("expected source")
    };
    assert_eq!(source.project_id, PROJECT);
    assert_eq!(source.scene_id, SCENE);
    assert_eq!(source.phase_resolution_mode, "reading");
    assert!(source.archived);
    assert_eq!(source.saved_content_json, CONTENT);
    assert_eq!(source.canonical_source_text, "hello");
    assert_eq!(
        source.query_source,
        RetrievalSceneSourceBinding {
            source_key: "project:scene:scene-a".into(),
            revision_token: format!("v7@{updated_at}"),
            source_version: 7,
            normalizer_version: CANONICAL_TEXT_NORMALIZER_VERSION,
            canonical_text_digest: digest(b"hello"),
            storage_digest: digest(CONTENT.as_bytes()),
            canonical_utf16_length: 5,
        }
    );
    assert!(checkpoints >= 4);
    assert_eq!(
        peaks.first(),
        Some(&persisted_bytes(CONTENT, updated_at, archived_at))
    );
    assert!(peaks.windows(2).all(|pair| pair[0] < pair[1]));
    Ok(())
}

#[test]
fn bounded_reader_rejects_persisted_strings_over_limit_before_admission() -> Result<()> {
    let updated_at = "2026-09-23T00:00:00Z";
    let conn = source_connection(CONTENT, 7, updated_at, None)?;
    let mut peaks = Vec::new();
    let mut admit_peak = |bytes| {
        peaks.push(bytes);
        Ok(())
    };
    let mut checkpoint = || Ok(());

    let error = read_retrieval_scene_source_bounded(
        &conn,
        PROJECT,
        SCENE,
        persisted_bytes(CONTENT, updated_at, None) - 1,
        128,
        &mut checkpoint,
        &mut admit_peak,
    )
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("NIR1_RETRIEVAL_SCENE_SOURCE_INPUT_LIMIT"));
    assert!(peaks.is_empty());
    Ok(())
}

#[test]
fn bounded_reader_fails_closed_on_invalid_json() -> Result<()> {
    let invalid = r#"{"type":"doc","content":["#;
    let updated_at = "2026-09-23T00:00:00Z";
    let conn = source_connection(invalid, 7, updated_at, None)?;
    let mut admit_peak = |_| Ok(());
    let mut checkpoint = || Ok(());

    let error = read_retrieval_scene_source_bounded(
        &conn,
        PROJECT,
        SCENE,
        persisted_bytes(invalid, updated_at, None),
        128,
        &mut checkpoint,
        &mut admit_peak,
    )
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("NEX_CANONICAL_TEXT_INVALID_JSON"));
    Ok(())
}

#[test]
fn bounded_reader_checks_cancellation_before_materializing_source() -> Result<()> {
    let updated_at = "2026-09-23T00:00:00Z";
    let conn = source_connection(CONTENT, 7, updated_at, None)?;
    let mut peaks = Vec::new();
    let mut admit_peak = |bytes| {
        peaks.push(bytes);
        Ok(())
    };
    let mut checkpoints = 0;
    let mut checkpoint = || {
        checkpoints += 1;
        if checkpoints == 2 {
            anyhow::bail!("cancelled")
        }
        Ok(())
    };

    let error = read_retrieval_scene_source_bounded(
        &conn,
        PROJECT,
        SCENE,
        persisted_bytes(CONTENT, updated_at, None),
        128,
        &mut checkpoint,
        &mut admit_peak,
    )
    .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    assert_eq!(peaks, vec![persisted_bytes(CONTENT, updated_at, None)]);
    assert_eq!(checkpoints, 2);
    Ok(())
}
