from pathlib import Path
import subprocess, json
R=Path.cwd()
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()=='b56ab8034b9bbab3475b23e9957b0a1f42a86a5f'
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
changed=set()
def edit(path,old,new,count=1):
 p=R/path;s=p.read_text();actual=s.count(old)
 if actual!=count: raise RuntimeError(f'{path}: expected {count}, got {actual}: {old[:100]!r}')
 p.write_text(s.replace(old,new));changed.add(path)
def append(path,text):
 p=R/path;p.write_text(p.read_text()+text);changed.add(path)
notes=R/'docs/plans/pr600-review-repair.md'
assert not notes.exists()
notes.write_text('''# PR600 review repair

Base: `b56ab8034b9bbab3475b23e9957b0a1f42a86a5f`. Confirmed contract: `nir1-l6-l9-contract-proposal/5` / `graph-limited-binding`. No Graph query/product activation, persistent schema, authority, or supported-capacity change.

| Entry / reentry | Owner and admission | Stop / terminal / retry |
|---|---|---|
| Automatic begin, cycle, follow-up | Main owns pending-start and attempt ID; Native owns binding/execution; DB owns each transaction | Same stop at SQL/Rust boundaries. Final grant is restricted to success commit; every committed Run is terminalized or handed to its exact cleanup owner. |
| Source, roster, coverage, recovery | Existing Native maintenance entry owns caller connection and nested reads | Zero SQLite busy wait, bounded hook cadence; unverifiable material aborts whole validation, never shrinks eligible set. Cleanup proves rollback/autocommit/settings before retry. |
| Manual Verify/Rebuild | Main-owned attempt serialized with automatic work/workspace leases; Native validates ID/binding | Switch/dispose stops pending/running manual work and awaits terminal receipt. Renderer cannot supply lifecycle IDs. |
| Cancel after intermediate Run commit | Adapter owns exact durable Run ID | Immediate terminalizer or exact pending owner; no ownerless running Run reaches same-process retry. |
| Cleanup failure / explicit reopen | Old DB permanently unusable; terminal receipt distinct from reuse | Unknown termination blocks. Known terminal failure parks admission but permits old authority disposal/replacement. Only verified new binding reopens scheduling. |
| Overlapping switches / shutdown | Main switch leases and existing subsystem owners | Last lease controls reentry. Independent shutdown cleanups run even after DB failure; kill requests alone are not termination proof. |

## Resource guard interpretation

Retain the existing 2 MiB pre-allocation guard as a conservative operational read budget, not an A2 semantic eligibility verdict. If a stored component or live-source working set exceeds it, typed resource termination aborts the complete build/verification. The decoded bundle limit is unchanged. A larger serialized-input budget is not ratified here: a valid bundle may produce an explicit capacity failure but cannot silently disappear from a fresh complete generation.

## Validation

Repair commits and exact focused job logs record validation separately. Excerpt checks, repository tests, and Quick/Full receipts are distinct. No independent acceptance review or merge/release readiness is claimed by this note.
''')
changed.add(str(notes.relative_to(R)))
SR='src-tauri/crates/grimodex-db/src/narrative_extraction/source_revision.rs'
edit(SR,'    ForegroundPreempted,\n    CleanupFailed,','    ForegroundPreempted,\n    ResourceExhausted,\n    CleanupFailed,')
edit(SR,'            Self::ForegroundPreempted => "foreground-preempted",','            Self::ForegroundPreempted => "foreground-preempted",\n            Self::ResourceExhausted => "resource-exhausted",')
NC='src-tauri/crates/grimodex-db/src/narrative_maintenance_connection.rs'
edit(NC,'            ValidationTerminationReason::CleanupFailed => TERMINATION_NONE,','            ValidationTerminationReason::CleanupFailed\n            | ValidationTerminationReason::ResourceExhausted => TERMINATION_NONE,')
GI='src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation_index.rs'
edit(GI,'const GRAPH_SOURCE_PAGE_SIZE: i64 = 64;','''const GRAPH_SOURCE_PAGE_SIZE: i64 = 64;
// Existing allocation budgets are not decoded A2 eligibility thresholds.
// Exhaustion aborts whole validation instead of dropping a candidate.
const PERSISTED_COMPONENT_READ_BUDGET_BYTES: usize = 2 * 1024 * 1024;
const LIVE_SOURCE_READ_BUDGET_BYTES: usize = 2 * 1024 * 1024;

// Seek an existing primary key. CROSS JOIN keeps the ordered proposal scan
// outermost, without per-page DISTINCT/ORDER BY temporary B-trees. Only its
// owning proposal can qualify a Revision; forged duplicate pointers are
// scanned/size-checked but cannot duplicate the canonical roster.
const GRAPH_SOURCE_PAGE_SQL: &str = "SELECT
                    length(CAST(proposal.id AS BLOB)), proposal.id,
                    length(CAST(proposal.current_revision_id AS BLOB)),
                    proposal.current_revision_id,
                    COALESCE(revision.proposal_id = proposal.id, 0)
               FROM narrative_proposals proposal
               CROSS JOIN narrative_proposal_sets proposal_set
               CROSS JOIN narrative_extraction_runs extraction_run
               LEFT JOIN narrative_proposal_revisions revision
                 ON revision.id = proposal.current_revision_id
              WHERE proposal.id > ?4
                AND proposal.proposal_set_id = proposal_set.id
                AND extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
                AND proposal_set.project_id = ?1
                AND proposal_set.set_kind = ?2
                AND extraction_run.surface_path_id = ?3
                AND proposal.current_revision_id IS NOT NULL
              ORDER BY proposal.id ASC
              LIMIT ?5";

fn graph_read_resource_exhausted(message: &str) -> anyhow::Error {
    super::source_revision::validation_terminated(
        super::source_revision::ValidationTerminationReason::ResourceExhausted,
        message,
    )
}''')
edit(GI,'''        let mut statement = conn.prepare(
            "SELECT DISTINCT
                    length(CAST(proposal.current_revision_id AS BLOB)),
                    proposal.current_revision_id
               FROM narrative_proposal_sets proposal_set
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
               JOIN narrative_proposals proposal
                 ON proposal.proposal_set_id = proposal_set.id
              WHERE proposal_set.project_id = ?1
                AND proposal_set.set_kind = ?2
                AND extraction_run.surface_path_id = ?3
                AND proposal.current_revision_id IS NOT NULL
                AND proposal.current_revision_id > ?4
              ORDER BY proposal.current_revision_id ASC
              LIMIT ?5",
        )?;''','        let mut statement = conn.prepare(GRAPH_SOURCE_PAGE_SQL)?;')
