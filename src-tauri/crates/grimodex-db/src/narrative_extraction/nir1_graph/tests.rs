use super::*;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::nir1_entity_relation::{
    create_nir1_entity_relation_revision,
    tests::{approve_typed_revision, prepare_a3_scope_fixture, request, seed_run_and_catalog},
};
use crate::narrative_extraction::nir1_entity_relation_index::{
    prepare_graph_index_build, publish_nir1_entity_relation_index_in_tx,
};
use crate::state::{active_workspace_snapshot, ActiveWorkspace, WorkspaceState};
use crate::workspace_lifecycle::{
    AdmissionKind, AdmissionOutcome, LiveBinding, WorkspaceLifecycleCompatibilityView,
    WorkspaceLifecycleCore,
};
use grimodex_core::narrative_nir1::ScopeValue;
use std::{
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

const PROJECT: &str = "default-project";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Q2WorkerScenario {
    ReaderOnly,
    NativeOwner,
    CleanupUnproved,
    #[cfg(target_os = "linux")]
    OwnerDeathHelper,
}

struct TestDirectory(PathBuf);
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    authority: Arc<WorkspaceAuthority>,
    lifecycle: WorkspaceLifecycleCore,
    revision: String,
    _directory: TestDirectory,
}

// Test maintenance admission only: production readers cannot mint this owner.
struct RegistrationOwner;
impl GraphWorkControl for RegistrationOwner {
    fn check(&mut self, _: GraphWorkStage) -> Result<()> {
        Ok(())
    }
    fn progress_callback(&self) -> Option<GraphProgressCallback> {
        Some(Arc::new(|| false))
    }
    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

impl Fixture {
    fn new() -> Result<Self> {
        Self::with_direction("directed")
    }

    fn with_direction(direction: &str) -> Result<Self> {
        Self::with_extra_relation(direction, false)
    }

    fn with_extra_relation(direction: &str, extra_relation: bool) -> Result<Self> {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("nir1-c-graph-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0)?;
        let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
        db.migrate()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_relations SET directionality=?1 WHERE id='nir1-edge'",
                [direction],
            )?;
            if extra_relation {
                conn.execute(
                    "INSERT INTO codex_relations
                     (id,project_id,from_codex_id,to_codex_id,relation_type,directionality,version,updated_at)
                     VALUES ('nir1-edge-b','default-project','nir1-alice','nir1-bob','related',?1,1,'2026-09-12T00:00:00Z')",
                    [direction],
                )?;
            }
            Ok(())
        })?;
        run_incremental_freshness_cycle(&db)?;
        let mut typed = request(&db);
        for entity in &mut typed.bundle.entities {
            entity.scope.reading = ScopeValue::Exact {
                value: "scene:a3-source".into(),
            };
            entity.scope.phase = "draft".into();
        }
        typed.bundle.relations[0].directionality = direction.into();
        if extra_relation {
            let mut relation = typed.bundle.relations[0].clone();
            relation.edge_id = "nir1-edge-b".into();
            relation.relation_type = "related".into();
            relation.source_token = "v1@2026-09-12T00:00:00Z:relation:nir1-edge-b".into();
            typed.bundle.relations.push(relation);
        }
        let created = create_nir1_entity_relation_revision(&db, typed)?;
        approve_typed_revision(&db, "nir1-run", &created)?;
        let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
        let runtime = authority.nir_chronicle_index_runtime();
        let snapshot = authority
            .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT))?;
        authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
            tx.commit()?;
            Ok(())
        })?;
        Ok(Self {
            authority,
            lifecycle: WorkspaceLifecycleCore::new(),
            revision: created["revisionId"].as_str().unwrap().to_owned(),
            _directory: directory,
        })
    }

    fn reader(&self) -> Result<Nir1GraphReader> {
        Nir1GraphReader::open(
            Arc::clone(&self.authority),
            self.lifecycle.begin_workspace_participant()?,
        )
    }

    fn registered_reader(&self) -> Result<Nir1GraphReader> {
        let mut reader = self.reader()?;
        assert!(reader.register_with_control(PROJECT, &mut RegistrationOwner)?);
        Ok(reader)
    }

    fn add_decoys(&self, count: usize, source: &str) -> Result<()> {
        self.authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for index in 0..count {
                tx.execute("INSERT INTO narrative_dependency_edges
                    (id,project_id,consumer_kind,consumer_key,source_object_identity,read_set_json,created_at)
                    VALUES (?1,?2,'graph-test-unrelated',?1,?3,'[]','2026-09-22T00:00:00Z')",
                    params![format!("graph-decoy-{index}"), PROJECT, source])?;
            }
            tx.commit()?;
            Ok(())
        })
    }
}

fn graph_request(seed: &str) -> Nir1GraphRequest {
    Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: "nir1".into(),
        seed_entity_id: seed.into(),
    }
}

// Functional contracts have their own generous deadline; the production 8ms
// limit remains unchanged and deterministic exhaustion is tested separately.
fn query(reader: &mut Nir1GraphReader, seed: &str) -> Result<Nir1GraphResponse> {
    reader.query_with_deadline(&graph_request(seed), Duration::from_secs(2), 100_000)
}

/// Measurement-only probe for the production deadline. Functional fixtures
/// use a generous deadline so their correctness assertions are not coupled to
/// HDD scheduling; this ignored test exercises the actual public reader path.
#[test]
#[ignore = "run explicitly as the production 8ms availability measurement"]
fn production_query_has_an_available_8ms_success_path() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    let started = Instant::now();
    let response = reader.query(&graph_request("nir1-alice"))?;
    let elapsed = started.elapsed();
    eprintln!(
        "production graph query: status={} reason={:?} elapsed={elapsed:?}",
        response.status, response.reason
    );
    if response.status != "available" {
        // Diagnostic only: distinguish the 8 ms deadline from a fixture or
        // qualification failure without relaxing the production assertion.
        let diagnostic_started = Instant::now();
        let diagnostic = query(&mut reader, "nir1-alice")?;
        eprintln!(
            "generous-deadline diagnostic: status={} reason={:?} elapsed={:?}",
            diagnostic.status,
            diagnostic.reason,
            diagnostic_started.elapsed()
        );
    }
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert!(
        elapsed < Duration::from_millis(8),
        "production query exceeded its 8ms wall budget: {elapsed:?}"
    );
    Ok(())
}

// New Q2/R1/D0-local-explicit-scope variant: only a disposable copy receives
// canonical Scope/registry writes. The original diagnostic preseed stays Unknown
// (negative control). This tests the ordinary reader, NOT worker/Native lease.
#[test]
#[ignore = "requires a closed Q2/R1/D0-local preseed from the opt-in fixture builder"]
fn ordinary_reader_registers_and_queries_fixed_q2_fixture() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ReaderOnly)
}

#[test]
#[ignore = "requires a closed Q2/R1/D0-local preseed and a built normal worker binary"]
fn native_worker_returns_fixed_q2_frame_from_real_workspace_owner() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::NativeOwner)
}

