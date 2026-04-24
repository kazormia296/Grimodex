//! Tracing initialisation for the Linter (and the Tauri host overall).
//!
//! Per `docs/Grimodex_Linter設計書.md` §「テレメトリー / デバッグログ」:
//!
//! - Logs go to `~/.grimodex/logs/` with daily rotation.
//! - Tauri and the standalone MCP server are separate processes and would
//!   collide on a shared log file, so the file name differs per process
//!   (`lint-tauri-*.log` here, `lint-mcp-*.log` in `grimodex-mcp`).
//! - Defaults to `warn` for everything plus `info` for our own crates so
//!   `LintError` / `RuleWarning` are captured without flooding the log.
//! - Stderr remains the secondary sink so devs running `cargo tauri dev`
//!   still see live output.

use std::path::PathBuf;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

/// Where lint-related log files live. Falls back to the system temp dir
/// if `dirs::home_dir()` fails (sandboxed environments, CI).
pub fn log_dir() -> PathBuf {
    let base = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    base.join(".grimodex").join("logs")
}

/// Initialise the tracing subscriber for the Tauri host.
///
/// Returns a `WorkerGuard` that the caller MUST keep alive for the
/// process lifetime — dropping it flushes pending log entries
/// synchronously, so binding it to `_` would silently disable file
/// output.
#[must_use = "drop the guard at process exit; binding to `_` discards file logs"]
pub fn init_tauri_logging() -> Option<WorkerGuard> {
    let dir = log_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        // Fall back to stderr-only if we can't create the log dir
        // (e.g. read-only home). Better than panicking on startup.
        let _ = tracing_subscriber::fmt()
            .with_env_filter(default_filter())
            .try_init();
        eprintln!("grimodex: log dir setup failed ({e}); file logging disabled");
        return None;
    }

    let appender = tracing_appender::rolling::daily(&dir, "lint-tauri.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    // Stderr is intentionally `compact` so dev runs stay readable;
    // the file layer keeps full precision for postmortems.
    let stderr_layer = fmt::layer().with_writer(std::io::stderr).compact();
    let file_layer = fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true);

    let _ = tracing_subscriber::registry()
        .with(default_filter())
        .with(stderr_layer)
        .with(file_layer)
        .try_init();

    Some(guard)
}

fn default_filter() -> EnvFilter {
    EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("warn,grimodex_lib=info,grimodex_lint=info"))
}
