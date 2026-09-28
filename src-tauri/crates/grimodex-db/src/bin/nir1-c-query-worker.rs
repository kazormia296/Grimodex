//! Normal-build, one-query, direct-spawn Graph worker. Never a renderer API.
#[path = "support/c_query_fixed_allocator.rs"]
mod c_query_fixed_allocator;

use anyhow::{ensure, Result};
use c_query_fixed_allocator::WorkerAllocator;
use grimodex_db::narrative_extraction::nir1_graph::{
    c_query_worker::REQUEST_BYTES, worker_frame, Nir1GraphReader, Nir1GraphRequest,
};
use grimodex_db::{
    state::WorkspaceAuthority, workspace_lease::try_acquire_shared,
    workspace_lifecycle::WorkspaceLifecycleCore, Database,
};
use rusqlite::{Connection, OpenFlags};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::Arc,
};

#[global_allocator]
static WORKER_ALLOCATOR: WorkerAllocator = WorkerAllocator::new();

fn main() -> std::process::ExitCode {
    // Do not print private DB material or panic payloads into the pipe.
    std::panic::set_hook(Box::new(|_| {}));
    let result = run();
    if result.is_ok() {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

fn run() -> Result<()> {
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
    let mut reader = Nir1GraphReader::open(authority, participant)?;
    let registered = reader.register_with_worker_maintenance(&project)?;
    ensure!(registered, "worker canonical registration failed");
    // No query allocation may enter the baseline region after this point.
    ensure!(
        WORKER_ALLOCATOR.activate(),
        "query region already activated"
    );
    let mut output = std::io::stdout().lock();
    output.write_all(b"R")?;
    output.flush()?;
    let mut input = std::io::stdin().lock();
    let mut header = [0u8; 2];
    input.read_exact(&mut header)?;
    let size = u16::from_le_bytes(header) as usize;
    ensure!(size <= REQUEST_BYTES && size >= 6, "worker request length");
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
    let response = reader.query_for_worker(&request)?;
    let bytes = worker_frame::encode(&response)?;
    output.write_all(&u32::try_from(bytes.len())?.to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()?;
    // The one-query read-only process has no work after its frame. Let process
    // termination close SQLite and stdout; Native still requires EOF and exit.
    std::process::exit(0);
}
