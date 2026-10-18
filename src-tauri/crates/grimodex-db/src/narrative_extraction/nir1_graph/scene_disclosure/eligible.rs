//! The results of the body step and of a click revalidation (CB-4 S2).
//!
//! `Eligible` is the only value that carries a Scene's title and excerpt out of
//! the reader. Neither it nor its request-local binding can be serialized, and
//! their `Debug` output hides every field, so a log line or a format string
//! cannot leak the contents (Mandatory defense 2).

use std::fmt;

use crate::narrative_extraction::nir1_graph::Nir1GraphSceneAssociation;

use super::NotAppended;

/// What the saved body of the adopted Scene gave when it was read: the digests
/// the declaration is bound to, plus the excerpt's digest and range.
#[derive(Clone, Eq, PartialEq)]
pub(super) struct BodyFacts {
    /// `v{version}@{updated_at}` as the body read saw it.
    pub(super) source_token: String,
    pub(super) storage_digest: String,
    pub(super) canonical_digest: String,
    pub(super) normalizer_version: String,
    pub(super) utf16_length: u64,
    pub(super) excerpt_digest: String,
    pub(super) start_utf16: usize,
    pub(super) end_utf16: usize,
}

/// Everything a click is compared with. Request-local: it is made with the
/// response, kept by the caller next to its opaque handle, used once for a
/// click and dropped. It is never stored, serialized or printed.
#[derive(Clone)]
pub struct GraphOnlySceneBinding {
    /// The frame's association (Scene, pin, tokens, path) the response used.
    pub(super) association: Nir1GraphSceneAssociation,
    pub(super) project_id: String,
    /// The query Scene and the Scope authority revision the response was made
    /// for.
    pub(super) query_scene_id: String,
    pub(super) authority_revision_token: String,
    pub(super) workspace_id: String,
    pub(super) canonical_locator_digest: String,
    pub(super) scene_incarnation_id: String,
    pub(super) scope_source_token: String,
    /// The declaration that held: its ID and stored token.
    pub(super) declaration_id: String,
    pub(super) declaration_token: String,
    pub(super) title_digest: String,
    pub(super) body: BodyFacts,
}

impl fmt::Debug for GraphOnlySceneBinding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphOnlySceneBinding")
            .finish_non_exhaustive()
    }
}

/// A Scene the reader found eligible: what the response shows and what a click
/// is later compared with.
pub struct EligibleGraphScene {
    pub(super) scene_id: String,
    pub(super) title: String,
    pub(super) excerpt: String,
    pub(super) binding: GraphOnlySceneBinding,
}

impl EligibleGraphScene {
    pub fn scene_id(&self) -> &str {
        &self.scene_id
    }

    /// The title the author declared (its digest is the declaration's).
    pub fn title(&self) -> &str {
        &self.title
    }

    /// The first non-empty line of the canonical body, exactly.
    pub fn excerpt(&self) -> &str {
        &self.excerpt
    }

    /// The excerpt's UTF-16 range in the canonical body: `[start, end)`.
    pub fn range(&self) -> GraphSceneRange {
        GraphSceneRange {
            start_utf16: self.binding.body.start_utf16,
            end_utf16: self.binding.body.end_utf16,
        }
    }

    /// The request-local binding for the click revalidation.
    pub fn binding(&self) -> &GraphOnlySceneBinding {
        &self.binding
    }
}

impl fmt::Debug for EligibleGraphScene {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EligibleGraphScene")
            .finish_non_exhaustive()
    }
}

/// A UTF-16 range in the canonical body.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct GraphSceneRange {
    pub start_utf16: usize,
    pub end_utf16: usize,
}

impl fmt::Debug for GraphSceneRange {
    // The values are positions in a declared body; they are not printed.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GraphSceneRange")
            .finish_non_exhaustive()
    }
}

/// The answer for one Related Scenes response.
#[derive(Debug)]
pub enum GraphOnlySceneDisclosure {
    Eligible(Box<EligibleGraphScene>),
    /// No Graph-only Scene is added. One value for every reason.
    NotAppended(NotAppended),
}

/// A click that could not be revalidated: the row that was shown no longer
/// holds. One closed value; it names no Scene and no reason, and it is a
/// different path from the response's [`NotAppended`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GraphSceneRevalidationRefused;

impl GraphSceneRevalidationRefused {
    pub const fn code(self) -> &'static str {
        "graph-scene-revalidation-failed"
    }
}

/// The result of a click revalidation.
#[derive(Debug)]
pub enum GraphOnlyClick {
    /// Everything holds and the excerpt and range equal the ones shown: go to
    /// this range.
    Allowed(GraphSceneRange),
    Refused(GraphSceneRevalidationRefused),
}
