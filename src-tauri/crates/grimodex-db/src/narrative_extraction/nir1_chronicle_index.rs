//! Native-only reviewed Chronicle index. Durable cache rows never grant
//! retrieval authority; the workspace runtime must construct a current proof.
mod audit;
mod binding;
mod build;
mod cache;
mod canonical;
mod evidence;
mod input_guard;
pub(crate) mod invalidate;
mod publish;
mod query;
pub(crate) mod read_identity;
mod revision_bindings;
mod runtime;
pub(crate) mod source;
mod types;

pub(crate) use binding::is_complete_registered as is_complete_registered_chronicle_index;
pub(crate) use binding::is_registered as is_registered_chronicle_index;
pub use build::{
    prepare_chronicle_index_build, prepare_chronicle_index_build_on_reader,
    prepare_chronicle_index_build_with_control, NirIndexBuildPlan, NirIndexBuildRead,
};
pub use cache::read_reusable_chronicle_embeddings;
pub use publish::{
    publish_chronicle_index_build, publish_chronicle_index_build_with_control,
    publish_chronicle_index_build_with_participant,
};
pub use query::*;
pub(crate) use runtime::ChronicleReaderTarget;
pub use runtime::{
    ChronicleReaderAdmission, ChronicleReaderAdmissionRead, NirChronicleIndexRuntime, ReaderPermit,
};
pub use types::*;

pub(crate) const PRODUCER_ID: &str = "nir1-reviewed-chronicle-v1";
pub(crate) const PRODUCER_VERSION: &str = "nir1-reviewed-chronicle/v1";
pub(crate) const INDEX_KEY: &str = "nir1-reviewed-chronicle:v1";
pub(crate) const SOURCE_KIND: &str = "nir1-chronicle-eligibility-set";

/// Cross-crate test support (`workspace-maintenance-test-support`): write the
/// cold reviewed-child workspace database (project `default-project`, one
/// reviewed Run, two approved children) to `path` and return its project id.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
#[doc(hidden)]
pub fn write_reviewed_child_cold_database_for_test(
    path: &std::path::Path,
) -> anyhow::Result<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(
        include_bytes!("../../tests/support/nir1-reviewed-child-cold.db.gz").as_slice(),
    )
    .read_to_end(&mut bytes)?;
    std::fs::write(path, bytes)?;
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/support/nir1-reviewed-child-cold.json"
    ))?;
    Ok(manifest["projectId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("fixture manifest has no projectId"))?
        .to_owned())
}

#[cfg(test)]
mod freshness_share_tests;
#[cfg(test)]
mod invalidate_tests;
#[cfg(test)]
mod multi_window_control_tests;
#[cfg(test)]
mod publish_tests;
#[cfg(test)]
mod query_tests;
#[cfg(test)]
mod read_identity_tests;
#[cfg(test)]
mod reader_tests;
#[cfg(test)]
mod run_proof_memo_tests;
#[cfg(test)]
mod source_tests;
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
mod outcome_audit;
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub use outcome_audit::synthetic_embedded_outcomes_for_test;
#[cfg(test)]
mod test_support;
