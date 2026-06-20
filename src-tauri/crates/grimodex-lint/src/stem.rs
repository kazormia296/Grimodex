//! English (Snowball/Porter2) stemmer helper. Lexical normalization for the
//! English lint rules — NOT morphological analysis (lindera is Japanese-only).
//!
//! Input is expected to be already lowercased. The returned stem may not be a
//! real word (e.g. `studies` -> `studi`); it only needs to be *consistent* so
//! inflections of one lemma collapse to a single key.

use rust_stemmers::{Algorithm, Stemmer};

thread_local! {
    // Stemmer holds no mutable state; stem(&self) is read-only. thread_local
    // sidesteps any Sync requirement on a global and is cheap to construct.
    static EN_STEMMER: Stemmer = Stemmer::create(Algorithm::English);
}

/// Stem one English word to its Snowball (Porter2) root.
pub fn stem_en(word: &str) -> String {
    EN_STEMMER.with(|s| s.stem(word).into_owned())
}

#[cfg(test)]
mod tests {
    use super::stem_en;

    #[test]
    fn regular_inflections_collapse_to_one_root() {
        assert_eq!(stem_en("studies"), stem_en("studying"));
        assert_eq!(stem_en("running"), stem_en("runs"));
        assert_eq!(stem_en("noticed"), stem_en("noticing"));
    }

    #[test]
    fn distinct_lemmas_keep_distinct_roots() {
        // Agentive -er is not stripped, so "runner" stays its own family.
        assert_ne!(stem_en("running"), stem_en("runner"));
    }
}
