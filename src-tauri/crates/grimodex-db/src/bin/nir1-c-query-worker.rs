//! Normal-build, one-query, direct-spawn Graph worker. Never a renderer API.
#[path = "support/c_query_fixed_allocator.rs"]
mod c_query_fixed_allocator;

use anyhow::{ensure, Result};
use c_query_fixed_allocator::WorkerAllocator;
use grimodex_db::narrative_extraction::nir1_graph::{
    c_query_worker::REQUEST_BYTES, worker_frame, Nir1GraphReader, Nir1GraphRegistrationStage,
    Nir1GraphRequest,
};
use grimodex_db::{
    state::WorkspaceAuthority, workspace_lease::try_acquire_shared,
    workspace_lifecycle::WorkspaceLifecycleCore, Database,
};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs::File,
    io::{LineWriter, Read, Write},
    path::PathBuf,
    sync::Arc,
};

#[global_allocator]
static WORKER_ALLOCATOR: WorkerAllocator = WorkerAllocator::new();

#[derive(Clone, Copy)]
enum StartupStage {
    BeforeSqliteInit,
    ReaderOpen,
    CanonicalRegistration,
    CanonicalRegistrationSqliteNoMem(Nir1GraphRegistrationStage),
    CanonicalRegistrationSqliteError,
    CanonicalRegistrationRefused,
    ScratchSeal,
    Ready,
}

impl StartupStage {
    fn diagnostic(self) -> Option<&'static [u8]> {
        match self {
            Self::BeforeSqliteInit => Some(b"NIR1_C_QUERY_STARTUP_SQLITE_CONFIG\n"),
            Self::ReaderOpen => Some(b"NIR1_C_QUERY_STARTUP_READER_OPEN\n"),
            Self::CanonicalRegistration => Some(b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION\n"),
            Self::CanonicalRegistrationSqliteNoMem(stage) => match stage {
                Nir1GraphRegistrationStage::Maintenance => {
                    Some(b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_SQLITE_NOMEM\n")
                }
                Nir1GraphRegistrationStage::Setup => Some(b"NIR1_C_QUERY_REG_NOMEM:SETUP\n"),
                Nir1GraphRegistrationStage::PreflightIdentity => {
                    Some(b"NIR1_C_QUERY_REG_NOMEM:PRE_IDENTITY\n")
                }
                Nir1GraphRegistrationStage::OwnerSetup => {
                    Some(b"NIR1_C_QUERY_REG_NOMEM:OWNER_SETUP\n")
                }
                Nir1GraphRegistrationStage::BeginSnapshot => {
                    Some(b"NIR1_C_QUERY_REG_NOMEM:BEGIN\n")
                }
                Nir1GraphRegistrationStage::PinnedIdentity => {
                    Some(b"NIR1_C_QUERY_REG_NOMEM:PINNED_IDENTITY\n")
                }
                Nir1GraphRegistrationStage::SemanticIndex => {
                    Some(b"NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX\n")
                }
                Nir1GraphRegistrationStage::SourceIndex => {
                    Some(b"NIR1_C_QUERY_REG_NOMEM:SOURCE_INDEX\n")
                }
                Nir1GraphRegistrationStage::Seal => Some(b"NIR1_C_QUERY_REG_NOMEM:SEAL\n"),
                Nir1GraphRegistrationStage::PostflightIdentity => {
                    Some(b"NIR1_C_QUERY_REG_NOMEM:POST_IDENTITY\n")
                }
            },
            Self::CanonicalRegistrationSqliteError => {
                Some(b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_SQLITE_ERROR\n")
            }
            Self::CanonicalRegistrationRefused => {
                Some(b"NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED\n")
            }
            Self::ScratchSeal => Some(b"NIR1_C_QUERY_STARTUP_SCRATCH_NOT_EMPTY\n"),
            Self::Ready => None,
        }
    }
}

fn registration_error_stage(
    error: &anyhow::Error,
    registration_stage: Nir1GraphRegistrationStage,
) -> StartupStage {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .is_some_and(|error| matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::OutOfMemory))
    }) {
        return StartupStage::CanonicalRegistrationSqliteNoMem(registration_stage);
    }
    if error
        .chain()
        .any(|cause| cause.downcast_ref::<rusqlite::Error>().is_some())
    {
        return StartupStage::CanonicalRegistrationSqliteError;
    }
    StartupStage::CanonicalRegistration
}

