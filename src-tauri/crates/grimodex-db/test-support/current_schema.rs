//! Shared source for private test adapters; never compiled into the product.
//!
//! Each test binary migrates one immutable in-memory template. Every behavior
//! test receives a fresh connection whose MAIN database is copied from it.

use super::{fresh_migrated_memory, new_memory, Database};
use anyhow::Result;
use rusqlite::backup::{Backup, StepResult};
use std::sync::OnceLock;

static TEMPLATE: OnceLock<std::result::Result<CurrentSchemaTemplate, String>> = OnceLock::new();

struct CurrentSchemaTemplate {
    source: Database,
    source_lineage: String,
}

fn lineage(db: &Database) -> Result<String> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id FROM grimodex_db_lineage WHERE singleton=1",
            [],
            |row| row.get(0),
        )?)
    })
}

impl CurrentSchemaTemplate {
    fn initialize() -> Result<Self> {
        let source = fresh_migrated_memory()?;
        let source_lineage = lineage(&source)?;
        source.with_conn(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok(())
        })?;
        Ok(Self {
            source,
            source_lineage,
        })
    }

    fn clone_database(&self) -> Result<Database> {
        let destination = new_memory()?;
        {
            let source = self.source.lock()?;
            anyhow::ensure!(
                source.pragma_query_value(None, "query_only", |row| row.get::<_, bool>(0))?,
                "current-schema fixture template must remain read-only"
            );
            let mut target = destination.lock()?;
            let backup = Backup::new(&source, &mut target)?;
            anyhow::ensure!(
                matches!(backup.step(-1)?, StepResult::Done),
                "current-schema fixture backup did not complete"
            );
        }
        // The Backup API copies the template's lineage. Every database is its own
        // lineage (as a restore or migration makes it), so the process-local keys
        // and receipts that name a lineage never alias two test databases.
        // (A SQL statement, not the db crate's helper: this file is also compiled into
        // integration tests and downstream crates.) 16 random bytes in lowercase hex
        // have the same shape as a lineage id.
        destination.with_conn(|conn| {
            let changed = conn.execute(
                "UPDATE grimodex_db_lineage SET id = lower(hex(randomblob(16)))
                  WHERE singleton = 1",
                [],
            )?;
            anyhow::ensure!(changed == 1, "current-schema fixture has no lineage row");
            Ok(())
        })?;
        let copied_lineage = lineage(&destination)?;
        anyhow::ensure!(
            copied_lineage.len() == 32 && copied_lineage != self.source_lineage,
            "current-schema fixture must get a fresh lineage"
        );
        Ok(destination)
    }
}

pub(crate) fn current_schema_memory() -> Result<Database> {
    let template = match TEMPLATE
        .get_or_init(|| CurrentSchemaTemplate::initialize().map_err(|error| format!("{error:#}")))
    {
        Ok(template) => template,
        Err(error) => anyhow::bail!("current-schema fixture initialization failed: {error}"),
    };
    template.clone_database()
}
