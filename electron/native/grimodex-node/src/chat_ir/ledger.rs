//! The record of the items this process issued (DR-CHATIR-S1-23, design 4.2.6).
//!
//! It keeps no text: only the digest of an item's canonical form, its byte
//! length, revision ID, Scene ID, title, score, generation and the identity of
//! the workspace database it was made for. Nothing is ever pushed out: when the
//! limit is reached a new issue is refused as a whole, so an entry a running
//! turn still depends on is never lost. It is dropped when the database
//! identity changes and when the process ends (it is never written to disk);
//! the semantic epoch is not a reason, because the epoch turns inside one turn
//! without the authority changing. S1-C reads it; S1-A only issues.

use std::collections::HashMap;

use super::item::IrItem;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LedgerEntry {
    pub(crate) byte_length: usize,
    pub(crate) revision_id: String,
    pub(crate) scene_id: String,
    pub(crate) scene_title: String,
    pub(crate) score: f64,
    pub(crate) generation: i64,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct LedgerFull;

pub(crate) struct Ledger {
    capacity: usize,
    identity: Option<u64>,
    entries: HashMap<String, LedgerEntry>,
}

impl Ledger {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            identity: None,
            entries: HashMap::new(),
        }
    }

    /// Issue all of `items` for the database `identity`, or none of them. An
    /// item whose digest is already recorded does not take a new place.
    pub(crate) fn issue(&mut self, identity: u64, items: &[IrItem]) -> Result<(), LedgerFull> {
        if self.identity != Some(identity) {
            self.entries.clear();
            self.identity = Some(identity);
        }
        let mut fresh: HashMap<&str, &IrItem> = HashMap::new();
        for item in items {
            if !self.entries.contains_key(&item.digest) {
                fresh.insert(item.digest.as_str(), item);
            }
        }
        if self.entries.len() + fresh.len() > self.capacity {
            return Err(LedgerFull);
        }
        for (digest, item) in fresh {
            self.entries.insert(
                digest.to_string(),
                LedgerEntry {
                    byte_length: item.byte_length,
                    revision_id: item.revision_id.clone(),
                    scene_id: item.scene_id.clone(),
                    scene_title: item.scene_title.clone(),
                    score: item.score,
                    generation: item.generation,
                },
            );
        }
        Ok(())
    }

    /// The entry of `digest` made for the database `identity`; an entry made
    /// for another identity is not visible (and is dropped).
    #[allow(dead_code)] // S1-C (the audit replacement) reads the record.
    pub(crate) fn get(&mut self, identity: u64, digest: &str) -> Option<&LedgerEntry> {
        if self.identity != Some(identity) {
            self.entries.clear();
            self.identity = Some(identity);
        }
        self.entries.get(digest)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}
