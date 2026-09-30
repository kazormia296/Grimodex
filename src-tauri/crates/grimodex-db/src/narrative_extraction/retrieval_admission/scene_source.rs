use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(feature = "native-current-human-capture")]
use std::cell::RefCell;

#[cfg(feature = "native-current-human-capture")]
use super::super::change_feed::canonical_scene_storage_with_admission;
use super::super::change_feed::{scene_canonical_text, CANONICAL_TEXT_NORMALIZER_VERSION};
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

#[cfg(feature = "native-current-human-capture")]
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

#[cfg(feature = "native-current-human-capture")]
struct SourceReadAdmission<'a> {
    persisted_bytes: usize,
    parse_bytes: usize,
    output_bytes: usize,
    peak_bytes: usize,
    admit_peak: &'a mut dyn FnMut(usize) -> Result<()>,
}

#[cfg(feature = "native-current-human-capture")]
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

#[cfg(feature = "native-current-human-capture")]
fn checked_length(value: i64) -> Result<usize> {
    usize::try_from(value)
        .map_err(|_| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))
}

#[cfg(feature = "native-current-human-capture")]
fn checked_sum(values: &[usize]) -> Result<usize> {
    values.iter().try_fold(0_usize, |sum, value| {
        sum.checked_add(*value)
            .ok_or_else(|| anyhow::anyhow!("NIR1_RETRIEVAL_SCENE_SOURCE_BYTE_COUNT_INVALID"))
    })
}

#[cfg(feature = "native-current-human-capture")]
fn decimal_digits(value: i64) -> usize {
    let mut value = value as u64;
    let mut digits = 1;
    while value >= 10 {
        value /= 10;
        digits += 1;
    }
    digits
}

#[cfg(all(test, feature = "native-current-human-capture"))]
#[path = "scene_source_tests.rs"]
mod tests;