#[test]
#[ignore = "isolated real-worker test; intentionally quarantines one owner until test-process exit"]
fn native_worker_quarantines_when_cleanup_proof_is_unobserved() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::CleanupUnproved)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "subprocess helper for the owner-process-death test"]
fn real_worker_owner_death_subprocess_helper() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::OwnerDeathHelper)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the official Q2 preseed and a normal-build worker binary"]
fn native_worker_exits_after_owner_process_dies_after_request_admission() -> Result<()> {
    use std::{
        os::unix::process::{CommandExt, ExitStatusExt},
        process::{Command, Stdio},
    };

    let _subreaper = LinuxSubreaper::enable()?;
    let fixture_path =
        std::env::temp_dir().join(format!("nir1-c-owner-death-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&fixture_path)?;
    let _fixture = TestDirectory(fixture_path.clone());
    let ready_path = fixture_path.join("worker-ready");
    let request_admitted_path = fixture_path.join("request-admitted");
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("real_worker_owner_death_subprocess_helper")
        .arg("--ignored")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("NIR1_OWNER_DEATH_FIXTURE_DIR", &fixture_path)
        .env("NIR1_OWNER_DEATH_READY_PATH", &ready_path)
        .env("NIR1_OWNER_DEATH_REQUEST_PATH", &request_admitted_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.process_group(0);
    let owner = command.spawn()?;
    let process_group = libc::pid_t::try_from(owner.id())?;
    let mut processes = OwnerDeathProcesses::new(owner, process_group);
    let worker_pid = processes.wait_for_worker_pid(&ready_path, Duration::from_secs(60))?;
    processes.wait_for_request_admitted(&request_admitted_path, Duration::from_secs(60))?;
    processes.ensure_worker_stopped(worker_pid)?;

    let owner_status = processes.kill_owner()?;
    ensure!(
        owner_status.signal() == Some(libc::SIGKILL),
        "owner process was not killed: {owner_status}"
    );
    processes.resume_worker(worker_pid)?;
    let worker_status = processes.wait_for_worker_exit(worker_pid, Duration::from_secs(5))?;
    ensure!(
        libc::WIFEXITED(worker_status) && libc::WEXITSTATUS(worker_status) != 0,
        "worker did not fail closed after resumed owner-death EOF: wait status={worker_status}"
    );
    processes.ensure_process_group_empty()?;
    eprintln!(
        "Linux real-worker owner-death phase: complete request admitted; worker stopped under live owner at boundary; owner SIGKILL reaped; worker PID {worker_pid} resumed and waitpid-reaped with nonzero exit"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
struct LinuxSubreaper {
    previous: libc::c_int,
}

#[cfg(target_os = "linux")]
impl LinuxSubreaper {
    fn enable() -> Result<Self> {
        let mut previous = 0;
        let get_result = unsafe {
            libc::prctl(
                libc::PR_GET_CHILD_SUBREAPER,
                (&mut previous as *mut libc::c_int) as libc::c_ulong,
                0,
                0,
                0,
            )
        };
        ensure!(
            get_result == 0,
            "could not inspect Linux child-subreaper state: {}",
            std::io::Error::last_os_error()
        );
        let set_result = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
        ensure!(
            set_result == 0,
            "could not enable Linux child-subreaper state: {}",
            std::io::Error::last_os_error()
        );
        Ok(Self { previous })
    }
}

#[cfg(target_os = "linux")]
impl Drop for LinuxSubreaper {
    fn drop(&mut self) {
        unsafe {
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, self.previous, 0, 0, 0);
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_process_state_and_parent(pid: libc::pid_t) -> Result<(String, libc::pid_t)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let command_end = stat
        .rfind(')')
        .ok_or_else(|| anyhow::anyhow!("invalid process stat"))?;
    let mut fields = stat[command_end + 1..].split_whitespace();
    let state = fields
        .next()
        .ok_or_else(|| anyhow::anyhow!("process state missing"))?
        .to_owned();
    let parent = fields
        .next()
        .ok_or_else(|| anyhow::anyhow!("process parent PID missing"))?
        .parse::<libc::pid_t>()?;
    Ok((state, parent))
}

#[cfg(target_os = "linux")]
struct OwnerDeathProcesses {
    owner: std::process::Child,
    process_group: libc::pid_t,
    owner_reaped: bool,
    worker_reaped: bool,
}

#[cfg(target_os = "linux")]
impl OwnerDeathProcesses {
    fn new(owner: std::process::Child, process_group: libc::pid_t) -> Self {
        Self {
            owner,
            process_group,
            owner_reaped: false,
            worker_reaped: false,
        }
    }

    fn wait_for_worker_pid(
        &mut self,
        path: &std::path::Path,
        timeout: Duration,
    ) -> Result<libc::pid_t> {
        let deadline = Instant::now() + timeout;
        loop {
            match std::fs::read_to_string(path) {
                Ok(value) => {
                    let pid = value.trim().parse::<libc::pid_t>()?;
                    ensure!(pid > 0, "invalid worker PID in helper readiness record");
                    ensure!(
                        !self.owner_exited()?,
                        "owner helper exited immediately after publishing READY"
                    );
                    return Ok(pid);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if self.owner_exited()? {
                anyhow::bail!("owner helper exited before worker READY");
            }
            if Instant::now() >= deadline {
                anyhow::bail!("timed out waiting for READY worker PID");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn owner_exited(&mut self) -> Result<bool> {
        if self.owner_reaped {
            return Ok(true);
        }
        if self.owner.try_wait()?.is_some() {
            self.owner_reaped = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn wait_for_request_admitted(
        &mut self,
        path: &std::path::Path,
        timeout: Duration,
    ) -> Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            match std::fs::read_to_string(path) {
                Ok(value) => {
                    ensure!(value == "admitted", "invalid request-admission marker");
                    ensure!(
                        !self.owner_exited()?,
                        "owner helper exited after request admission"
                    );
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if self.owner_exited()? {
                anyhow::bail!("owner helper exited before request admission");
            }
            if Instant::now() >= deadline {
                anyhow::bail!("timed out waiting for complete request admission");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn ensure_worker_stopped(&mut self, worker: libc::pid_t) -> Result<()> {
        ensure!(
            !self.owner_exited()?,
            "owner helper exited before worker liveness check"
        );
        let (state, parent) = linux_process_state_and_parent(worker)?;
        let owner_pid = libc::pid_t::try_from(self.owner.id())?;
        ensure!(
            state == "T" && parent == owner_pid,
            "worker PID {worker} is not stopped and live under owner PID {owner_pid}: state={state}, parent={parent}"
        );
        Ok(())
    }

    fn kill_owner(&mut self) -> Result<std::process::ExitStatus> {
        ensure!(
            !self.owner_reaped,
            "owner helper exited before explicit kill"
        );
        self.owner.kill()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                anyhow::bail!("timed out waiting for killed owner process to exit");
            }
            if let Some(status) = self.owner.try_wait()? {
                self.owner_reaped = true;
                return Ok(status);
            }
            thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }

    fn resume_worker(&self, worker: libc::pid_t) -> Result<()> {
        let result = unsafe { libc::kill(worker, libc::SIGCONT) };
        ensure!(
            result == 0,
            "could not resume stopped worker PID {worker}: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }

    fn wait_for_worker_exit(&mut self, worker: libc::pid_t, timeout: Duration) -> Result<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            let mut status = 0;
            let result = unsafe { libc::waitpid(worker, &mut status, libc::WNOHANG) };
            if result == worker {
                self.worker_reaped = true;
                return Ok(status);
            }
            if result == 0 {
                if Instant::now() >= deadline {
                    anyhow::bail!("timed out waiting for actual worker exit (pid {worker})");
                }
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
    }

    fn ensure_process_group_empty(&self) -> Result<()> {
        ensure!(
            self.owner_reaped && self.worker_reaped,
            "owner/worker not reaped"
        );
        let result = unsafe { libc::kill(-self.process_group, 0) };
        ensure!(
            result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
            "test process group still exists after reaping owner and worker"
        );
        Ok(())
    }

    fn cleanup(&mut self) {
        if self.owner_reaped && self.worker_reaped {
            return;
        }
        unsafe {
            libc::kill(-self.process_group, libc::SIGKILL);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.owner_reaped && Instant::now() < deadline {
            match self.owner.try_wait() {
                Ok(Some(_)) => self.owner_reaped = true,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(_) => break,
            }
        }
        if !self.owner_reaped {
            return;
        }
        while Instant::now() < deadline {
            let mut status = 0;
            let result = unsafe { libc::waitpid(-self.process_group, &mut status, libc::WNOHANG) };
            if result > 0 {
                continue;
            }
            if result == 0 {
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                self.worker_reaped = true;
                return;
            }
            if error.kind() != std::io::ErrorKind::Interrupted {
                return;
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for OwnerDeathProcesses {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(target_os = "linux")]
fn stop_worker_for_owner_death(worker: libc::pid_t) -> Result<()> {
    let helper_pid = libc::pid_t::try_from(std::process::id())?;
    let (state, parent) = linux_process_state_and_parent(worker)?;
    ensure!(
        matches!(state.as_str(), "R" | "S" | "D" | "I" | "P") && parent == helper_pid,
        "worker PID {worker} is not live under helper PID {helper_pid}: state={state}, parent={parent}"
    );
    let result = unsafe { libc::kill(worker, libc::SIGSTOP) };
    ensure!(
        result == 0,
        "could not stop worker PID {worker}: {}",
        std::io::Error::last_os_error()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (state, parent) = linux_process_state_and_parent(worker)?;
        ensure!(
            parent == helper_pid,
            "worker PID {worker} was reparented before admission: parent={parent}"
        );
        if state == "T" {
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for worker PID {worker} to stop");
        }
        thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(target_os = "linux")]
fn owner_death_helper(authority: &Arc<WorkspaceAuthority>) -> Result<()> {
    let worker_path = PathBuf::from(
        std::env::var_os("NIR1_C_QUERY_WORKER_BIN")
            .ok_or_else(|| anyhow::anyhow!("NIR1_C_QUERY_WORKER_BIN missing"))?,
    );
    let switching = WorkspaceLifecycleCompatibilityView::new(false);
    let native_state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(authority)))),
        safe_mode: crate::recovery::SafeModeState::default(),
        switching,
        open_lock: Mutex::new(()),
    };
    let binding = LiveBinding::new(
        authority.path().to_string_lossy(),
        format!("test-workspace:{}", authority.identity()),
        authority.identity(),
        0,
    );
    native_state.switching.core().set_ready(binding)?;
    let snapshot = active_workspace_snapshot(&native_state)?;
    let mut owner = super::c_query_worker::CQueryWorkerOwner::new(snapshot, worker_path);
    owner.prepare("nir1-capacity-fixture-project")?;
    let worker_pid = owner.child_pid_for_test()?;
    stop_worker_for_owner_death(libc::pid_t::try_from(worker_pid)?)?;

    let ready_path = PathBuf::from(
        std::env::var_os("NIR1_OWNER_DEATH_READY_PATH")
            .ok_or_else(|| anyhow::anyhow!("owner-death readiness path missing"))?,
    );
    let temporary_path = ready_path.with_extension("tmp");
    std::fs::write(&temporary_path, worker_pid.to_string())?;
    std::fs::rename(temporary_path, ready_path)?;

    let request_admitted_path = PathBuf::from(
        std::env::var_os("NIR1_OWNER_DEATH_REQUEST_PATH")
            .ok_or_else(|| anyhow::anyhow!("owner-death request marker path missing"))?,
    );
    owner.hold_after_request_for_test(request_admitted_path);
    owner.query_once(&Nir1GraphRequest {
        project_id: "nir1-capacity-fixture-project".into(),
        query_scene_id: "nir1-capacity-scope-drift-scene".into(),
        seed_entity_id: "nir1-capacity-q-r0-e0".into(),
    })?;
    anyhow::bail!("owner-death helper unexpectedly returned a query lease")
}

fn q2_reader_fixture(scenario: Q2WorkerScenario) -> Result<()> {
    const PROJECT: &str = "nir1-capacity-fixture-project";
    const SOURCE_SCENE: &str = "nir1-capacity-scene"; // reading rank a0
    const QUERY_SCENE: &str = "nir1-capacity-scope-drift-scene"; // rank a1
    const ENTITY: &str = "nir1-capacity-q-r0-e0";
    use crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome;
    use crate::narrative_extraction::nir1_entity_relation_index::{
        prepare_graph_index_build_with_control,
        publish_nir1_entity_relation_index_in_tx_with_control,
    };
    use crate::narrative_extraction::scene_scope::{
        read_narrative_scene_scope, update_narrative_scene_scope,
        update_narrative_scene_scope_registry, NarrativeSceneScopeRegistryUpdatePayload,
        NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
    };
    use crate::narrative_extraction::{
        narrative_extraction_append_human_decision,
        project_scope_authority::load_live_project_scope_authority, AppendDecisionPayload,
        Nir1EntityRelationRevisionRequest,
    };
    use crate::narrative_maintenance_connection::{
        with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
    };
    use grimodex_core::narrative_nir1::EntityRelationBundle;
    use grimodex_core::narrative_scene_scope::{
        NarrativeSceneQueryIdentityV1, NarrativeScopeCompatibilityMarkerV1,
        NarrativeScopeConstraintV1,
    };

    fn maintenance<T>(
        db: &crate::Database,
        operation: impl FnOnce(&rusqlite::Connection, &mut dyn GraphWorkControl) -> Result<T>,
    ) -> Result<T> {
        with_narrative_maintenance_graph_control(
            db,
            Duration::ZERO,
            1_000,
            Arc::new(AtomicBool::new(false)),
            NarrativeMaintenanceGraphControlConfig::default(),
            operation,
        )?
        .ok_or_else(|| anyhow::anyhow!("fixture maintenance was deferred"))?
        .into_result()
    }

    #[cfg(target_os = "linux")]
    let directory_path = if scenario == Q2WorkerScenario::OwnerDeathHelper {
        PathBuf::from(
            std::env::var_os("NIR1_OWNER_DEATH_FIXTURE_DIR")
                .ok_or_else(|| anyhow::anyhow!("owner-death fixture directory missing"))?,
        )
    } else {
        std::env::temp_dir().join(format!("nir1-c-q2-{}", uuid::Uuid::new_v4()))
    };
    #[cfg(not(target_os = "linux"))]
    let directory_path = std::env::temp_dir().join(format!("nir1-c-q2-{}", uuid::Uuid::new_v4()));
    let directory = TestDirectory(directory_path);
    std::fs::create_dir_all(&directory.0)?;
    // Build the closed preseed separately with the opt-in fixture CLI, then
    // run this test WITHOUT its diagnostic feature on a disposable copy.
    let source = std::path::PathBuf::from(
        std::env::var_os("NIR1_Q2_FIXTURE_PATH")
            .ok_or_else(|| anyhow::anyhow!("NIR1_Q2_FIXTURE_PATH missing"))?,
    );
    ensure!(
        std::fs::symlink_metadata(&source)?.file_type().is_file(),
        "Q2 source not regular"
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        ensure!(
            !std::path::PathBuf::from(format!("{}{suffix}", source.display())).exists(),
            "Q2 source has a sidecar"
        );
    }
    let path = directory.0.join("grimodex.db");
    std::fs::copy(&source, &path)?;
    let authority = WorkspaceAuthority::from_database_for_test(
        crate::Database::new(&path)?,
        directory.0.clone(),
    )?;
    let (original_revision, run_id, mut bundle): (String, String, EntityRelationBundle) = authority.with_read_transaction(|conn| {
        for scene in [SOURCE_SCENE, QUERY_SCENE] {
            let original = read_narrative_scene_scope(conn, PROJECT, scene)?;
            ensure!(
                original.binding.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::Unknown,
                "original Q2 Scope must remain Unknown: {scene}"
            );
        }
        let revision = conn.query_row(
            "SELECT consumer_key FROM narrative_dependency_edges WHERE project_id=?1 AND source_object_identity=?2 AND consumer_kind='proposal-revision'",
            params![PROJECT, format!("codex:{ENTITY}")],
            |row| row.get::<_, String>(0),
        )?;
        ensure!(
            matches!(
                evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &revision, SOURCE_SCENE)?,
                Nir1EntityRelationDisclosureRead::Unavailable { reason } if reason == "a3-query-scope-unavailable"
            ),
            "original Q2 Unknown query Scope is an A3 negative control"
        );
        let (run_id, payload): (String, String) = conn.query_row(
            "SELECT proposal_set.run_id, revision.payload_json
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal ON proposal.id=revision.proposal_id
               JOIN narrative_proposal_sets proposal_set ON proposal_set.id=proposal.proposal_set_id
              WHERE revision.id=?1",
            [&revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let payload: serde_json::Value = serde_json::from_str(&payload)?;
        ensure!(payload["revisionId"] == revision && payload["projectId"] == PROJECT,
            "original Q2 typed Revision identity changed");
        let bundle = serde_json::from_value(payload["bundle"].clone())?;
        Ok((revision, run_id, bundle))
    })?;

    // Only this new variant gains a registry and resolved Explicit Source + S2.
    let current = authority
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, SOURCE_SCENE))?;
    let mut registry = current.registry;
    ensure!(
        registry.timeline_refs.is_empty()
            && registry.worldline_refs.is_empty()
            && registry.narrative_layer_refs.is_empty(),
        "Q2 preseed registry changed"
    );
    registry.timeline_refs.push("timeline:main".into());
    registry.worldline_refs.push("worldline:prime".into());
    registry
        .narrative_layer_refs
        .push("layer:manuscript".into());
    update_narrative_scene_scope_registry(
        &authority,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: PROJECT.into(),
            request_id: "q2-explicit-registry".into(),
            session_id: "q2-explicit-variant".into(),
            event_uid: "q2-explicit-registry-event".into(),
            base_version: current.registry_revision,
            updated_at: "2026-09-20T00:00:00.000Z".into(),
            registry,
        },
    )?;
    let identity = NarrativeSceneQueryIdentityV1 {
        timeline: NarrativeScopeConstraintV1::Exact {
            reference: "timeline:main".into(),
        },
        worldline: NarrativeScopeConstraintV1::Exact {
            reference: "worldline:prime".into(),
        },
        narrative_layer: NarrativeScopeConstraintV1::Exact {
            reference: "layer:manuscript".into(),
        },
    };
    for (scene, ordinal) in [(SOURCE_SCENE, 0), (QUERY_SCENE, 1)] {
        let current = authority
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, scene))?;
        update_narrative_scene_scope(
            &authority,
            NarrativeSceneScopeUpdatePayload {
                project_id: PROJECT.into(),
                scene_id: scene.into(),
                request_id: format!("q2-explicit-scope-{ordinal}"),
                session_id: "q2-explicit-variant".into(),
                event_uid: format!("q2-explicit-scope-event-{ordinal}"),
                base_version: current.binding.version,
                updated_at: format!("2026-09-20T00:00:0{}.000Z", ordinal + 1),
                scope: NarrativeSceneScopeUpdateV1 {
                    schema_version: current.binding.schema_version,
                    compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                    query_identity: identity.clone(),
                    material_constraint: current.binding.material_constraint,
                    knowledge_holder: current.binding.knowledge_holder,
                    audience: current.binding.audience,
                },
            },
        )?;
    }
    // The canonical writers emitted Feed changes; only the real Freshness
    // owner may bring the copied fixture current before registration.
    let mut drained = false;
    for _ in 0..8 {
        match run_incremental_freshness_cycle(&authority)? {
            IncrementalFreshnessCycleOutcome::Processed(_) => {}
            IncrementalFreshnessCycleOutcome::Idle => {
                drained = true;
                break;
            }
            IncrementalFreshnessCycleOutcome::Held(_) => anyhow::bail!("Q2 Freshness held"),
        }
    }
    ensure!(drained, "Q2 Freshness Feed did not drain");
    ensure!(
        matches!(
            authority.with_read_transaction(|conn| evaluate_nir1_entity_relation_disclosure(
                conn, PROJECT, &original_revision, QUERY_SCENE
            ))?,
            Nir1EntityRelationDisclosureRead::Unavailable { reason } if reason == "source-revision-changed"
        ),
        "old immutable Revision must not regain Source currentness after Scope change"
    );
    // Scope extension changes the project's source revision token. Re-issue
    // exactly the same Q2 material through the Native typed writer and a new
    // Human Decision; neither Freshness nor registration can revive the old
    // immutable Revision. The original preseed and its approval stay intact.
    let current_authority = authority.with_read_transaction(|conn| {
        load_live_project_scope_authority(
            conn,
            PROJECT,
            &format!("project:scope-authority:{PROJECT}"),
        )
    })?;
    ensure!(
        bundle.entities.len() == 1 && bundle.relations.is_empty(),
        "Q2 shape changed"
    );
    bundle.entities[0].scope.authority_revision = current_authority.source.revision_token;
    let created = create_nir1_entity_relation_revision(
        &authority,
        Nir1EntityRelationRevisionRequest {
            run_id: run_id.clone(),
            project_id: PROJECT.into(),
            proposal_key: "nir1:capacity:q2-explicit-scope".into(),
            bundle,
        },
    )?;
    let revision = created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Q2 typed writer omitted Revision ID"))?
        .to_owned();
    let proposal_id = created["proposalId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Q2 typed writer omitted Proposal ID"))?;
    ensure!(
        revision != original_revision,
        "Q2 variant must have a new immutable Revision"
    );
    narrative_extraction_append_human_decision(
        &authority,
        AppendDecisionPayload {
            run_id,
            project_id: PROJECT.into(),
            proposal_id: proposal_id.into(),
            revision_id: revision.clone(),
            decision: "approved".into(),
            decision_json: None,
            created_by: Some("q2-explicit-scope-fixture-variant".into()),
        },
    )?;

    let runtime = authority.nir_chronicle_index_runtime();
    let snapshot = maintenance(&authority, |conn, control| {
        let tx = conn.unchecked_transaction()?;
        let snapshot = prepare_graph_index_build_with_control(&tx, runtime, PROJECT, control)?;
        tx.commit()?;
        Ok(snapshot)
    })?;
    maintenance(&authority, |conn, control| {
        let tx = conn.unchecked_transaction()?;
        let published =
            publish_nir1_entity_relation_index_in_tx_with_control(&tx, runtime, snapshot, control)?;
        tx.commit()?;
        Ok(published)
    })?;
    #[cfg(target_os = "linux")]
    if scenario == Q2WorkerScenario::OwnerDeathHelper {
        return owner_death_helper(&authority);
    }
    let lifecycle = WorkspaceLifecycleCore::new();
    let mut reader = Nir1GraphReader::open(
        Arc::clone(&authority),
        lifecycle.begin_workspace_participant()?,
    )?;
    let request = Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: QUERY_SCENE.into(),
        seed_entity_id: ENTITY.into(),
    };
    assert_unavailable(&reader.query(&request)?, "registration-required");
    ensure!(
        maintenance(&authority, |_, control| {
            reader.register_with_control(PROJECT, control)
        })?,
        "Q2 complete registration failed"
    );
    let started = Instant::now();
    let response = reader.query(&request)?;
    let elapsed = started.elapsed();
    eprintln!(
        "ordinary Q2/R1/D0-local-explicit-scope reader query: status={} reason={:?} elapsed={elapsed:?}",
        response.status, response.reason
    );
    ensure!(
        response.status == "available",
        "Q2 query: {:?}",
        response.reason
    );
    let graph = response
        .graph
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Q2 graph absent"))?;
    // Independent expectation: Q2's 2 materials are one Entity + Evidence;
    // Source and human Decision were written before this variant was copied.
    assert_eq!(graph.seed_entity_id, ENTITY);
    if graph.nodes.is_empty() {
        let disclosure = authority.with_read_transaction(|conn| {
            evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &revision, QUERY_SCENE)
        })?;
        match disclosure {
            Nir1EntityRelationDisclosureRead::Unavailable { reason } => {
                anyhow::bail!("Q2 explicit-scope A3 rejected exact revision: {reason}")
            }
            other => anyhow::bail!("Q2 explicit-scope graph empty with A3: {other:?}"),
        }
    }
    assert_eq!(graph.nodes.len(), 1);
    assert!(graph.edges.is_empty());
    assert_eq!(graph.nodes[0].hop, 0);
    let entity = &graph.nodes[0].entity;
    assert_eq!(entity.entity_id, ENTITY);
    assert_eq!(entity.entity_type, "character");
    assert_eq!(entity.label, ENTITY);
    assert_eq!(
        entity.source_token,
        format!("codex:{ENTITY}@2026-09-17T00:00:00Z")
    );
    assert_eq!(
        entity.scope.reading,
        ScopeValue::Exact {
            value: format!("scene:{SOURCE_SCENE}")
        }
    );
    assert_eq!(entity.evidence.len(), 1);
    let evidence = &entity.evidence[0];
    assert_eq!(
        evidence.evidence_id,
        format!("nir1:capacity:evidence:0:{ENTITY}")
    );
    assert_eq!(evidence.source_ref, format!("codex:{ENTITY}"));
    assert_eq!(evidence.start_utf16, 0);
    assert_eq!(evidence.quote, format!("fixture source {ENTITY} 日本語"));
    assert_eq!(evidence.end_utf16, evidence.quote.encode_utf16().count());
    assert_eq!(graph.nodes[0].bindings.len(), 1);
    assert_eq!(graph.nodes[0].bindings[0].revision_id, revision);
    ensure!(
        !graph.nodes[0].bindings[0].decision_id.is_empty(),
        "Q2 Human Decision missing"
    );
    reader.close()?;
    assert_eq!(lifecycle.workspace_participant_count()?, 0);

    if scenario != Q2WorkerScenario::ReaderOnly {
        let worker_path = PathBuf::from(
            std::env::var_os("NIR1_C_QUERY_WORKER_BIN")
                .ok_or_else(|| anyhow::anyhow!("NIR1_C_QUERY_WORKER_BIN missing"))?,
        );
        let switching = WorkspaceLifecycleCompatibilityView::new(false);
        let native_state = WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching,
            open_lock: Mutex::new(()),
        };
        let original_binding = LiveBinding::new(
            authority.path().to_string_lossy(),
            format!("test-workspace:{}", authority.identity()),
            authority.identity(),
            0,
        );
        native_state
            .switching
            .core()
            .set_ready(original_binding.clone())?;

        if scenario == Q2WorkerScenario::CleanupUnproved {
            let mut owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&native_state)?,
                worker_path.clone(),
            );
            owner.prepare(&request.project_id)?;
            owner.suppress_eof_proof_for_test();
            let started = Instant::now();
            let error = match owner.query_once(&request) {
                Ok(_) => anyhow::bail!("unproved cleanup returned a result lease"),
                Err(error) => error,
            };
            let returned_elapsed = started.elapsed();
            let error_text = format!("{error:#}");
            ensure!(
                error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED")
                    && error_text.contains("NIR1_GRAPH_TEST_EOF_PROOF_UNOBSERVED"),
                "cleanup did not fail closed after proof suppression: {error_text}"
            );
            ensure!(
                owner.normal_exit_and_eof_observed_for_test(),
                "test did not observe successful child exit + real reader EOF + complete frame"
            );
            ensure!(
                !owner.cleanup_proved_for_test(),
                "cleanup proof unexpectedly advanced despite withheld EOF transfer"
            );
            ensure!(
                owner.quarantined_resources_held_for_test(),
                "snapshot, claim, Native region, child status and reader handle were not quarantined"
            );
            ensure!(
                returned_elapsed > QUERY_DEADLINE,
                "cleanup timeout was conflated with the 8ms Graph deadline: {returned_elapsed:?}"
            );
            eprintln!(
                "Native Q2 cleanup-unproved: call-to-error={returned_elapsed:?}; query deadline={QUERY_DEADLINE:?}; cleanup deadline=500ms; child exit + real EOF + full frame observed, EOF proof transfer suppressed"
            );

            let late_error = match owner.query_once(&request) {
                Ok(_) => anyhow::bail!("quarantined owner adopted a late result"),
                Err(error) => error,
            };
            ensure!(
                late_error
                    .to_string()
                    .contains("NIR1_GRAPH_WORKER_ONE_QUERY_ONLY"),
                "quarantined owner accepted another query: {late_error:#}"
            );
            if let Some(claim) = authority.claim_c_query_child() {
                claim.release();
                anyhow::bail!("claim was reloaned before owner Drop");
            }
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                1
            );

            drop(owner);
            if let Some(claim) = authority.claim_c_query_child() {
                claim.release();
                anyhow::bail!("claim was reloaned by owner Drop");
            }
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                1,
                "owner Drop released its quarantined workspace snapshot"
            );
            let mut reloan_owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&native_state)?,
                worker_path,
            );
            let reloan_error = reloan_owner
                .prepare(&request.project_id)
                .expect_err("same-authority reloan must remain closed after owner Drop");
            ensure!(
                reloan_error.to_string().contains("NIR1_GRAPH_WORKER_BUSY"),
                "same-authority reloan was not rejected: {reloan_error:#}"
            );
            drop(reloan_owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                1
            );
            return Ok(());
        }

        let snapshot = active_workspace_snapshot(&native_state)?;
        let mut owner =
            super::c_query_worker::CQueryWorkerOwner::new(snapshot, worker_path.clone());
        owner.prepare(&request.project_id)?;
        let call_started = Instant::now();
        let query_result = owner.query_once(&request);
        let returned_elapsed = call_started.elapsed();
        if query_result.is_err() {
            let error = query_result
                .err()
                .ok_or_else(|| anyhow::anyhow!("Q2 diagnostic result changed"))?;
            let phases = owner.query_phase_diagnostics_for_test();
            eprintln!(
                "Native Q2 worker phase diagnostic (test instrumentation; diagnostic only): call_entry_to_return={returned_elapsed:?}; admission_to_lease=None; outcome=refused; phases={phases:?}"
            );
            return Err(error);
        }
        let lease = query_result?;
        let admission_elapsed = lease.elapsed();
        let phases = lease.query_phase_diagnostics_for_test();
        eprintln!(
            "Native Q2 worker phase diagnostic (test instrumentation; diagnostic only): call_entry_to_return={returned_elapsed:?}; admission_to_lease={admission_elapsed:?}; outcome=lease; phases={phases:?}"
        );
        ensure!(
            returned_elapsed <= Duration::from_millis(8),
            "Native Q2 worker returned after deadline: {returned_elapsed:?}"
        );
        ensure!(
            admission_elapsed <= Duration::from_millis(8),
            "Native Q2 worker admission deadline: {admission_elapsed:?}"
        );
        {
            let frame = lease.frame()?;
            assert_eq!(frame.project, PROJECT);
            assert_eq!(frame.scene, QUERY_SCENE);
            assert_eq!(frame.seed, Some(ENTITY));
            assert!(frame.scope.is_some_and(|scope| !scope.is_empty()));
            assert!(frame.generation.is_some_and(|generation| generation > 0));
            assert_eq!(frame.node_count, 1);
            assert_eq!(frame.edge_count, 0);
            let node = frame
                .first_node
                .ok_or_else(|| anyhow::anyhow!("Q2 worker node missing"))?;
            assert_eq!(node.hop, 0);
            assert_eq!(node.entity.id, ENTITY);
            assert_eq!(node.entity.kind, "character");
            assert_eq!(node.entity.label, ENTITY);
            assert_eq!(
                node.entity.source,
                format!("codex:{ENTITY}@2026-09-17T00:00:00Z")
            );
            assert!(
                matches!(node.entity.reading, super::worker_frame::ScopeView::Exact(value) if value == format!("scene:{SOURCE_SCENE}"))
            );
            assert_eq!(node.entity.evidence_count, 1);
            let evidence = node
                .entity
                .first_evidence
                .ok_or_else(|| anyhow::anyhow!("Q2 worker evidence missing"))?;
            assert_eq!(evidence.id, format!("nir1:capacity:evidence:0:{ENTITY}"));
            assert_eq!(evidence.source, format!("codex:{ENTITY}"));
            assert_eq!(evidence.quote, format!("fixture source {ENTITY} 日本語"));
            assert_eq!(evidence.start, 0);
            assert_eq!(evidence.end as usize, evidence.quote.encode_utf16().count());
            assert_eq!(node.binding_count, 1);
            let binding = node
                .first_binding
                .ok_or_else(|| anyhow::anyhow!("Q2 worker binding missing"))?;
            assert_eq!(binding.revision_id, revision);
            assert!(!binding.decision_id.is_empty());
        }
        assert!(
            authority.claim_c_query_child().is_none(),
            "result lease released Native capacity early"
        );
        let mut competing_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        let competing_error = competing_owner
            .prepare(&request.project_id)
            .expect_err("another worker must not start while a result lease is held");
        assert!(
            competing_error
                .to_string()
                .contains("NIR1_GRAPH_WORKER_BUSY"),
            "second actual owner was not rejected by the authority claim: {competing_error:#}"
        );
        drop(competing_owner);
        drop(lease);
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("result lease drop did not release capacity"))?;
        claim.release();
        drop(owner);
        assert_eq!(
            native_state
                .switching
                .core()
                .workspace_participant_count()?,
            0
        );

        let mut crashed_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        crashed_owner.prepare(&request.project_id)?;
        let mut busy_during_crash = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        let busy_error = busy_during_crash
            .prepare(&request.project_id)
            .expect_err("the READY child must retain its claim until cleanup");
        ensure!(
            busy_error.to_string().contains("NIR1_GRAPH_WORKER_BUSY"),
            "READY child did not retain capacity: {busy_error:#}"
        );
        drop(busy_during_crash);

        crashed_owner.crash_child_after_ready_for_test()?;
        let crash_error = match crashed_owner.query_once(&request) {
            Ok(_) => anyhow::bail!("a crashed worker returned a result lease"),
            Err(error) => error,
        };
        ensure!(
            crash_error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::BrokenPipe),
            "READY-child crash did not produce the expected BrokenPipe refusal: {crash_error:#}"
        );
        ensure!(
            !format!("{crash_error:#}").contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "child exit + stdout EOF were not proven before returning: {crash_error:#}"
        );
        drop(crashed_owner);

        let mut fresh_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        fresh_owner.prepare(&request.project_id).map_err(|error| {
            anyhow::anyhow!("fresh owner after proved crash cleanup failed: {error:#}")
        })?;
        drop(fresh_owner);
        let claim = authority.claim_c_query_child().ok_or_else(|| {
            anyhow::anyhow!("fresh owner cleanup did not release the child claim")
        })?;
        claim.release();

        let mut admitted_crashed_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        admitted_crashed_owner.prepare(&request.project_id)?;
        let mut busy_during_admitted_fault = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        let busy_error = busy_during_admitted_fault
            .prepare(&request.project_id)
            .expect_err("admitted-fault child must retain its authority claim");
        ensure!(
            busy_error.to_string().contains("NIR1_GRAPH_WORKER_BUSY"),
            "admitted-fault child did not retain capacity: {busy_error:#}"
        );
        drop(busy_during_admitted_fault);

        admitted_crashed_owner.crash_after_request_for_test();
        eprintln!(
            "Native admitted-query fault: request write + OWNER_REQUEST publication precede kill; SQL/frame progress is unobserved"
        );
        let admission_crash_error = match admitted_crashed_owner.query_once(&request) {
            Ok(_) => anyhow::bail!("post-admission child crash returned a result lease"),
            Err(error) => error,
        };
        let admission_crash_text = format!("{admission_crash_error:#}");
        ensure!(
            admission_crash_text.contains("NIR1_GRAPH_TEST_CHILD_CRASH_AFTER_REQUEST"),
            "fault did not terminate the child after Native request admission: {admission_crash_text}"
        );
        ensure!(
            !admission_crash_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "post-admission cleanup did not prove child exit and stdout EOF: {admission_crash_text}"
        );
        ensure!(
            admitted_crashed_owner.abnormal_exit_observed_for_test(),
            "post-admission fault did not observe an abnormal child exit"
        );
        ensure!(
            admitted_crashed_owner.cleanup_proved_for_test(),
            "claim release preceded observed child exit, stdout EOF and reader join"
        );
        eprintln!(
            "Native admitted-query cleanup proved: child exit + stdout EOF + reader join before claim release"
        );
        let claim = authority.claim_c_query_child().ok_or_else(|| {
            anyhow::anyhow!("post-admission cleanup did not release the child claim")
        })?;
        claim.release();
        drop(admitted_crashed_owner);

        let mut admitted_reloan_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        admitted_reloan_owner
            .prepare(&request.project_id)
            .map_err(|error| {
                anyhow::anyhow!("same-authority reloan after admission cleanup failed: {error:#}")
            })?;
        drop(admitted_reloan_owner);
        let claim = authority.claim_c_query_child().ok_or_else(|| {
            anyhow::anyhow!("same-authority reloan cleanup did not release the child claim")
        })?;
        claim.release();

        let mut failed_start_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        let failed_start = failed_start_owner
            .prepare("nir1-project-that-does-not-exist")
            .expect_err("worker must not report READY for an unregistered project");
        let failed_start_text = failed_start.to_string();
        assert!(
            [
                "NIR1_GRAPH_WORKER_EXIT_BEFORE_READY",
                "NIR1_GRAPH_WORKER_PIPE_ERROR",
                "NIR1_GRAPH_WORKER_READY_PIPE_CLOSED",
            ]
            .iter()
            .any(|marker| failed_start_text.contains(marker)),
            "expected a concrete pre-READY child/pipe failure, got: {failed_start:#}"
        );
        assert!(
            !failed_start_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "failed startup did not prove child exit and stdout EOF: {failed_start:#}"
        );
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("proved startup cleanup did not release the claim"))?;
        claim.release();
        drop(failed_start_owner);

        let mut restore_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path,
        );
        restore_owner.prepare(&request.project_id)?;
        let restore_ticket = match native_state
            .switching
            .core()
            .begin_transition(AdmissionKind::Restore)?
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { reason, .. } => {
                anyhow::bail!("Restore was not admitted for the pinned-worker test: {reason:?}")
            }
        };
        let stale_result = match restore_owner.query_once(&request) {
            Ok(_) => anyhow::bail!("a Restore transition returned a result from the old binding"),
            Err(error) => error,
        };
        let stale_result_text = stale_result.to_string();
        assert!(
            stale_result_text
                .contains("workspace lifecycle cannot publish Ready from its current state"),
            "result was not rejected by the active Restore binding: {stale_result:#}"
        );
        assert!(
            !stale_result_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "Restore rejection did not prove child exit and stdout EOF: {stale_result:#}"
        );
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("Restore cleanup did not release the child claim"))?;
        claim.release();
        drop(restore_owner);
        native_state
            .switching
            .core()
            .mark_transition_joined(&restore_ticket)?;
        native_state
            .switching
            .core()
            .complete_unchanged(&restore_ticket, original_binding)?;
        assert_eq!(
            native_state
                .switching
                .core()
                .workspace_participant_count()?,
            0
        );
    }
    Ok(())
}

