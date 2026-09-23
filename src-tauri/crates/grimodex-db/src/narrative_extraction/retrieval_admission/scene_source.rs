use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::cell::RefCell;

use super::super::change_feed::{
    canonical_scene_storage_with_admission, scene_canonical_text, CANONICAL_TEXT_NORMALIZER_VERSION,
};
use super::{
    digest, RetrievalSceneSource, RetrievalSceneSourceBinding, RetrievalSceneSourceRead,
    RevisionEligibilityReason,
};

pub fn read_retrieval_scene_source(
    conn: &Connection,
    project: &str,
    scene: &str,
) -> Result<RetrievalSceneSourceRead> {
    ensure!(
        !conn.is_autocommit(),
        "Scene query source requires a read transaction"
    );
    let unavailable = || RetrievalSceneSourceRead::Unavailable {
        reason: RevisionEligibilityReason::QueryContextUnavailable,
    };
    if project.trim().is_empty() || scene.trim().is_empty() {
        return Ok(unavailable());
    }
    let row = conn.query_row(
        "SELECT p.phase_resolution_mode,t.version,t.updated_at,t.content,t.archived_at FROM projects p
         JOIN tree_nodes t ON t.project_id=p.id WHERE p.id=?1 AND t.id=?2
         AND t.node_type='scene'",
        params![project, scene], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,
            r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?)),
    ).optional()?;
    let Some((mode, version, updated_at, content, archived_at)) = row else {
        return Ok(unavailable());
    };
    if version < 0 || updated_at.trim().is_empty() {
        return Ok(unavailable());
    }
    let canonical = scene_canonical_text(&content);
    Ok(RetrievalSceneSourceRead::Available(RetrievalSceneSource {
        project_id: project.into(),
        scene_id: scene.into(),
        phase_resolution_mode: mode,
        archived: archived_at.is_some(),
        query_source: RetrievalSceneSourceBinding {
            source_key: format!("project:scene:{scene}"),
            revision_token: format!("v{version}@{updated_at}"),
            source_version: version,
            normalizer_version: CANONICAL_TEXT_NORMALIZER_VERSION,
            canonical_text_digest: digest(canonical.as_bytes()),
            storage_digest: digest(content.as_bytes()),
            canonical_utf16_length: canonical.encode_utf16().count(),
        },
        saved_content_json: content,
        canonical_source_text: canonical,
        _verified: (),
    }))
}

