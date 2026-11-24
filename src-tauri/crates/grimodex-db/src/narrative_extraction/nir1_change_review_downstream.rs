use anyhow::bail;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownstreamConsumer {
    pub consumer_kind: String,
    pub consumer_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownstreamPage {
    pub items: Vec<DownstreamConsumer>,
    pub next_cursor: Option<DownstreamCursor>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownstreamCursor {
    pub consumer_kind: String,
    pub consumer_key: String,
}

pub const DOWNSTREAM_PAGE_MAX: usize = 200;

/// Read one ordered page inside the caller's read transaction.
pub fn read_downstream_consumers_page(
    conn: &Connection,
    project_id: &str,
    source_object_identity: &str,
    after: Option<&DownstreamCursor>,
    limit: usize,
) -> anyhow::Result<DownstreamPage> {
    if project_id.is_empty() {
        bail!("project_id must not be empty");
    }
    if source_object_identity.is_empty() {
        bail!("source_object_identity must not be empty");
    }
    if limit == 0 || limit > DOWNSTREAM_PAGE_MAX {
        bail!("limit must be between 1 and {DOWNSTREAM_PAGE_MAX}");
    }

    let cursor_clause = if after.is_some() {
        " AND (consumer_kind, consumer_key) > (?3, ?4)"
    } else {
        ""
    };
    let limit_parameter = if after.is_some() { "?5" } else { "?3" };
    let sql = format!(
        "SELECT consumer_kind, consumer_key
           FROM narrative_dependency_edges INDEXED BY idx_narrative_dependency_edges_source
          WHERE project_id = ?1 AND source_object_identity = ?2{cursor_clause}
          ORDER BY consumer_kind, consumer_key
          LIMIT {limit_parameter}"
    );
    let mut statement = conn.prepare(&sql)?;
    let limit_plus_one = (limit + 1) as i64;
    let rows = if let Some(after) = after {
        statement.query_map(
            params![
                project_id,
                source_object_identity,
                after.consumer_kind.as_str(),
                after.consumer_key.as_str(),
                limit_plus_one
            ],
            row_to_consumer,
        )?
    } else {
        statement.query_map(
            params![project_id, source_object_identity, limit_plus_one],
            row_to_consumer,
        )?
    };
    let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;

    let next_cursor = if items.len() > limit {
        items.truncate(limit);
        let last = items.last().expect("validated page limit is non-zero");
        Some(DownstreamCursor {
            consumer_kind: last.consumer_kind.clone(),
            consumer_key: last.consumer_key.clone(),
        })
    } else {
        None
    };

    Ok(DownstreamPage { items, next_cursor })
}

/// Read all matching Consumers, failing rather than returning a partial list.
pub fn read_all_downstream_consumers(
    conn: &Connection,
    project_id: &str,
    source_object_identity: &str,
    max_pages: usize,
) -> anyhow::Result<Vec<DownstreamConsumer>> {
    if max_pages == 0 {
        bail!("max_pages must be greater than zero");
    }

    let mut items = Vec::new();
    let mut after = None;
    for _ in 0..max_pages {
        let page = read_downstream_consumers_page(
            conn,
            project_id,
            source_object_identity,
            after.as_ref(),
            DOWNSTREAM_PAGE_MAX,
        )?;
        items.extend(page.items);
        match page.next_cursor {
            Some(next) => after = Some(next),
            None => return Ok(items),
        }
    }

    bail!("downstream consumer lookup exceeded max_pages ({max_pages})")
}

fn row_to_consumer(row: &Row<'_>) -> rusqlite::Result<DownstreamConsumer> {
    Ok(DownstreamConsumer {
        consumer_kind: row.get(0)?,
        consumer_key: row.get(1)?,
    })
}
