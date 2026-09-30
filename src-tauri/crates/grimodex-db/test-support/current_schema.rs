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
    source_epoch: String,
}

fn epoch(db: &Database) -> Result<String> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT epoch FROM temp.grimodex_connection_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )?)
    })
}

impl CurrentSchemaTemplate {
    fn initialize() -> Result<Self> {
        let source = fresh_migrated_memory()?;
        let source_epoch = epoch(&source)?;
        source.with_conn(|conn| {
            conn.pragma_update(None, "query_only", true)?;
            Ok(())
        })?;
        Ok(Self {
            source,
            source_epoch,
        })
    }

    fn clone_database(&self) -> Result<Database> {
        let destination = new_memory()?;
        let destination_epoch = epoch(&destination)?;
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
        let copied_epoch = epoch(&destination)?;
        anyhow::ensure!(
            !copied_epoch.is_empty()
                && copied_epoch == destination_epoch
                && copied_epoch != self.source_epoch,
            "current-schema fixture must keep a fresh destination TEMP epoch"
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
