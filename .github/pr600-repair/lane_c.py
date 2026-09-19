from pathlib import Path
R=Path.cwd()
def edit(path,old,new,count=1):
 p=R/path;s=p.read_text();assert s.count(old)==count,(path,old[:100],s.count(old));p.write_text(s.replace(old,new))
def append(path,text):
 p=R/path;p.write_text(p.read_text()+text)
NL='electron/native/grimodex-node/src/lib.rs'
p=R/NL;s=p.read_text();a=s.index('pub fn get_narrative_maintenance_workspace_binding');b=s.index('    ///',a)
part=s[a:b];old='        let authority_id = narrative_authority_id(&authority);';assert old in part
part=part.replace(old,'''        if !authority.db().connection_reusable() { return Err(Error::from_reason("NEX_MAINTENANCE_CONNECTION_UNUSABLE: reopen workspace")); }
'''+old);p.write_text(s[:a]+part+s[b:])
edit(NL,'''    anyhow::ensure!(authority.db().connection_reusable(), "NEX_MAINTENANCE_CONNECTION_UNUSABLE: reopen workspace before maintenance");''','''    if !authority.db().connection_reusable() { return Err(AppError::Anyhow(anyhow::anyhow!("NEX_MAINTENANCE_CONNECTION_UNUSABLE: reopen workspace before maintenance"))); }''')
RR='src-tauri/crates/grimodex-db/src/narrative_extraction/restore_rebuild.rs'
# Hold the exact ID across post-commit connection cleanup errors as well.
p=R/RR;s=p.read_text()
for begin,end in [('    let (run_id, semantic_epoch_id, already_running) = run_maintenance_graph_phase(', '    if already_running {'),('    let created = run_maintenance_graph_phase(', '    let run_id = created.run_id;')]:
 a=s.index(begin);b=s.index(end,a);part=s[a:b]
 part=part.replace('run_maintenance_graph_phase(', 'run_maintenance_creation_phase(',1)
 part=part.replace('            with_immediate_transaction(conn, |conn| {','            let created = with_immediate_transaction(conn, |conn| {',1)
 # Both creation closures end after the transaction's own COMMIT.
 old='            })\n        },\n    )?;'
 assert old in part,part
 if begin.startswith('    let (run_id'):
  new='''            })?;
            let run = (!created.2).then(|| created.0.clone());
            Ok((created, run))
        },
    )?;'''
 else:
  new='''            })?;
            let run = (!created.reused).then(|| created.run_id.clone());
            Ok((created, run))
        },
    )?;'''
 part=part.replace(old,new,1);s=s[:a]+part+s[b:]
