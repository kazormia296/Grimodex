use std::collections::HashMap;

use crate::narrative_project_scope_authority::compare_utf16;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityDiffObject {
    pub identity: String,
    pub content_token: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdentityDiffChange {
    Added,
    Removed,
    Unchanged,
    ContentChanged,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityDiffEntry {
    pub identity: String,
    pub change: IdentityDiffChange,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum NarrativeIdentityDiffError {
    #[error("identity must not be empty")]
    EmptyIdentity,
    #[error("content_token must not be empty")]
    EmptyContentToken,
    #[error("identity `{identity}` appears more than once in one revision")]
    DuplicateIdentity { identity: String },
}

fn index_objects(
    objects: &[IdentityDiffObject],
) -> Result<HashMap<&str, &str>, NarrativeIdentityDiffError> {
    let mut indexed = HashMap::with_capacity(objects.len());
    for object in objects {
        if object.identity.is_empty() {
            return Err(NarrativeIdentityDiffError::EmptyIdentity);
        }
        if object.content_token.is_empty() {
            return Err(NarrativeIdentityDiffError::EmptyContentToken);
        }
        if indexed
            .insert(object.identity.as_str(), object.content_token.as_str())
            .is_some()
        {
            return Err(NarrativeIdentityDiffError::DuplicateIdentity {
                identity: object.identity.clone(),
            });
        }
    }
    Ok(indexed)
}

pub fn diff_identity_objects(
    previous: &[IdentityDiffObject],
    current: &[IdentityDiffObject],
) -> Result<Vec<IdentityDiffEntry>, NarrativeIdentityDiffError> {
    let previous = index_objects(previous)?;
    let current = index_objects(current)?;
    let mut identities: Vec<_> = previous.keys().chain(current.keys()).copied().collect();
    identities.sort_unstable_by(|left, right| compare_utf16(left, right));
    identities.dedup();

    Ok(identities
        .into_iter()
        .map(|identity| {
            let change = match (previous.get(identity), current.get(identity)) {
                (None, Some(_)) => IdentityDiffChange::Added,
                (Some(_), None) => IdentityDiffChange::Removed,
                (Some(previous), Some(current)) if previous == current => {
                    IdentityDiffChange::Unchanged
                }
                (Some(_), Some(_)) => IdentityDiffChange::ContentChanged,
                (None, None) => unreachable!("identity came from one of the indexed revisions"),
            };
            IdentityDiffEntry {
                identity: identity.to_owned(),
                change,
            }
        })
        .collect())
}
