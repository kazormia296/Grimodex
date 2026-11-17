//! What one participant read of the call derives from `projects.language`
//! (DR-CHATIR-S1-16). Each read derives it again from the value it just read;
//! nothing is carried from an earlier read.

use anyhow::Result;
use grimodex_semantic::spec::{spec_for_language, EmbeddingModelSpec};

use super::status::ChatIrStatus;
use crate::related_scenes::ranking_policy;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Basis {
    pub(crate) language: &'static str,
    pub(crate) spec: &'static EmbeddingModelSpec,
    pub(crate) floor: f64,
    pub(crate) cap: usize,
}

/// `Ok(None)`: the language is not supported (`unsupported`, before anything is
/// embedded). Only "ja" and "en" exactly are supported, the same set as the
/// ranking policy; `spec_for_language` alone would send "fr" to the Japanese
/// model and "en-US" to the English one while the policy refuses both.
/// `Err`: the compiled policy is invalid.
pub(crate) fn basis_for(language: &str) -> Result<Option<Basis>> {
    let canonical: &'static str = match language {
        "ja" => "ja",
        "en" => "en",
        _ => return Ok(None),
    };
    let (floor, cap) = ranking_policy::for_language(canonical)?;
    Ok(Some(Basis {
        language: canonical,
        spec: spec_for_language(canonical),
        floor,
        cap,
    }))
}

/// What one read derives from the language it has just read. `first` is the
/// basis of the first read (`None` while deriving it).
///
/// * the first read: no project row is `project-unavailable`, a language that is
///   not supported is `unsupported`;
/// * a later read: a missing row, a language that is no longer supported or a
///   language other than the first read's is `project-changed` (the call ran
///   across a change of the project's language, so the model, the floor and the
///   cap it started with are no longer the project's).
pub(crate) fn derive(
    language: Option<&str>,
    first: Option<&Basis>,
) -> Result<std::result::Result<Basis, ChatIrStatus>> {
    let later = first.is_some();
    let Some(language) = language else {
        return Ok(Err(if later {
            ChatIrStatus::ProjectChanged
        } else {
            ChatIrStatus::ProjectUnavailable
        }));
    };
    let Some(basis) = basis_for(language)? else {
        return Ok(Err(if later {
            ChatIrStatus::ProjectChanged
        } else {
            ChatIrStatus::Unsupported
        }));
    };
    if first.is_some_and(|first| first.language != basis.language) {
        return Ok(Err(ChatIrStatus::ProjectChanged));
    }
    Ok(Ok(basis))
}
