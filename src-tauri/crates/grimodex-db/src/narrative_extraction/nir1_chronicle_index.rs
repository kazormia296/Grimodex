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
mod read_identity;
mod revision_bindings;
mod runtime;
pub(crate) mod source;
mod types;

pub(crate) use binding::is_complete_registered as is_complete_registered_chronicle_index;
pub(crate) use binding::is_registered as is_registered_chronicle_index;
pub use build::{
    prepare_chronicle_index_build, prepare_chronicle_index_build_with_control, NirIndexBuildPlan,
    NirIndexBuildRead,
};
pub use cache::read_reusable_chronicle_embeddings;
pub use publish::{publish_chronicle_index_build, publish_chronicle_index_build_with_control};
pub use query::*;
pub use runtime::NirChronicleIndexRuntime;
pub use types::*;

pub(crate) const PRODUCER_ID: &str = "nir1-reviewed-chronicle-v1";
pub(crate) const PRODUCER_VERSION: &str = "nir1-reviewed-chronicle/v1";
pub(crate) const INDEX_KEY: &str = "nir1-reviewed-chronicle:v1";
pub(crate) const SOURCE_KIND: &str = "nir1-chronicle-eligibility-set";

#[cfg(test)]
mod publish_tests;
#[cfg(test)]
mod query_tests;
#[cfg(test)]
mod read_identity_tests;
#[cfg(test)]
mod source_tests;
#[cfg(test)]
mod test_support;