#[test]
#[ignore = "requires official A3-eligible Q512/R2 shared-material preseed and normal worker binary"]
fn native_worker_returns_canonical_512_a3_eligible_seed_local_graph() -> Result<()> {
    run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(Canonical512FixtureCase {
        label: "Q512",
        entity_count: 70,
        registry_rows: 4,
        a3_rows: 370,
    })
}

#[test]
#[ignore = "requires official Q512/R1/E12/registry33 preseed and normal worker binary"]
fn native_worker_returns_canonical_512_a3_eligible_registry33_seed_local_graph() -> Result<()> {
    run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(Canonical512FixtureCase {
        label: "N512-registry33",
        entity_count: 12,
        registry_rows: 33,
        a3_rows: 486,
    })
}

#[derive(Clone, Copy)]
struct Canonical512FixtureCase {
    label: &'static str,
    entity_count: usize,
    registry_rows: usize,
    a3_rows: usize,
}

fn run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(
    case: Canonical512FixtureCase,
) -> Result<()> {
    use crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome;
    use crate::narrative_extraction::nir1_entity_relation_index::{
        prepare_graph_index_build_with_control,
        publish_nir1_entity_relation_index_in_tx_with_control,
    };
    use crate::narrative_maintenance_connection::{
        with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
    };
    use rusqlite::OpenFlags;
    use std::sync::atomic::AtomicBool;

    const PROJECT: &str = "nir1-capacity-fixture-project";
    const QUERY_SCENE: &str = "nir1-capacity-scope-drift-scene";
    const SEED: &str = "nir1-capacity-shared-entity-2";

    let source = PathBuf::from(
        std::env::var_os("NIR1_Q2_FIXTURE_PATH")
            .ok_or_else(|| anyhow::anyhow!("NIR1_Q2_FIXTURE_PATH missing"))?,
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        ensure!(
            !PathBuf::from(format!("{}{suffix}", source.display())).exists(),
            "Q512 source has a sidecar"
        );
    }
    // Independently establish the exact official seed-local shape and charged
    // QueryUsage rows before handing the disposable copy to the worker.
    let source_db = rusqlite::Connection::open_with_flags(
        &source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let registry_rows: i64 = source_db.query_row(
        "SELECT 1 + COALESCE(json_array_length(timeline_refs_json), 0)
                    + COALESCE(json_array_length(worldline_refs_json), 0)
                    + COALESCE(json_array_length(narrative_layer_refs_json), 0)
           FROM narrative_scope_registries WHERE project_id=?1",
        [PROJECT],
        |row| row.get(0),
    )?;
    assert_eq!(usize::try_from(registry_rows)?, case.registry_rows);
    let candidate_ids = {
        let mut statement = source_db.prepare(
            "SELECT DISTINCT consumer_key FROM narrative_dependency_edges
              WHERE project_id=?1 AND consumer_kind='proposal-revision'
                AND source_object_identity=?2 ORDER BY consumer_key",
        )?;
        let ids = statement
            .query_map(rusqlite::params![PROJECT, format!("codex:{SEED}")], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids
    };
    assert_eq!(candidate_ids.len(), 1);
    let mut material_rows = 0usize;
    let mut a2_rows = 0usize;
    let mut a3_rows = 0usize;
    let mut charged_rows = candidate_ids.len();
    for revision_id in &candidate_ids {
        let (entities, relations, evidence): (i64, i64, i64) = source_db.query_row(
            "SELECT json_array_length(payload_json,'$.bundle.entities'),
                    json_array_length(payload_json,'$.bundle.relations'),
                    (SELECT COALESCE(SUM(json_array_length(
                         json_extract(entity.value,'$.evidence'))),0)
                       FROM json_each(json_extract(payload_json,'$.bundle.entities')) entity)
               FROM narrative_proposal_revisions WHERE id=?1",
            [revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let entities = usize::try_from(entities)?;
        let relations = usize::try_from(relations)?;
        let evidence = usize::try_from(evidence)?;
        assert_eq!(
            (entities, relations, evidence),
            (case.entity_count, 0, case.entity_count)
        );
        material_rows += 2 * entities + relations;

        let a2 = super::input::preflight_revision(
            &source_db,
            PROJECT,
            revision_id,
            MAX_GRAPH_RECORDS - charged_rows,
            MAX_GRAPH_INPUT_BYTES,
        )?
        .ok_or_else(|| anyhow::anyhow!("official {} Revision did not pass A2", case.label))?;
        assert_eq!(a2.rows, entities + relations + evidence);
        a2_rows += a2.rows;
        charged_rows += a2.rows;
        let a3 = super::input::preflight_disclosure_with_payload_bytes(
            &source_db,
            PROJECT,
            revision_id,
            QUERY_SCENE,
            a2.payload_bytes,
            MAX_GRAPH_RECORDS - charged_rows,
            MAX_GRAPH_INPUT_BYTES - a2.bytes,
        )?;
        a3_rows += a3.rows;
        charged_rows += a3.rows;
    }
    assert_eq!(material_rows, 2 * case.entity_count);
    assert_eq!(a2_rows, 2 * case.entity_count);
    assert_eq!(a3_rows, case.a3_rows);
    assert_eq!(charged_rows, MAX_GRAPH_RECORDS - 1);
    assert_eq!(MAX_GRAPH_RECORDS, 512);
    assert_eq!(MAX_GRAPH_INPUT_BYTES, 2_097_152);
    assert_eq!(QUERY_SQL_STEPS, 100_000);
    assert_eq!(QUERY_DEADLINE, Duration::from_millis(8));
    drop(source_db);

    let directory = TestDirectory(std::env::temp_dir().join(format!(
        "nir1-c-{}-{}",
        case.label,
        uuid::Uuid::new_v4()
    )));
    std::fs::create_dir_all(&directory.0)?;
    let path = directory.0.join("grimodex.db");
    std::fs::copy(&source, &path)?;
    let authority = WorkspaceAuthority::from_database_for_test(
        crate::Database::new(&path)?,
        directory.0.clone(),
    )?;

    let mut drained = false;
    for _ in 0..8 {
        match run_incremental_freshness_cycle(&authority)? {
            IncrementalFreshnessCycleOutcome::Processed(_) => {}
            IncrementalFreshnessCycleOutcome::Idle => {
                drained = true;
                break;
            }
            IncrementalFreshnessCycleOutcome::Held(_) => {
                anyhow::bail!("{} Freshness held", case.label)
            }
        }
    }
    ensure!(drained, "{} Freshness Feed did not drain", case.label);
    let revision_id = &candidate_ids[0];
    let disclosure = authority.with_read_transaction(|conn| {
        evaluate_nir1_entity_relation_disclosure(conn, PROJECT, revision_id, QUERY_SCENE)
    })?;
    let Nir1EntityRelationDisclosureRead::Eligible(proof) = disclosure else {
        anyhow::bail!("Q512 Revision {revision_id} is not A3 eligible: {disclosure:?}");
    };
    let decision_id = proof
        .revision
        .decision
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("A3-eligible {} lacks its Human Decision", case.label))?
        .id();

    let runtime = authority.nir_chronicle_index_runtime();
    let snapshot = with_narrative_maintenance_graph_control(
        &authority,
        Duration::ZERO,
        1_000,
        Arc::new(AtomicBool::new(false)),
        NarrativeMaintenanceGraphControlConfig::default(),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let snapshot = prepare_graph_index_build_with_control(&tx, runtime, PROJECT, control)?;
            tx.commit()?;
            Ok(snapshot)
        },
    )?
    .ok_or_else(|| anyhow::anyhow!("Q512 index prepare was deferred"))?
    .into_result()?;
    with_narrative_maintenance_graph_control(
        &authority,
        Duration::ZERO,
        1_000,
        Arc::new(AtomicBool::new(false)),
        NarrativeMaintenanceGraphControlConfig::default(),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            publish_nir1_entity_relation_index_in_tx_with_control(&tx, runtime, snapshot, control)?;
            tx.commit()?;
            Ok(())
        },
    )?
    .ok_or_else(|| anyhow::anyhow!("Q512 index publish was deferred"))?
    .into_result()?;

    let worker_path = PathBuf::from(
        std::env::var_os("NIR1_C_QUERY_WORKER_BIN")
            .ok_or_else(|| anyhow::anyhow!("NIR1_C_QUERY_WORKER_BIN missing"))?,
    );
    let switching = WorkspaceLifecycleCompatibilityView::new(false);
    let native_state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
        safe_mode: crate::recovery::SafeModeState::default(),
        switching,
        open_lock: Mutex::new(()),
    };
    let original_binding = LiveBinding::new(
        authority.path().to_string_lossy(),
        format!("test-workspace:{}", authority.identity()),
        authority.identity(),
        0,
    );
    native_state.switching.core().set_ready(original_binding)?;
    let snapshot = active_workspace_snapshot(&native_state)?;
    let mut owner = super::c_query_worker::CQueryWorkerOwner::new(snapshot, worker_path);
    let post_maintenance = authority.with_read_transaction(|conn| {
        let mut usage = QueryUsage::default();
        usage.admit(0, PROJECT.len() + QUERY_SCENE.len() + SEED.len())?;
        let mut cursor = 0i64;
        let mut candidates = std::collections::BTreeSet::new();
        let mut candidate_rows = 0usize;
        loop {
            usage.admit(0, super::candidates::source_input_bytes(SEED)?)?;
            let page = super::candidates::read_candidate_page(
                conn,
                PROJECT,
                SEED,
                cursor,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
            )?;
            let count = page.len();
            let bytes = page
                .iter()
                .map(|row| row.consumer_kind.len() + row.revision_id.len())
                .sum();
            for row in page {
                cursor = row.cursor;
                if row.consumer_kind == "proposal-revision" {
                    candidates.insert(row.revision_id);
                }
            }
            usage.admit(count, bytes)?;
            usage.pages += 1;
            candidate_rows += count;
            if count < 16 {
                break;
            }
        }
        let mut a2_rows = 0usize;
        let mut a3_rows = 0usize;
        let mut first_refusal = None;
        for revision_id in candidates.iter() {
            let a2 = match super::input::preflight_revision(
                conn,
                PROJECT,
                revision_id,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
            ) {
                Ok(Some(admission)) => admission,
                Ok(None) => {
                    first_refusal = Some(format!("A2 no admission for {revision_id}"));
                    break;
                }
                Err(error) => {
                    first_refusal = Some(format!("A2: {error}"));
                    break;
                }
            };
            if let Err(error) = usage.admit(a2.rows, a2.bytes) {
                first_refusal = Some(format!("A2 QueryUsage::admit: {error}"));
                break;
            }
            a2_rows += a2.rows;
            let a3 = match super::input::preflight_disclosure_with_payload_bytes(
                conn,
                PROJECT,
                revision_id,
                QUERY_SCENE,
                a2.payload_bytes,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
            ) {
                Ok(admission) => admission,
                Err(error) => {
                    first_refusal = Some(format!("A3: {error}"));
                    break;
                }
            };
            if let Err(error) = usage.admit(a3.rows, a3.bytes) {
                first_refusal = Some(format!("A3 QueryUsage::admit: {error}"));
                break;
            }
            a3_rows += a3.rows;
        }
        Ok((
            candidate_rows,
            candidates.len(),
            a2_rows,
            a3_rows,
            usage.rows,
            first_refusal,
        ))
    })?;
    eprintln!(
        "{} post-maintenance preflight: candidate_rows={} canonical_candidates={} A2_rows={} A3_rows={} charged_rows={} first_refusal={:?}",
        case.label,
        post_maintenance.0,
        post_maintenance.1,
        post_maintenance.2,
        post_maintenance.3,
        post_maintenance.4,
        post_maintenance.5
    );
    assert_eq!(
        post_maintenance,
        (2, 1, 2 * case.entity_count, case.a3_rows, 512, None)
    );
    owner.prepare(PROJECT)?;
    let request = Nir1GraphRequest {
        project_id: PROJECT.to_owned(),
        query_scene_id: QUERY_SCENE.to_owned(),
        seed_entity_id: SEED.to_owned(),
    };
    let started = Instant::now();
    let lease = owner.query_once(&request)?;
    let returned_elapsed = started.elapsed();
    let admission_elapsed = lease.elapsed();
    eprintln!(
        "Native canonical charged-row {} worker: call={returned_elapsed:?}, admission={admission_elapsed:?}",
        case.label
    );
    ensure!(
        returned_elapsed <= Duration::from_millis(8)
            && admission_elapsed <= Duration::from_millis(8),
        "Native Q512 worker exceeded the unchanged 8 ms deadline"
    );
    {
        let frame = lease.frame()?;
        assert_eq!(frame.project, PROJECT);
        assert_eq!(frame.scene, QUERY_SCENE);
        assert_eq!(frame.seed, Some(SEED));
        assert!(frame.scope.is_some_and(|scope| !scope.is_empty()));
        assert!(frame.generation.is_some_and(|generation| generation > 0));
        assert_eq!((frame.node_count, frame.edge_count), (1, 0));
        let node = frame
            .first_node
            .ok_or_else(|| anyhow::anyhow!("Q512 worker projection omitted its node"))?;
        assert_eq!(node.hop, 0);
        assert_eq!(node.entity.id, SEED);
        assert_eq!(node.entity.kind, "character");
        assert_eq!(node.entity.label, SEED);
        assert_eq!(
            node.entity.source,
            format!("codex:{SEED}@2026-09-17T00:00:00Z")
        );
        assert!(matches!(
            node.entity.reading,
            super::worker_frame::ScopeView::Exact(value)
                if value == "scene:nir1-capacity-scene"
        ));
        assert_eq!(node.entity.evidence_count, 1);
        let evidence = node
            .entity
            .first_evidence
            .ok_or_else(|| anyhow::anyhow!("Q512 worker projection omitted Evidence"))?;
        assert_eq!(evidence.id, format!("nir1:capacity:evidence:shared:{SEED}"));
        assert_eq!(evidence.source, format!("codex:{SEED}"));
        assert_eq!(evidence.quote, format!("fixture source {SEED} 日本語"));
        assert_eq!(evidence.start, 0);
        assert_eq!(evidence.end as usize, evidence.quote.encode_utf16().count());
        assert_eq!(node.binding_count, 1);
        let binding = node
            .first_binding
            .ok_or_else(|| anyhow::anyhow!("Q512 worker projection omitted its binding"))?;
        assert_eq!(binding.revision_id, revision_id);
        assert_eq!(binding.decision_id, decision_id);
    }
    assert!(
        authority.claim_c_query_child().is_none(),
        "Native capacity must stay leased while the result is held"
    );
    drop(lease);
    let claim = authority
        .claim_c_query_child()
        .ok_or_else(|| anyhow::anyhow!("Q512 lease drop did not release the child claim"))?;
    claim.release();
    drop(owner);
    assert_eq!(
        native_state
            .switching
            .core()
            .workspace_participant_count()?,
        0
    );
    Ok(())
}