edit(GI,'''            let revision_id_bytes = usize::try_from(row.get::<_, i64>(0)?)
                .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
            ensure!(
                revision_id_bytes <= REVISION_INPUT_BYTE_LIMIT,
                "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
            );
            page.push(row.get::<_, String>(1)?);''','''            for column in [0, 2] {
                let id_bytes = usize::try_from(row.get::<_, i64>(column)?)
                    .map_err(|_| graph_read_resource_exhausted("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
                if id_bytes > PERSISTED_COMPONENT_READ_BUDGET_BYTES {
                    return Err(graph_read_resource_exhausted("NIR1_GRAPH_ROSTER_INPUT_LIMIT"));
                }
            }
            page.push((row.get::<_, String>(1)?, row.get::<_, String>(3)?, row.get::<_, bool>(4)?));''')
edit(GI,'''        for revision_id in page {
            // Advance by every scanned id, including an ineligible one. This
            // is the keyset boundary that prevents an all-ineligible page
            // from being mistaken for end-of-input.
            cursor = revision_id.clone();''','''        for (proposal_id, revision_id, owns_revision) in page {
            // Advance by every proposal, including dangling, forged, and
            // ineligible pointers. An all-ineligible page is not EOF.
            cursor = proposal_id;
            if !owns_revision { continue; }''')
