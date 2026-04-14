mod content;
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

    // Initialize logging (stderr only, stdout is the MCP transport)
    let level = if cli.verbose { "debug" } else { "info" };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(level)),
        )
        .with_writer(std::io::stderr)
        .init();

    // Validate workspace
    let db_path = cli.workspace.join("grimodex.db");
    if !db_path.exists() {
        anyhow::bail!(
            "grimodex.db not found in workspace: {}",
            cli.workspace.display()
        );
    }
    let content_dir = cli.workspace.join("content");

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
    let handler = server::GrimodexServer::new(conn, content_dir, project_id, cli.readonly);
    let (stdin, stdout) = rmcp::transport::io::stdio();
    let service = rmcp::serve_server(handler, (stdin, stdout)).await?;
    service.waiting().await?;

    Ok(())
}