fn assert_unavailable(response: &Nir1GraphResponse, reason: &str) {
    assert_eq!(response.status, "unavailable");
    assert_eq!(response.reason.as_deref(), Some(reason));
    assert!(
        response.graph.is_none(),
        "failure must not expose a partial graph"
    );
    assert!(response.scope_revision.is_none());
}

#[test]
fn registered_graph_preserves_multi_edge_order_and_bindings() -> Result<()> {
    let fixture = Fixture::with_extra_relation("directed", true)?;
    let mut reader = fixture.registered_reader()?;
    let response = query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.unwrap();
    assert_eq!(graph.edges.len(), 2);
    assert_eq!(
        graph
            .edges
            .iter()
            .map(|edge| edge.relation.edge_id.as_str())
            .collect::<Vec<_>>(),
        vec!["nir1-edge", "nir1-edge-b"]
    );
    for edge in &graph.edges {
        assert_eq!(edge.binding.revision_id, fixture.revision);
        assert_eq!(edge.from.entity_id, "nir1-alice");
        assert_eq!(edge.to.entity_id, "nir1-bob");
        assert!(!edge.binding.decision_token.is_empty());
        assert!(!edge.binding.freshness_token.is_empty());
    }
    Ok(())
}

#[test]
fn fixed_worker_arena_replaces_only_the_transient_reader_reserve() -> Result<()> {
    let estimate = transient_material_reserve(0, 1)?;
    let retained = MAX_GRAPH_INPUT_BYTES - estimate + 1;

    let mut ordinary = QueryUsage {
        retained_bytes: retained,
        ..QueryUsage::default()
    };
    let error = ordinary
        .admit_transient_material_reserve(0, 1, false)
        .expect_err("ordinary reader must retain its transient estimate");
    assert!(error.to_string().contains("NIR1_GRAPH_RETAINED_LIMIT"));

    let mut worker = QueryUsage {
        retained_bytes: retained,
        ..QueryUsage::default()
    };
    worker.admit_transient_material_reserve(0, 1, true)?;
    assert_eq!(worker.retained_bytes, retained);
    assert!(worker.admit_retained(estimate).is_err());
    Ok(())
}