fn take_protocol_output() -> Result<LineWriter<File>> {
    #[cfg(unix)]
    let file = {
        use std::os::fd::FromRawFd;
        // SAFETY: this worker transfers its inherited stdout fd to this sole
        // writer and never uses the global stdout handle for protocol output.
        unsafe { File::from_raw_fd(libc::STDOUT_FILENO) }
    };
    #[cfg(windows)]
    let file = {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        let handle = std::io::stdout().as_raw_handle();
        ensure!(
            !handle.is_null() && handle as isize != -1,
            "worker stdout handle unavailable"
        );
        // SAFETY: this worker transfers its inherited stdout handle to this
        // sole writer and never uses the global stdout handle for protocol output.
        unsafe { File::from_raw_handle(handle) }
    };
    Ok(LineWriter::new(file))
}

fn close_protocol_output(output: LineWriter<File>) {
    drop(output);
}

fn main() -> std::process::ExitCode {
    // Do not print private DB material or panic payloads into the pipe.
    std::panic::set_hook(Box::new(|_| {}));
    #[cfg(feature = "nir1-c-query-test-seam")]
    WORKER_ALLOCATOR.enable_sqlite_failure_receipt(
        std::env::var_os("NIR1_C_QUERY_TEST_SQLITE_ALLOC_RECEIPT")
            .is_some_and(|value| value.to_str() == Some("first")),
    );
    let stderr = std::io::stderr();
    let mut stderr = stderr.lock();
    let mut startup_stage = StartupStage::BeforeSqliteInit;
    match run(&mut startup_stage) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            if let Some(diagnostic) = startup_stage.diagnostic() {
                let _ = stderr.write_all(diagnostic);
            }
            #[cfg(feature = "nir1-c-query-test-seam")]
            if matches!(
                startup_stage,
                StartupStage::CanonicalRegistrationSqliteNoMem(_)
            ) {
                if let Some(receipt) = WORKER_ALLOCATOR.sqlite_failure_receipt() {
                    let kind = match receipt.kind {
                        c_query_fixed_allocator::SqliteAllocationKind::XMalloc => "xMalloc",
                        c_query_fixed_allocator::SqliteAllocationKind::XRealloc => "xRealloc",
                    };
                    let _ = writeln!(
                        stderr,
                        "NIR1_C_QUERY_SQLITE_ALLOC_FAILURE:v1;kind={kind};requested={};old={};claimed={};available={}",
                        receipt.requested,
                        receipt.old_capacity,
                        receipt.claimed,
                        receipt.available,
                    );
                }
            }
            let _ = stderr.flush();
            std::process::ExitCode::FAILURE
        }
    }
}