p=R/GI;s=p.read_text();a=s.index('    // The 2 MiB contract is the semantic bundle admission enforced by the');b=s.index('    if let Some(admission) = admission {',a)
s=s[:a]+'''    // Stored JSON may exceed the semantic bundle budget through escaping
    // or Native metadata. This says only that inspection is resource-limited,
    // never A2-unavailable: publishing the remaining subset is forbidden.
    ensure_persisted_revision_read_budget(payload_bytes, envelope_bytes)?;
'''+s[b:];p.write_text(s)
edit(GI,'''    payload_bytes <= REVISION_INPUT_BYTE_LIMIT && envelope_bytes <= REVISION_INPUT_BYTE_LIMIT
}''','''    payload_bytes <= PERSISTED_COMPONENT_READ_BUDGET_BYTES
        && envelope_bytes <= PERSISTED_COMPONENT_READ_BUDGET_BYTES
}

fn ensure_persisted_revision_read_budget(payload_bytes: usize, envelope_bytes: usize) -> Result<()> {
    if !persisted_revision_components_within_limit(payload_bytes, envelope_bytes) {
        return Err(graph_read_resource_exhausted("NIR1_GRAPH_PERSISTED_COMPONENT_RESOURCE_LIMIT"));
    }
    Ok(())
}''')
edit(GI,'''    if bytes > REVISION_INPUT_BYTE_LIMIT {
        return Ok(None);
    }''','''    if bytes > LIVE_SOURCE_READ_BUDGET_BYTES {
        return Err(graph_read_resource_exhausted("NIR1_GRAPH_LIVE_SOURCE_RESOURCE_LIMIT"));
    }''')
edit(GI,'const REVISION_INPUT_BYTE_LIMIT: usize = narrative_nir1::MAX_GRAPH_INPUT_BYTES;','#[cfg(test)]\nconst REVISION_INPUT_BYTE_LIMIT: usize = narrative_nir1::MAX_GRAPH_INPUT_BYTES;')
append(GI,r'''
#[cfg(test)]
mod pr600_index_review_tests {
    use super::*;
    #[test]
    fn resource_exhaustion_is_terminal_not_an_ineligible_revision() {
        let decoded = "\"".repeat(1_100_000);
        assert!(decoded.len() < narrative_nir1::MAX_GRAPH_INPUT_BYTES);
        let stored = serde_json::to_string(&decoded).unwrap();
        assert!(stored.len() > PERSISTED_COMPONENT_READ_BUDGET_BYTES);
        let error = ensure_persisted_revision_read_budget(stored.len(), 0).unwrap_err();
        assert!(super::super::source_revision::is_validation_terminated(&error));
        assert!(error.to_string().contains("resource-exhausted"));
        assert!(super::super::source_revision::is_validation_terminated(&error.context("Source re-resolution")));
    }
    #[test]
    fn candidate_pages_seek_primary_key_and_skip_only_nonowning_pointers() -> Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("CREATE TABLE narrative_proposals(id TEXT PRIMARY KEY,proposal_set_id TEXT,current_revision_id TEXT);
          CREATE TABLE narrative_proposal_sets(id TEXT PRIMARY KEY,run_id TEXT,project_id TEXT,set_kind TEXT);
          CREATE TABLE narrative_extraction_runs(id TEXT PRIMARY KEY,project_id TEXT,surface_path_id TEXT);
          CREATE TABLE narrative_proposal_revisions(id TEXT PRIMARY KEY,proposal_id TEXT);
          INSERT INTO narrative_extraction_runs VALUES('r','p','surface');
          INSERT INTO narrative_proposal_sets VALUES('s','r','p','kind');")?;
        for i in 0..130 {
            let proposal = format!("p-{i:04}");
            let revision = format!("rev-{:04}",130-i);
            conn.execute("INSERT INTO narrative_proposals VALUES(?1,'s',?2)", params![proposal,revision])?;
            if i>=65 { conn.execute("INSERT INTO narrative_proposal_revisions VALUES(?1,?2)",params![revision,proposal])?; }
        }
        conn.execute("INSERT INTO narrative_proposals VALUES('p-9999','s','rev-0001')",[])?;
        let mut cursor=String::new(); let mut seen=Vec::new(); let mut owned=Vec::new();
        loop {
            let mut statement=conn.prepare(GRAPH_SOURCE_PAGE_SQL)?;
            let page=statement.query_map(params!["p","kind","surface",cursor,GRAPH_SOURCE_PAGE_SIZE],|row| {
                Ok((row.get::<_,String>(1)?,row.get::<_,String>(3)?,row.get::<_,bool>(4)?))
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            if page.is_empty() { break; }
            for (proposal,revision,owner) in page { cursor=proposal.clone(); seen.push(proposal); if owner { owned.push(revision); } }
        }
        assert_eq!(seen.len(),131); assert_eq!(owned.len(),65);
        assert_eq!(owned.iter().collect::<HashSet<_>>().len(),65);
        let sql=format!("EXPLAIN QUERY PLAN {GRAPH_SOURCE_PAGE_SQL}");
        let plan=conn.prepare(&sql)?.query_map(params!["p","kind","surface","p-0064",64],|row|row.get::<_,String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(plan.iter().any(|line|line.contains("SEARCH proposal USING INDEX")&&line.contains("id>?")),"{plan:?}");
        assert!(!plan.iter().any(|line|line.contains("USE TEMP B-TREE")),"{plan:?}");
        Ok(())
    }
}
''')
RR='src-tauri/crates/grimodex-db/src/narrative_extraction/restore_rebuild.rs'
edit(RR,'''        Err(error)
            if is_validation_terminated(&error)
                || is_transient_connection_preemption(&error)
                || is_maintenance_connection_deferred_or_cleanup(&error)
                || is_maintenance_attempt_stop(&error) => Err(error),''','''        Err(error) if is_controlled_maintenance_termination(&error) => {
            if let Err(handoff) = transfer_controlled_maintenance_run_to_owner(db, &run_id, &error, control) {
                return Err(error.context(format!("NEX_MAINTENANCE_RUN_HANDOFF_FAILED: {handoff:#}")));
            }
            Err(error)
        },''',2)