helper='''fn run_maintenance_creation_phase<T>(
    db: &Database, control: &MaintenanceCycleControl<'_>,
    operation: impl FnOnce(&Connection, &mut dyn GraphWorkControl) -> anyhow::Result<(T, Option<String>)>,
) -> anyhow::Result<T> {
    let mut committed_run = None;
    let result = run_maintenance_graph_phase(db, control, |conn, graph| {
        let (value, run) = operation(conn, graph)?;
        committed_run = run;
        Ok(value)
    });
    match result {
        Err(error) => {
            if let Some(run_id) = committed_run {
                if let Err(handoff) = transfer_controlled_maintenance_run_to_owner(db, &run_id, &error, control) {
                    return Err(error.context(format!("NEX_MAINTENANCE_RUN_HANDOFF_FAILED: {handoff:#}")));
                }
            }
            Err(error)
        }
        success => success,
    }
}

'''
i=s.index('pub(crate) fn run_maintenance_graph_phase_for_run');s=s[:i]+helper+s[i:];p.write_text(s)
append(RR,r'''
#[cfg(test)]
mod pr600_cancel_handoff_tests {
    use super::*;
    use super::super::maintenance_runtime::DesiredWork;
    use std::cell::RefCell;
    #[test]
    fn cancelled_verify_and_rebuild_release_durable_lifecycles_and_retry() {
        for verify in [true, false] {
            let db = Database::new(std::path::Path::new(":memory:")).unwrap();
            db.migrate().unwrap();
            let project = "pr600-cancel-project";
            db.with_conn(|conn| {
                conn.execute("INSERT INTO projects(id,title) VALUES(?1,'PR600')",[project])?;
                conn.execute("INSERT INTO narrative_semantic_epochs(id,project_id,epoch_number,reason,created_at) VALUES('pr600-epoch',?1,0,'initial','2026-09-19T00:00:00.000Z')",[project])?;
                Ok(())
            }).unwrap();
            let pending = RefCell::new(Vec::<String>::new());
            let no_stop = || Ok::<(),anyhow::Error>(());
            let no_work = |_work: &DesiredWork| Ok::<(),anyhow::Error>(());
            let defer = |id: &str| { pending.borrow_mut().push(id.to_string()); Ok::<(),anyhow::Error>(()) };
            let cancel = |_key: &str| -> anyhow::Result<()> { anyhow::bail!("NEX_MAINTENANCE_ATTEMPT_CANCELLED: regression before final grant") };
            let allow = |_key: &str| Ok::<(),anyhow::Error>(());
            let mut control = MaintenanceCycleControl {
                should_stop: &no_stop, stop_signal: None, finalization_granted_signal: None,
                defer_preempted_run: &defer, grant_finalize: &allow, register_work: &no_work,
                work_started: &no_work, work_completed: &no_work, work_noop_completed: &no_work, work_deferred: &no_work,
            };
            let run = |control: &MaintenanceCycleControl<'_>| -> anyhow::Result<()> {
                if verify { run_dependency_verify_for_project_with_coordinates_and_control(&db,project,None,Some(control),"pr600-manual").map(|_| ()) }
                else { rebuild_narrative_derived_state_for_project_with_control(&db,project,Some(control),"pr600-manual").map(|_| ()) }
            };
            run(&control).expect("first successful execution");
            control.grant_finalize = &cancel;
            let error = run(&control).expect_err("cancel repeat after committed Run creation");
            assert!(format!("{error:#}").contains("NEX_MAINTENANCE_ATTEMPT_CANCELLED"),"{error:#}");
            assert!(pending.borrow().is_empty());
            db.with_conn(|conn| {
                let active:i64=conn.query_row("SELECT COUNT(*) FROM narrative_extraction_runs r JOIN narrative_extraction_tasks t ON t.run_id=r.id JOIN narrative_extraction_attempts a ON a.task_id=t.id WHERE r.project_id=?1 AND (r.status='running' OR t.status='running' OR a.status='running')",[project],|r|r.get(0))?;
                assert_eq!(active,0,"no ownerless live Run/Task/Attempt"); Ok(())
            }).unwrap();
            control.grant_finalize = &allow;
            run(&control).expect("same-process retry must not coalesce with an abandoned Run");
        }
    }
}
''')
append('src-tauri/crates/grimodex-db/src/lib.rs',r'''
#[cfg(test)]
mod pr600_recovery_connection_tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    #[test]
    fn ordinary_recovery_with_conn_does_not_wait_for_another_sqlite_writer() -> anyhow::Result<()> {
        let path = std::env::temp_dir().join(format!("pr600-recovery-{}.db",uuid::Uuid::new_v4()));
        {
            let db = Database::new(&path)?;
            db.with_conn(|conn| { conn.execute_batch("CREATE TABLE pr600_probe(id INTEGER)")?; Ok(()) })?;
            let locker = Connection::open(&path)?;
            locker.execute_batch("BEGIN IMMEDIATE")?;
            let guard = db.enter_maintenance_connection_no_wait();
            let started = std::time::Instant::now();
            let error = db.with_conn(|conn| { conn.execute_batch("BEGIN IMMEDIATE; ROLLBACK")?; Ok(()) }).unwrap_err();
            assert!(started.elapsed() < Duration::from_secs(1),"{error:#}");
            assert!(format!("{error:#}").contains("NEX_MAINTENANCE_CONNECTION_PREEMPTED"));
            assert!(db.connection_reusable());
            drop(guard);
            locker.execute_batch("ROLLBACK")?;
            db.with_conn(|conn| {
                let timeout:i64=conn.pragma_query_value(None,"busy_timeout",|r|r.get(0))?;
                assert_eq!(timeout,5_000); assert!(conn.is_autocommit()); Ok(())
            })?;
        }
        for suffix in ["","-wal","-shm"] { let _=std::fs::remove_file(format!("{}{suffix}",path.display())); }
        Ok(())
    }
    #[test]
    fn ordinary_recovery_sql_inherits_attempt_stop_and_restores_connection() -> anyhow::Result<()> {
        let db=Database::new(std::path::Path::new(":memory:"))?;
        let stop=Arc::new(AtomicBool::new(false)); let barrier=Arc::new(Barrier::new(2));
        let owner=db.enter_maintenance_connection_no_wait_with_stop(Arc::clone(&stop));
        let other_stop=Arc::clone(&stop); let other_barrier=Arc::clone(&barrier);
        let worker=std::thread::spawn(move|| { other_barrier.wait(); other_stop.store(true,Ordering::Release); });
        let error=db.with_conn(|conn| {
            barrier.wait();
            let _:i64=conn.query_row("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000000) SELECT sum(x) FROM n",[],|r|r.get(0))?;
            Ok(())
        }).unwrap_err();
        worker.join().unwrap(); drop(owner);
        assert!(narrative_extraction::source_revision::is_validation_terminated(&error),"{error:#}");
        assert!(db.connection_reusable());
        db.with_conn(|conn| { assert!(conn.is_autocommit()); let n:i64=conn.query_row("SELECT 1",[],|r|r.get(0))?;assert_eq!(n,1);Ok(()) })
    }
}
''')
print('Lane C regressions and creation-ID handoff applied')
