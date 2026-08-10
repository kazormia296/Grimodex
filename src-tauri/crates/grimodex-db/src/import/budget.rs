use serde::{Deserialize, Serialize};

/// Browser-compatible resource limits applied before native inventory support
/// grows beyond its persistence skeleton.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResourceBudgetSnapshot {
    pub max_text_bytes: u64,
    pub max_archive_or_folder_bytes: u64,
    pub max_files: u32,
    pub max_depth: u32,
}

impl Default for ImportResourceBudgetSnapshot {
    fn default() -> Self {
        Self {
            max_text_bytes: 32 * 1024 * 1024,
            max_archive_or_folder_bytes: 64 * 1024 * 1024,
            max_files: 10_000,
            max_depth: 64,
        }
    }
}