edit(RR,'''    result.into_result()
}

pub(crate) fn run_maintenance_graph_phase_for_run''','''    match result.into_result() {
        Err(error) if db.connection_reusable() && error.chain().any(|cause| {
            matches!(cause.downcast_ref::<rusqlite::Error>(), Some(rusqlite::Error::SqliteFailure(code, _))
                if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
        }) => Ok(false),
        other => other,
    }
}

pub(crate) fn run_maintenance_graph_phase_for_run''')
DB='src-tauri/crates/grimodex-db/src/lib.rs'
edit(DB,'use std::cell::Cell;','use std::cell::{Cell, RefCell};')
edit(DB,'    static MAINTENANCE_NO_WAIT_DEPTH: Cell<usize> = const { Cell::new(0) };','''    static MAINTENANCE_NO_WAIT_DEPTH: Cell<usize> = const { Cell::new(0) };
    static MAINTENANCE_STOP_SIGNALS: RefCell<Vec<std::sync::Arc<AtomicBool>>> = const { RefCell::new(Vec::new()) };''')
edit(DB,'''pub struct MaintenanceConnectionNoWaitGuard {
    _thread_affine:''','''pub struct MaintenanceConnectionNoWaitGuard {
    stop_signal: std::sync::Arc<AtomicBool>,
    _thread_affine:''')
edit(DB,'''impl Drop for MaintenanceConnectionNoWaitGuard {
    fn drop(&mut self) {
        MAINTENANCE_NO_WAIT_DEPTH''','''impl Drop for MaintenanceConnectionNoWaitGuard {
    fn drop(&mut self) {
        MAINTENANCE_STOP_SIGNALS.with(|signals| {
            let mut signals = signals.borrow_mut();
            if let Some(index) = signals.iter().rposition(|signal| std::sync::Arc::ptr_eq(signal, &self.stop_signal)) { signals.remove(index); }
        });
        MAINTENANCE_NO_WAIT_DEPTH''')
