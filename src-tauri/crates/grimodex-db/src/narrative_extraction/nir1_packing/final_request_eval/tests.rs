//! The DP-H observation hook against the Native selection (DI-1c S2). It sits
//! beside the evaluation module so that the evaluation feature and module
//! names stay out of the product test files (the architecture check).

use anyhow::{Context, Result};
use rusqlite::params;

use super::{check_record_matches_projection, discard_candidate_set, take_candidate_set};
use crate::narrative_extraction::nir1_packing::tests::DfFinalFixture;

/// The observation hook of the DP-H harness sees the Native selection: the
/// candidate set holds the evaluated Revisions, and the projection matches it.
#[test]
fn native_selection_keeps_the_final_request_observation_hook_working() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    let sorted = fixture.sorted_revisions();
    fixture.sql(
        "UPDATE narrative_proposal_revisions SET payload_json='{' WHERE id=?1",
        params![sorted[1]],
    )?;
    discard_candidate_set();
    let selected = fixture.select()?;
    let record = take_candidate_set().context("the hook recorded no candidate set")?;
    assert!(record.pooled_source_path);
    assert_eq!(record.revision_ids, sorted);
    assert_eq!(record.binding_revision_ids(), vec![sorted[0].as_str()]);
    assert_eq!(record.derivation_error, None);
    check_record_matches_projection(&record, selected.prepared())
        .map_err(|reason| anyhow::anyhow!(reason))?;
    // The left-out Revision has no item in the observed candidate set either.
    assert!(record
        .items
        .iter()
        .all(|row| row.owner_id != sorted[1] && !row.item_id.contains(&sorted[1])));
    // The caller-list path (policy `Reject`) still rejects the broken Revision.
    discard_candidate_set();
    let by_list = fixture.project_with_bindings(|_| {});
    assert!(by_list.is_err(), "the caller list still rejects");
    discard_candidate_set();
    Ok(())
}