fn run(startup_stage: &mut StartupStage) -> Result<()> {
    ensure!(
        c_query_fixed_allocator::install_sqlite(),
        "worker SQLite allocator must precede init"
    );
    let mut args = std::env::args_os().skip(1);
    let root = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("workspace missing"))?,
    );
    let project = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("project missing"))?
        .into_string()
        .map_err(|_| anyhow::anyhow!("project invalid"))?;
    ensure!(args.next().is_none(), "unexpected worker argument");
    let path = root.join("grimodex.db");
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::ZERO)?;
    conn.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
        CREATE TEMP TABLE grimodex_connection_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL);")?;
    conn.execute(
        "INSERT INTO temp.grimodex_connection_meta VALUES(1,?1)",
        [uuid::Uuid::new_v4().to_string()],
    )?;
    conn.execute_batch("PRAGMA query_only=ON")?;
    let authority = Arc::new(WorkspaceAuthority::new(
        Database::from_connection(conn),
        root.clone(),
        try_acquire_shared(&root)?,
    ));
    let participant = WorkspaceLifecycleCore::new().begin_workspace_participant()?;
    *startup_stage = StartupStage::ReaderOpen;
    let mut reader = Nir1GraphReader::open_for_worker(Arc::clone(&authority), participant)?;
    *startup_stage = StartupStage::CanonicalRegistration;
    let mut registration_stage = Nir1GraphRegistrationStage::Maintenance;
    let mut scratch_seal_result = None;
    let registered = match reader.register_with_worker_maintenance_diagnostic(
        &project,
        &mut registration_stage,
        |operation: &mut dyn FnMut()| WORKER_ALLOCATOR.with_scratch_scope(operation).is_ok(),
        || {
            *startup_stage = StartupStage::ScratchSeal;
            let sealed = WORKER_ALLOCATOR.seal_scratch();
            scratch_seal_result = Some(sealed);
            sealed
        },
    ) {
        Ok(registered) => registered,
        Err(error) => {
            *startup_stage = match scratch_seal_result {
                Some(false) => StartupStage::ScratchSeal,
                Some(true) => StartupStage::CanonicalRegistration,
                None => registration_error_stage(&error, registration_stage),
            };
            return Err(error);
        }
    };
    if !registered {
        *startup_stage = StartupStage::CanonicalRegistrationRefused;
        anyhow::bail!("worker canonical registration failed");
    }
    // Registration promotes its Q-owned pending proof only after this actual
    // zero-live seal has closed S and the final reader lifecycle check succeeds.
    *startup_stage = StartupStage::Ready;
    let mut output = take_protocol_output()?;
    output.write_all(b"R")?;
    output.flush()?;
    let mut input = std::io::stdin().lock();
    let mut header = [0u8; 2];
    input.read_exact(&mut header)?;
    let size = u16::from_le_bytes(header) as usize;
    ensure!((6..=REQUEST_BYTES).contains(&size), "worker request length");
    let mut request_bytes = vec![0; size];
    input.read_exact(&mut request_bytes)?;
    let mut fields = request_bytes.as_slice();
    let mut text = || -> Result<String> {
        ensure!(fields.len() >= 2, "worker request truncated");
        let n = u16::from_le_bytes([fields[0], fields[1]]) as usize;
        fields = &fields[2..];
        ensure!(n > 0 && n <= fields.len(), "worker request string length");
        let s = std::str::from_utf8(&fields[..n])?.to_owned();
        fields = &fields[n..];
        Ok(s)
    };
    let request = Nir1GraphRequest {
        project_id: text()?,
        query_scene_id: text()?,
        seed_entity_id: text()?,
    };
    ensure!(
        fields.is_empty() && request.project_id == project,
        "worker request binding"
    );
    drop(input);
    #[cfg(feature = "nir1-c-query-test-seam")]
    if std::env::var_os("NIR1_C_QUERY_TEST_RUST_OOM")
        .is_some_and(|value| value.to_str() == Some("query"))
    {
        let layout = std::alloc::Layout::array::<u8>(c_query_fixed_allocator::QUERY_BYTES + 1)
            .expect("fixed OOM test layout");
        let allocation = unsafe { std::alloc::GlobalAlloc::alloc(&WORKER_ALLOCATOR, layout) };
        if allocation.is_null() {
            std::alloc::handle_alloc_error(layout);
        }
        unsafe { std::alloc::GlobalAlloc::dealloc(&WORKER_ALLOCATOR, allocation, layout) };
        std::process::exit(24);
    }
    #[cfg(feature = "nir1-c-query-test-seam")]
    if std::env::var_os("NIR1_C_QUERY_TEST_SQLITE_NOMEM")
        .is_some_and(|value| value.to_str() == Some("query"))
    {
        let string = unsafe { rusqlite::ffi::sqlite3_str_new(std::ptr::null_mut()) };
        if string.is_null() {
            std::process::exit(27);
        }
        let initially_healthy =
            unsafe { rusqlite::ffi::sqlite3_str_errcode(string) == rusqlite::ffi::SQLITE_OK };
        if !initially_healthy {
            unsafe { rusqlite::ffi::sqlite3_str_free(string) };
            std::process::exit(27);
        }
        let sqlite_code = unsafe {
            rusqlite::ffi::sqlite3_str_appendchar(
                string,
                (c_query_fixed_allocator::QUERY_BYTES + 1) as std::ffi::c_int,
                b'x' as std::ffi::c_char,
            );
            let code = rusqlite::ffi::sqlite3_str_errcode(string);
            rusqlite::ffi::sqlite3_str_free(string);
            code
        };
        // Exit 26 is proof that SQLite reported NOMEM; all other outcomes fail.
        std::process::exit(if sqlite_code == rusqlite::ffi::SQLITE_NOMEM {
            26
        } else {
            27
        });
    }
    let response = reader.query_for_worker_with_maintenance(&request)?;
    #[cfg(feature = "nir1-c-query-test-seam")]
    let partial_frame = std::env::var_os("NIR1_C_QUERY_TEST_PARTIAL_FRAME")
        .is_some_and(|value| value.to_str() == Some("partial"));
    #[cfg(feature = "nir1-c-query-test-seam")]
    if partial_frame {
        ensure!(
            response.status == "available"
                && response
                    .graph
                    .as_ref()
                    .is_some_and(|graph| graph.nodes.len() == 1 && graph.edges.is_empty()),
            "partial frame test requires the real nonempty Q2 response"
        );
    }
    let bytes = worker_frame::encode(&response)?;
    output.write_all(&u32::try_from(bytes.len())?.to_le_bytes())?;
    #[cfg(feature = "nir1-c-query-test-seam")]
    if partial_frame {
        let prefix_len = bytes.len() / 2;
        ensure!(
            prefix_len > 0 && prefix_len < bytes.len(),
            "partial frame test prefix"
        );
        output.write_all(&bytes[..prefix_len])?;
        output.flush()?;
        std::process::exit(23);
    }
    output.write_all(&bytes)?;
    output.flush()?;
    // Query, frame encoding, writes, and their flush all succeeded. After the
    // complete marker is received, exit/flush anomalies affect retirement only.
    #[cfg(feature = "nir1-c-query-test-seam")]
    if std::env::var_os("NIR1_C_QUERY_TEST_PARTIAL_COMMIT")
        .is_some_and(|value| value.to_str() == Some("partial"))
    {
        output.write_all(&worker_frame::TERMINAL_SUCCESS_COMMIT[..2])?;
        output.flush()?;
        std::process::exit(23);
    }
    output.write_all(worker_frame::TERMINAL_SUCCESS_COMMIT)?;
    output.flush()?;
    #[cfg(feature = "nir1-c-query-test-seam")]
    if std::env::var_os("NIR1_C_QUERY_TEST_TRAILING_DATA")
        .is_some_and(|value| value.to_str() == Some("trailing"))
    {
        output.write_all(&[0xA5])?;
        output.flush()?;
        close_protocol_output(output);
        std::process::exit(23);
    }
    #[cfg(all(feature = "nir1-c-query-test-seam", target_os = "linux"))]
    if std::env::var_os("NIR1_C_QUERY_TEST_HOLD_STDOUT_OPEN_AFTER_COMMIT")
        .is_some_and(|value| value.to_str() == Some("held"))
    {
        // Keep the real stdout handle open so Native sees COMMIT but cannot
        // observe EOF until its bounded retirement kills this child.
        loop {
            std::thread::park_timeout(std::time::Duration::from_secs(30));
        }
    }
    #[cfg(all(feature = "nir1-c-query-test-seam", target_os = "linux"))]
    if std::env::var_os("NIR1_C_QUERY_TEST_HOLD_AFTER_COMMIT")
        .is_some_and(|value| value.to_str() == Some("held"))
    {
        close_protocol_output(output);
        loop {
            std::thread::park_timeout(std::time::Duration::from_secs(30));
        }
    }
    close_protocol_output(output);
    #[cfg(feature = "nir1-c-query-test-seam")]
    std::process::exit(23);
    #[cfg(not(feature = "nir1-c-query-test-seam"))]
    std::process::exit(0);
}