edit(DB,'''    pub fn enter_maintenance_connection_no_wait(&self) -> MaintenanceConnectionNoWaitGuard {
        MAINTENANCE_NO_WAIT_DEPTH.with(|depth| {
            depth.set(depth.get().saturating_add(1));
        });
        MaintenanceConnectionNoWaitGuard {
            _thread_affine: std::marker::PhantomData,
        }
    }''','''    pub fn enter_maintenance_connection_no_wait(&self) -> MaintenanceConnectionNoWaitGuard {
        self.enter_maintenance_connection_no_wait_with_stop(std::sync::Arc::new(AtomicBool::new(false)))
    }

    /// The actual attempt signal also owns inter-phase ledger and recovery SQL.
    pub fn enter_maintenance_connection_no_wait_with_stop(&self, stop_signal: std::sync::Arc<AtomicBool>) -> MaintenanceConnectionNoWaitGuard {
        MAINTENANCE_NO_WAIT_DEPTH.with(|depth| depth.set(depth.get().saturating_add(1)));
        MAINTENANCE_STOP_SIGNALS.with(|signals| signals.borrow_mut().push(std::sync::Arc::clone(&stop_signal)));
        MaintenanceConnectionNoWaitGuard { stop_signal, _thread_affine: std::marker::PhantomData }
    }''')
edit(DB,'''    pub fn with_conn<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T>,
    {
        let conn = self.lock_conn()?;
        f(&conn)
    }''','''    pub fn with_conn<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T>,
    {
        if Self::maintenance_no_wait_active() {
            let stop = MAINTENANCE_STOP_SIGNALS.with(|signals| signals.borrow().last().cloned())
                .expect("maintenance guard owns its stop signal");
            let result = narrative_maintenance_connection::with_narrative_maintenance_graph_control(
                self, Duration::ZERO, 1_000, stop,
                narrative_maintenance_connection::NarrativeMaintenanceGraphControlConfig::default(),
                |conn, control| {
                    control.check(narrative_extraction::nir1_entity_relation_index::GraphWorkStage::Row)?;
                    // No post-commit stop check: callers must receive the ID
                    // of any intermediate Run that f has already committed.
                    f(conn)
                },
            )?;
            let result = result.ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_CONNECTION_PREEMPTED: recovery connection is busy"))?;
            return result.into_result().map_err(|error| {
                if self.connection_reusable() && error.chain().any(|cause| {
                    matches!(cause.downcast_ref::<rusqlite::Error>(), Some(rusqlite::Error::SqliteFailure(code, _))
                        if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
                }) { error.context("NEX_MAINTENANCE_CONNECTION_PREEMPTED: SQLite writer is busy") } else { error }
            });
        }
        let conn = self.lock_conn()?;
        f(&conn)
    }''')
MR='src-tauri/crates/grimodex-db/src/narrative_extraction/maintenance_runtime.rs'
p=R/MR;s=p.read_text();a=s.index('pub fn run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control');b=s.index('{',a)
print('Controlled cycle header:',s[a:b]);assert 'db: &Database' in s[a:b] and 'control:' in s[a:b]
s=s[:b+1]+'''\n    let _recovery_connection_owner = control.map(|control| {
        db.enter_maintenance_connection_no_wait_with_stop(maintenance_stop_signal(Some(control)))
    });
'''+s[b+1:];p.write_text(s);changed.add(MR)
# Read only the required remaining entry points; never print credentials.
for path,names in {
'electron/native/grimodex-node/src/lib.rs':['pub async fn verify_narrative_dependency_graph','pub async fn rebuild_narrative_derived_state','pub async fn open_workspace','pub async fn restore_backup'],
'electron/native/grimodex-node/src/state.rs':['pub fn register_attempt','pub fn release_attempt','pub fn with_workspace','pub fn settle'],
'electron/shared/ipcContract.ts':['verify_narrative_dependency_graph:', 'rebuild_narrative_derived_state:', 'interface Dispatch'],
}.items():
 lines=(R/path).read_text().splitlines()
 for name in names:
  for i,line in enumerate(lines):
   if name in line:
    print(f'\n--- {path}:{i+1} {name} ---');print('\n'.join(f'{j+1}: {lines[j]}' for j in range(max(0,i-3),min(len(lines),i+100))));break
print('Modified files:',json.dumps(sorted(changed)))