#[test]
fn ordinary_and_unregistered_readers_cannot_authorize_graph() -> Result<()> {
    let fixture = Fixture::new()?;
    let response = fixture
        .authority
        .with_conn(|conn| read_nir1_graph(conn, &graph_request("nir1-alice")))?;
    assert_unavailable(&response, "registration-required");
    let mut reader = fixture.reader()?;
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "registration-required",
    );
    Ok(())
}

#[test]
fn registered_graph_preserves_exact_revision_decision_and_evidence() -> Result<()> {
    let fixture = Fixture::new()?;
    let proof = fixture.authority.with_read_transaction(|conn| {
        evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &fixture.revision, "nir1")
    })?;
    let Nir1EntityRelationDisclosureRead::Eligible(proof) = proof else {
        anyhow::bail!("canonical test material was not A3 eligible")
    };
    let mut reader = fixture.registered_reader()?;
    let response = query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.unwrap();
    assert_eq!(graph.edges.len(), 1);
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.nodes[0].entity.entity_id, "nir1-alice");
    assert_eq!(graph.nodes[0].hop, 0);
    assert_eq!(graph.nodes[1].hop, 1);
    let edge = &graph.edges[0];
    assert_eq!(edge.binding.revision_id, fixture.revision);
    assert_eq!(
        edge.binding.decision_id,
        proof.revision.decision.as_ref().unwrap().id()
    );
    assert_eq!(edge.binding.decision_token, proof.decision_token);
    assert_eq!(edge.binding.freshness_token, proof.freshness_token);
    assert_eq!(
        edge.binding.scope_authority_revision,
        proof.scope_authority_revision
    );
    assert_eq!(
        edge.binding.query_scene_source_token,
        proof.query_scene_source_token
    );
    assert_eq!(
        edge.binding.query_scene_scope_token,
        proof.query_scene_scope_token
    );
    assert_eq!(
        edge.binding.query_scene_incarnation_id,
        proof.query_scene_incarnation_id
    );
    assert_eq!(edge.binding.reveal_state_token, proof.reveal_state_token);
    assert_eq!(
        serde_json::to_value(&edge.relation)?,
        serde_json::to_value(&proof.revision.bundle.relations[0])?
    );
    assert_eq!(edge.from.evidence[0].evidence_id, "nir1-evidence-alice");
    assert_eq!(edge.from.evidence[0].quote, "Alice");
    assert_eq!(edge.to.evidence[0].evidence_id, "nir1-evidence-bob");
    assert_eq!(edge.to.evidence[0].quote, "Bob");
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn reverse_traversal_obeys_directed_and_symmetric_relations() -> Result<()> {
    for (direction, expected_edges) in [("directed", 0), ("symmetric", 1)] {
        let fixture = Fixture::with_direction(direction)?;
        let mut reader = fixture.registered_reader()?;
        let response = query(&mut reader, "nir1-bob")?;
        assert_eq!(response.status, "available", "{:?}", response.reason);
        let graph = response.graph.unwrap();
        assert_eq!(graph.edges.len(), expected_edges, "{direction}");
        assert_eq!(graph.nodes[0].entity.entity_id, "nir1-bob");
        assert_eq!(graph.nodes[0].hop, 0);
    }
    Ok(())
}

