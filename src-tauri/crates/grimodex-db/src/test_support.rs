//! Private test fixtures. Migration, file, repair, and connection-counter tests
//! keep their real initialization path; current-schema behavior tests use a copy.

use crate::Database;
use std::path::Path;

#[path = "../test-support/current_schema.rs"]
mod current_schema;

pub(crate) use current_schema::current_schema_memory;

fn new_memory() -> anyhow::Result<Database> {
    Database::new(Path::new(":memory:"))
}

pub(crate) fn fresh_migrated_memory() -> anyhow::Result<Database> {
    let db = new_memory()?;
    db.migrate()?;
    Ok(db)
}

#[path = "test_support_tests.rs"]
mod tests;