/// Read an exact saved Scene source inside the caller's read transaction.
///
/// `admit_peak` is non-consuming: it receives monotonically increasing,
/// conservative peak-byte estimates for this one read, including persisted
/// String columns, the streaming parser/projection, and the returned source
/// metadata. The caller checks those estimates against its cumulative budget
/// and accounts the final Raw packing item separately. Scalar lengths are
/// admitted before the second query materializes any String column.
pub(in crate::narrative_extraction) fn read_retrieval_scene_source_bounded(
    conn: &Connection,
    project: &str,
    scene: &str,
    max_storage_bytes: usize,
    max_canonical_bytes: usize,
    checkpoint: &mut impl FnMut() -> Result<()>,
    admit_peak: &mut impl FnMut(usize) -> Result<()>,
) -> Result<RetrievalSceneSourceRead> {
    ensure!(
        !conn.is_autocommit(),
        "Scene query source requires a read transaction"
    );
    let unavailable = || RetrievalSceneSourceRead::Unavailable {
        reason: RevisionEligibilityReason::QueryContextUnavailable,
    };
    if project.trim().is_empty() || scene.trim().is_empty() {
        return Ok(unavailable());
    }
    checkpoint()?;

    // The first pass reads only SQLite scalar lengths and the numeric version.
    // Every String selected below has an octet_length here, including the
    // nullable archived_at value.
    let lengths: Option<(i64, i64, i64, i64, Option<i64>)> = conn
        .query_row(
            "SELECT octet_length(p.phase_resolution_mode), t.version,
                    octet_length(t.updated_at), octet_length(t.content),
                    octet_length(t.archived_at)
               FROM projects p
               JOIN tree_nodes t ON t.project_id = p.id
              WHERE p.id = ?1 AND t.id = ?2 AND t.node_type = 'scene'",
            params![project, scene],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((mode_bytes, version, updated_at_bytes, content_bytes, archived_at_bytes)) = lengths
    else {
        return Ok(unavailable());
    };
    let mode_bytes = checked_length(mode_bytes)?;
    let updated_at_bytes = checked_length(updated_at_bytes)?;
    let content_bytes = checked_length(content_bytes)?;
    let archived_at_bytes = archived_at_bytes
        .map(checked_length)
        .transpose()?
        .unwrap_or(0);
    if version < 0 || updated_at_bytes == 0 {
        return Ok(unavailable());
    }
    let persisted_bytes = checked_sum(&[
        mode_bytes,
        updated_at_bytes,
        content_bytes,
        archived_at_bytes,
    ])?;
    ensure!(
        persisted_bytes <= max_storage_bytes,
        "NIR1_RETRIEVAL_SCENE_SOURCE_INPUT_LIMIT"
    );

    let admission = RefCell::new(SourceReadAdmission::new(persisted_bytes, admit_peak));
    admission.borrow_mut().observe_peak(persisted_bytes)?;
    checkpoint()?;

    let Some((mode, loaded_version, updated_at, content, archived_at)) = conn
        .query_row(
            "SELECT p.phase_resolution_mode, t.version, t.updated_at, t.content,
                    t.archived_at
               FROM projects p
               JOIN tree_nodes t ON t.project_id = p.id
              WHERE p.id = ?1 AND t.id = ?2 AND t.node_type = 'scene'",
            params![project, scene],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(unavailable());
    };
    ensure!(
        loaded_version == version
            && mode.len() == mode_bytes
            && updated_at.len() == updated_at_bytes
            && content.len() == content_bytes
            && archived_at.as_ref().map(String::len).unwrap_or(0) == archived_at_bytes,
        "NIR1_RETRIEVAL_SCENE_SOURCE_SNAPSHOT_MISMATCH"
    );
    if loaded_version < 0 || updated_at.trim().is_empty() {
        return Ok(unavailable());
    }
    checkpoint()?;

    let canonical = canonical_scene_storage_with_admission(
        &content,
        max_storage_bytes,
        max_canonical_bytes,
        checkpoint,
        &mut |bytes| admission.borrow_mut().admit_parse(bytes),
        &mut |bytes| admission.borrow_mut().admit_output(bytes),
    )?;
    checkpoint()?;

    let source_key_bytes = "project:scene:"
        .len()
        .checked_add(scene.len())
        .ok_or_else(|| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))?;
    let revision_token_bytes = 2_usize
        .checked_add(decimal_digits(version))
        .and_then(|bytes| bytes.checked_add(updated_at.len()))
        .ok_or_else(|| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))?;
    // Retained identity/binding Strings plus the transient hex buffer used to
    // format one SHA-256 digest. The parser scratch has ended by this point.
    let retained_metadata_bytes = checked_sum(&[
        project.len(),
        scene.len(),
        source_key_bytes,
        revision_token_bytes,
        2 * 71,
        64,
    ])?;
    admission.borrow_mut().observe_peak(checked_sum(&[
        persisted_bytes,
        canonical.len(),
        retained_metadata_bytes,
    ])?)?;

    let archived = archived_at.is_some();
    let storage_digest = digest(content.as_bytes());
    let canonical_text_digest = digest(canonical.as_bytes());
    let canonical_utf16_length = canonical.encode_utf16().count();
    Ok(RetrievalSceneSourceRead::Available(RetrievalSceneSource {
        project_id: project.into(),
        scene_id: scene.into(),
        phase_resolution_mode: mode,
        archived,
        query_source: RetrievalSceneSourceBinding {
            source_key: format!("project:scene:{scene}"),
            revision_token: format!("v{version}@{updated_at}"),
            source_version: version,
            normalizer_version: CANONICAL_TEXT_NORMALIZER_VERSION,
            canonical_text_digest,
            storage_digest,
            canonical_utf16_length,
        },
        saved_content_json: content,
        canonical_source_text: canonical,
        _verified: (),
    }))
}

struct SourceReadAdmission<'a> {
    persisted_bytes: usize,
    parse_bytes: usize,
    output_bytes: usize,
    peak_bytes: usize,
    admit_peak: &'a mut dyn FnMut(usize) -> Result<()>,
}

impl<'a> SourceReadAdmission<'a> {
    fn new(persisted_bytes: usize, admit_peak: &'a mut dyn FnMut(usize) -> Result<()>) -> Self {
        Self {
            persisted_bytes,
            parse_bytes: 0,
            output_bytes: 0,
            peak_bytes: 0,
            admit_peak,
        }
    }

    fn admit_parse(&mut self, bytes: usize) -> Result<()> {
        self.parse_bytes = self
            .parse_bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))?;
        self.observe_working_peak()
    }

    fn admit_output(&mut self, bytes: usize) -> Result<()> {
        self.output_bytes = self
            .output_bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))?;
        self.observe_working_peak()
    }

    fn observe_working_peak(&mut self) -> Result<()> {
        let total = self
            .persisted_bytes
            .checked_add(self.parse_bytes)
            .and_then(|bytes| bytes.checked_add(self.output_bytes))
            .ok_or_else(|| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))?;
        self.observe_peak(total)
    }

    fn observe_peak(&mut self, bytes: usize) -> Result<()> {
        if bytes > self.peak_bytes {
            (self.admit_peak)(bytes)?;
            self.peak_bytes = bytes;
        }
        Ok(())
    }
}

fn checked_length(value: i64) -> Result<usize> {
    usize::try_from(value)
        .map_err(|_| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))
}

fn checked_sum(values: &[usize]) -> Result<usize> {
    values.iter().try_fold(0_usize, |sum, value| {
        sum.checked_add(*value)
            .ok_or_else(|| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))
    })
}

fn decimal_digits(value: i64) -> usize {
    let mut value = value as u64;
    let mut digits = 1;
    while value >= 10 {
        value /= 10;
        digits += 1;
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "project-a";
    const SCENE: &str = "scene-a";
    const CONTENT: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}"#;

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
}