#[test]
fn committed_external_write_invalidates_registration_without_partial_output() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    let external = Connection::open(fixture.authority.path().join("grimodex.db"))?;
    external.execute(
        "UPDATE codex_entries SET summary='changed' WHERE id='nir1-alice'",
        [],
    )?;
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-drift");
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-required");
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn dirty_binding_invalidates_registration_and_cannot_be_registered_again() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    fixture.authority.with_conn(|conn| {
        conn.execute("UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1 WHERE project_id=?1 AND index_key=?2", params![PROJECT, INDEX_KEY])?;
        Ok(())
    })?;
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-drift");
    assert!(!reader.register_with_control(PROJECT, &mut RegistrationOwner)?);
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-required");
    Ok(())
}

#[test]
fn missing_source_or_decision_cannot_reuse_published_binding() -> Result<()> {
    for mutation in [
        "DELETE FROM codex_entries WHERE id='nir1-alice'",
        "DELETE FROM narrative_proposal_decisions",
    ] {
        let fixture = Fixture::new()?;
        let mut reader = fixture.registered_reader()?;
        fixture.authority.with_conn(|conn| {
            conn.execute(mutation, [])?;
            Ok(())
        })?;
        assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-drift");
        assert!(
            !reader.register_with_control(PROJECT, &mut RegistrationOwner)?,
            "{mutation}"
        );
        assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-required");
    }
    Ok(())
}

