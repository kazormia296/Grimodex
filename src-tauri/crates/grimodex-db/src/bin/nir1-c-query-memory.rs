//! Opt-in observation of one registered C-query against an in-process private fixture.
//! This CLI accepts only a known case ID and never opens a caller-supplied database.

#[path = "support/capacity_allocator.rs"]
mod capacity_allocator;
#[path = "support/private_fixture.rs"]
mod private_fixture;

use anyhow::{ensure, Result};
use private_fixture::{parse_case_args, run_private_fixture};

const MAX_REPORT_BYTES: usize = 65_536;
const INCOMPLETE_REPORT: &str = "{\"status\":\"incomplete\"}";

fn bounded_json(report: &impl serde::Serialize) -> Result<(String, bool)> {
    let json = serde_json::to_string(report)?;
    if json.len() < MAX_REPORT_BYTES {
        Ok((json, false))
    } else {
        Ok((INCOMPLETE_REPORT.to_owned(), true))
    }
}

fn main() -> Result<()> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let case_id = parse_case_args(&args)?;
    let report = run_private_fixture(
        case_id,
        capacity_allocator::begin_window,
        capacity_allocator::snapshot,
    )?;
    let (json, oversized) = bounded_json(&report)?;
    println!("{json}");
    ensure!(
        report.status == "observation-only" && !oversized,
        "private C-query observation is incomplete; see JSON report"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn rejects_legacy_path_arguments_and_unknown_cases_before_database_creation() {
        let nonexistent =
            std::env::temp_dir().join(format!("nir1-c-query-rejected-{}.db", uuid::Uuid::new_v4()));
        let old_path_arguments = [
            nonexistent.as_os_str().to_owned(),
            OsString::from("project"),
            OsString::from("scene"),
            OsString::from("seed"),
        ];
        assert!(parse_case_args(&old_path_arguments).is_err());
        assert!(parse_case_args(&[OsString::from("Q2044/R1022")]).is_err());
        assert!(parse_case_args(&[OsString::from("unknown")]).is_err());
        assert!(!nonexistent.exists());
    }

    #[test]
    fn report_cap_includes_newline_and_fails_closed() -> Result<()> {
        let (at_limit, oversized) = bounded_json(&"x".repeat(MAX_REPORT_BYTES - 3))?;
        assert!(!oversized);
        assert_eq!(at_limit.len() + 1, MAX_REPORT_BYTES);
        let (fallback, oversized) = bounded_json(&"x".repeat(MAX_REPORT_BYTES - 2))?;
        assert!(oversized);
        assert_eq!(fallback, INCOMPLETE_REPORT);
        assert!(fallback.len() + 1 < MAX_REPORT_BYTES);
        Ok(())
    }
}
