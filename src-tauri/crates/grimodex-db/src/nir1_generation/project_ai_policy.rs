//! Bounded read of `projects.ai_policy` for the NIR-1 local send route (K5/3,
//! B-2).
//!
//! The Native owner reads the conversation's project policy twice, before it
//! creates an attempt and right before it sends. Both reads go through this
//! function: one bounded read transaction (connection mutex 100 ms, SQLite busy
//! 100 ms, operation 250 ms) over the pinned workspace's own database, a fresh
//! read every time, and no cache. The reader only reports what the row holds;
//! the decision is `grimodex_core::nir1_local_send_policy::decide`, which this
//! module does not call, so a row that is missing, not text, too large, or whose
//! read failed can never be mistaken for a policy.
//!
//! It runs under the Admission fence: the owner's cancel, a participant stop or
//! a false admission probe interrupts the read, and the caller treats every
//! error as a refusal (nothing is sent). It holds nothing the owner's cancel
//! needs, so a slow read never delays a cancel.

use grimodex_core::nir1_local_send_policy::NIR1_LOCAL_SEND_POLICY_MAX_BYTES;

use super::*;

/// What the `projects.ai_policy` cell of one project held.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum Nir1ProjectAiPolicyRead {
    /// The stored text, no longer than `NIR1_LOCAL_SEND_POLICY_MAX_BYTES`.
    Text(String),
    /// The cell is NULL, a number, a blob or text that is not valid UTF-8. The
    /// column is `NOT NULL TEXT`, so this means the row does not satisfy its
    /// schema; it is never treated as an absent policy.
    NotText,
    /// The text is longer than `NIR1_LOCAL_SEND_POLICY_MAX_BYTES`. It was not
    /// loaded.
    TooLarge,
    /// No project row has this ID.
    ProjectMissing,
}

/// Read the policy cell of `project_id` in a fresh bounded read transaction.
/// Every error, including a cancel, a fence, a timeout and a busy connection,
/// is `NotCommitted`; the caller must refuse to send on any of them.
pub fn read_project_ai_policy_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    project_id: &str,
    budget: &Nir1AdmissionSqlBudget,
) -> Result<Nir1ProjectAiPolicyRead, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    identity(project_id).map_err(|error| {
        Nir1GenerationStoreError::not_committed(Nir1StoreFailure::Invalid, error)
    })?;
    workspace
        .authority
        .db()
        .with_participant_read_transaction_bounded_in(
            workspace.participant(),
            budget.fence(),
            budget.sql_budget(),
            |conn| read_project_ai_policy_in_tx(conn, project_id),
        )
        .map_err(|error| {
            store_error(
                error,
                Nir1CommitState::NotCommitted,
                budget.cancel_requested(),
            )
        })
}

fn read_project_ai_policy_in_tx(
    conn: &Connection,
    project_id: &str,
) -> Result<Nir1ProjectAiPolicyRead> {
    // The length is read first, without the value, so a hostile row is never
    // loaded; the value is then read by rowid inside the same snapshot.
    let located: Option<(i64, String, Option<i64>)> = conn
        .query_row(
            "SELECT rowid,typeof(ai_policy),octet_length(ai_policy)
               FROM projects WHERE id=?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((rowid, storage_class, length)) = located else {
        return Ok(Nir1ProjectAiPolicyRead::ProjectMissing);
    };
    if storage_class != "text" {
        return Ok(Nir1ProjectAiPolicyRead::NotText);
    }
    let length = length.context("NIR1_LOCAL_SEND_POLICY_LENGTH_MISSING")?;
    ensure!(length >= 0, "NIR1_LOCAL_SEND_POLICY_LENGTH_INVALID");
    let length = usize::try_from(length).context("NIR1_LOCAL_SEND_POLICY_LENGTH_INVALID")?;
    if length > NIR1_LOCAL_SEND_POLICY_MAX_BYTES {
        return Ok(Nir1ProjectAiPolicyRead::TooLarge);
    }
    conn.query_row(
        "SELECT ai_policy FROM projects WHERE rowid=?1",
        [rowid],
        |row| {
            let value = row.get_ref(0)?;
            let rusqlite::types::ValueRef::Text(bytes) = value else {
                return Ok(Nir1ProjectAiPolicyRead::NotText);
            };
            if bytes.len() != length {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(match std::str::from_utf8(bytes) {
                Ok(text) => Nir1ProjectAiPolicyRead::Text(text.to_owned()),
                Err(_) => Nir1ProjectAiPolicyRead::NotText,
            })
        },
    )
    .context("NIR1_LOCAL_SEND_POLICY_ROW_CHANGED")
}