#[test]
fn unrelated_reverse_dependencies_do_not_consume_seed_local_budget() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.add_decoys(513, "codex:unrelated-entity")?;
    let mut reader = fixture.registered_reader()?;
    let response = query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert_eq!(response.graph.unwrap().edges.len(), 1);
    Ok(())
}

#[test]
fn oversized_seed_candidate_set_is_refused_without_partial_graph() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.add_decoys(513, "codex:nir1-alice")?;
    let mut reader = fixture.registered_reader()?;
    assert_unavailable(
        &query(&mut reader, "nir1-alice")?,
        "query-budget-or-validation-failed",
    );
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "query-budget-or-validation-failed",
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn exhausted_deadline_or_sql_budget_rolls_back_actual_connection() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    for (duration, steps) in [(Duration::ZERO, 100_000), (Duration::from_secs(2), 0)] {
        let response = reader.query_with_deadline(&graph_request("nir1-alice"), duration, steps)?;
        assert_unavailable(&response, "query-budget-or-validation-failed");
        assert!(reader.connection.as_ref().unwrap().is_autocommit());
    }
    // Exhaustion must not strand an open read transaction or poison the owner.
    assert_eq!(query(&mut reader, "nir1-alice")?.status, "available");
    Ok(())
}

#[test]
fn worker_refusal_reason_is_allowlisted_by_site_cause_and_pre_cleanup_status() {
    let deadline = validation_terminated(ValidationTerminationReason::TimedOut, "private detail");
    assert_eq!(
        worker_refusal_reason(WorkerRefusalSite::Work, &deadline, false, false, None),
        "query-worker-work-deadline"
    );

    let capacity = validation_terminated(
        ValidationTerminationReason::CapacityExceeded,
        "private detail",
    );
    assert_eq!(
        worker_refusal_reason(WorkerRefusalSite::PostStamp, &capacity, false, true, None),
        "query-worker-post-stamp-steps"
    );
    assert_eq!(
        worker_refusal_reason(WorkerRefusalSite::Work, &capacity, true, true, None),
        "query-worker-work-deadline-or-steps"
    );

    let known = validation_terminated(
        ValidationTerminationReason::WorkspaceGenerationChanged,
        "private detail",
    );
    assert_eq!(
        worker_refusal_reason(WorkerRefusalSite::PostStamp, &known, false, false, None),
        "query-worker-post-stamp-validation-workspace-generation-changed"
    );
    let sqlite_nomem: anyhow::Error = rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOMEM),
        None,
    )
    .into();
    assert_eq!(
        worker_refusal_reason(WorkerRefusalSite::Work, &sqlite_nomem, false, false, None),
        "query-worker-work-sqlite-nomem"
    );
    let record_limit = anyhow::anyhow!("NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT");
    assert_eq!(
        worker_refusal_reason(WorkerRefusalSite::Work, &record_limit, false, false, None),
        "query-worker-work-disclosure-record-limit"
    );
    let record_status = worker_work_status(&Err::<(), _>(record_limit), false, false);
    assert_eq!(
        worker_refusal_reason(
            WorkerRefusalSite::Work,
            &anyhow::anyhow!("NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT"),
            false,
            false,
            Some(record_status),
        ),
        "query-worker-work-disclosure-record-limit-pre-cleanup-work-failed-disclosure-record-limit"
    );
    let other = anyhow::anyhow!("private detail");
    assert_eq!(
        worker_refusal_reason(WorkerRefusalSite::Work, &other, false, false, None),
        "query-worker-work-other"
    );
    let generic_unavailable = unavailable_response(&graph_request("seed"), "reader-unavailable");
    assert_eq!(generic_unavailable.status, "unavailable");
    assert_eq!(
        generic_unavailable.reason.as_deref(),
        Some("reader-unavailable")
    );

    let success = Ok::<(), anyhow::Error>(());
    let work_ok = worker_work_status(&success, false, false);
    assert_eq!(
        worker_refusal_reason(
            WorkerRefusalSite::PostStamp,
            &deadline,
            true,
            false,
            Some(work_ok),
        ),
        "query-worker-post-stamp-deadline-pre-cleanup-work-ok"
    );

    let failure = Err::<(), _>(validation_terminated(
        ValidationTerminationReason::CapacityExceeded,
        "private detail",
    ));
    let work_failed = worker_work_status(&failure, false, true);
    assert_eq!(
        worker_refusal_reason(
            WorkerRefusalSite::PostStamp,
            &deadline,
            true,
            false,
            Some(work_failed),
        ),
        "query-worker-post-stamp-deadline-pre-cleanup-work-failed-steps"
    );

    let late_work = worker_work_status(&success, true, false);
    assert_eq!(
        worker_refusal_reason(
            WorkerRefusalSite::PostStamp,
            &deadline,
            true,
            false,
            Some(late_work),
        ),
        "query-worker-post-stamp-deadline-pre-cleanup-deadline-already-crossed"
    );
}

