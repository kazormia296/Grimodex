mod convert;
mod db;
mod sanitize;
mod server;
mod tools;

use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "grimodex-mcp", about = "Grimodex MCP server")]
struct Cli {
    #[arg(short, long, help = "Path to the Grimodex workspace directory")]
    workspace: PathBuf,
    #[arg(short, long, help = "Project ID (defaults to first project in DB)")]
    project: Option<String>,
    #[arg(long, help = "Read-only mode (disables write tools)")]
    readonly: bool,
    #[arg(long, help = "Enable verbose logging")]
    verbose: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    // Logging: stderr (stdout is the MCP transport) plus a daily-rotated
    // file under `~/.grimodex/logs/lint-mcp-*.log`. The Linter design
    // doc requires Tauri and MCP to write to *separate* files because
    // they run in different processes and would clash on a shared one.
    let level = if cli.verbose { "debug" } else { "info" };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(level));

    // Keep the guard alive for the process lifetime. Dropping it flushes
    // pending lines synchronously; assigning to `_` would discard logs.
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

    // Resolve project_id
    let project_id = match cli.project {
        Some(id) => id,
        None => db::get_first_project_id(&conn)?,
    };

    tracing::info!(
        project_id = %project_id,
        workspace = %cli.workspace.display(),
        readonly = cli.readonly,
        "Starting Grimodex MCP server"
    );

    // Build and run server
    let handler = server::GrimodexServer::new(conn, project_id, cli.readonly);
    let (stdin, stdout) = rmcp::transport::io::stdio();
    let service = rmcp::serve_server(handler, (stdin, stdout)).await?;
    service.waiting().await?;

    Ok(())
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
