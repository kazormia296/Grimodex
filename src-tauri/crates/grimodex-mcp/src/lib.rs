mod convert;
mod db;
mod sanitize;
mod server;
mod tools;

// Re-export the `Parser` trait so the main app's `mcp` subcommand branch can
// call `grimodex_mcp::Cli::parse_from(...)` without taking a direct clap dep.
pub use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "grimodex-mcp", about = "Grimodex MCP server")]
pub struct Cli {
    #[arg(short, long, help = "Path to the Grimodex workspace directory")]
    pub workspace: PathBuf,
    #[arg(short, long, help = "Project ID (defaults to first project in DB)")]
    pub project: Option<String>,
    #[arg(long, help = "Read-only mode (disables write tools)")]
    pub readonly: bool,
    #[arg(
        long,
        help = "Allow switching between all projects in the workspace via select_project (local/trusted clients only; widens scope to the whole DB)"
    )]
    pub all_projects: bool,
    #[arg(long, help = "Enable verbose logging")]
    pub verbose: bool,
}

/// Run the stdio MCP server to completion.
///
/// Async entry point. The caller (either the standalone `[[bin]]` shim or the
/// main app's `mcp` subcommand branch) supplies the parsed [`Cli`]. The
/// `tracing-appender` worker guard is created and kept alive **inside this
/// function's scope** on purpose: callers that `std::process::exit` after this
/// returns would skip the guard's `Drop` (and thus skip the final log flush)
/// if it lived in their frame instead.
pub async fn run(cli: Cli) -> anyhow::Result<()> {
    // Logging: stderr (stdout is the MCP transport) plus a daily-rotated
    // file under `~/.grimodex/logs/lint-mcp-*.log`. The Linter design
    // doc requires Tauri and MCP to write to *separate* files because
    // they run in different processes and would clash on a shared one.
    let level = if cli.verbose { "debug" } else { "info" };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(level));

    // Keep the guard alive for this function's lifetime. Dropping it flushes
    // pending lines synchronously; binding to `_` would discard logs.
    let _log_guard = init_mcp_logging(env_filter);

    // Validate workspace
    let db_path = cli.workspace.join("grimodex.db");
    if !db_path.exists() {
        anyhow::bail!(
            "grimodex.db not found in workspace: {}",
            cli.workspace.display()
        );
    }
    // Open DB
    let conn = db::open_db(&db_path)?;

    // Schema skew guard: mismatch → read-only降格
    let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let mut readonly = cli.readonly;
    if user_version != grimodex_core::SCHEMA_VERSION {
        tracing::warn!(
            user_version,
            expected = grimodex_core::SCHEMA_VERSION,
            "Schema version mismatch; forcing readonly mode"
        );
        readonly = true;
    }

    // Resolve the initial project. In --all-projects mode this is just the
    // starting "current" project (the agent can switch via select_project);
    // --project is honored as the initial selection when given.
    let project_id = match cli.project {
        Some(id) => id,
        None => db::get_first_project_id(&conn)?,
    };

    let policy = grimodex_core::policy::load_policy(&conn, &project_id)?;
    let session_id = uuid::Uuid::new_v4().to_string();

    tracing::info!(
        project_id = %project_id,
        workspace = %cli.workspace.display(),
        readonly,
        all_projects = cli.all_projects,
        session_id = %session_id,
        knowledge_write = policy.knowledge_write,
        "Starting Grimodex MCP server"
    );

    // Build and run server
    let handler = server::GrimodexServer::new(
        conn,
        project_id,
        cli.all_projects,
        readonly,
        session_id,
        policy,
    );
    let (stdin, stdout) = rmcp::transport::io::stdio();
    let service = rmcp::serve_server(handler, (stdin, stdout)).await?;
    service.waiting().await?;

    Ok(())
}

/// Synchronous wrapper for callers without an async runtime: the standalone
/// `[[bin]]` shim and the main app's `mcp` subcommand branch (which runs
/// before any Tauri/tokio init). Replaces the old `#[tokio::main]`: rmcp's
/// stdio transport needs the I/O driver and a multi-thread runtime, so we
/// build `new_multi_thread().enable_all()` explicitly.
pub fn run_blocking(cli: Cli) -> anyhow::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run(cli))
}

/// Daily-rotating file log under `~/.grimodex/logs/lint-mcp-*.log` plus
/// stderr. Returns `Some(WorkerGuard)` only when the file sink is wired
/// up — caller must keep it alive (drop = flush).
#[must_use = "drop the guard at process exit; binding to `_` discards file logs"]
fn init_mcp_logging(
    env_filter: tracing_subscriber::EnvFilter,
) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, registry};

    let dir = dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".grimodex")
        .join("logs");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        // Stderr-only fallback so the server still starts under read-only
        // home dirs (CI sandboxes, hardened containers).
        let _ = tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .with_writer(std::io::stderr)
            .try_init();
        eprintln!("grimodex-mcp: log dir setup failed ({e}); file logging disabled");
        return None;
    }

    let appender = tracing_appender::rolling::daily(&dir, "lint-mcp.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let stderr_layer = fmt::layer().with_writer(std::io::stderr).compact();
    let file_layer = fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true);

    let _ = registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init();

    Some(guard)
}
