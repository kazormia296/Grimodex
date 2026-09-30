//! Test-only adapter for integration tests and downstream crate unit tests.

use grimodex_db::Database;
use std::path::Path;

#[path = "current_schema.rs"]
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