#[cfg(feature = "nir1-material-diagnostics")]
#[test]
fn diagnostic_stage_observation_reports_deadline_and_stamp_flags_only() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    let (result, observation) = reader.query_with_stage_observation_and_deadline(
        &graph_request("nir1-alice"),
        Duration::ZERO,
        100_000,
    );
    assert_unavailable(&result?, "query-budget-or-validation-failed");
    assert!(observation.work_result_error);
    assert!(observation.post_stamp_error);
    assert!(observation.deadline_observed_at_collapse);
    assert!(observation.unattributed);
    assert!(observation.cleanup_post_stamp_ns.is_some());
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn runtime_pause_resume_never_revives_an_old_reader() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    fixture.authority.nir_chronicle_index_runtime().pause()?;
    fixture.authority.nir_chronicle_index_runtime().resume()?;
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "reader-unavailable",
    );
    assert!(reader
        .register_with_control(PROJECT, &mut RegistrationOwner)
        .is_err());
    Ok(())
}

#[test]
fn cancellation_is_sticky_and_close_releases_physical_connection_and_participant() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 1);
    reader.cancellation().cancel();
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "reader-unavailable",
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 1);
    reader.close()?;
    assert!(reader.connection.is_none());
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 0);
    reader.close()?;
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "reader-unavailable",
    );
    Ok(())
}
