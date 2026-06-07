//! Standalone `grimodex-mcp` binary.
//!
//! Thin shim over the library entry point. The real logic lives in
//! `lib.rs` (`run`/`run_blocking`) so the main Grimodex app binary can call
//! the same code via its `mcp` subcommand without shelling out to a separate
//! executable. This `[[bin]]` is kept for dev/CI and headless servers (no
//! webkit/ort load-time deps), per the unification plan.

use clap::Parser;

fn main() -> anyhow::Result<()> {
    grimodex_mcp::run_blocking(grimodex_mcp::Cli::parse())
}
