// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use grimodex_mcp::Parser;
use std::ffi::{OsStr, OsString};

fn main() {
    // MCP unification: when invoked as `Grimodex mcp [--workspace …]`, run the
    // stdio MCP server instead of opening the GUI. This branch runs BEFORE any
    // Tauri/tokio init so external MCP clients (Claude Code / Hermes Agent) can
    // spawn the installed app binary directly — no separate binary to ship.
    let mut argv = std::env::args_os();
    let _prog = argv.next();
    if argv.next().as_deref() == Some(OsStr::new("mcp")) {
        // Synthesize argv[0] so clap is happy; `argv` (already past prog+"mcp")
        // supplies the real flags. --help/error text reads "grimodex-mcp"
        // (from #[command(name)]); cosmetic, accepted.
        let cli = grimodex_mcp::Cli::parse_from(
            std::iter::once(OsString::from("grimodex-mcp")).chain(argv),
        );
        match grimodex_mcp::run_blocking(cli) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("grimodex mcp: {e:#}");
                std::process::exit(1);
            }
        }
    }

    grimodex_lib::run()
}
