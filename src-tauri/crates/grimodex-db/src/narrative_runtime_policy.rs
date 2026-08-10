//! Narrative Engine runtime authority (Release Gate B).
//!
//! AI policy remains fail-open for existing chat／body features. Narrative Engine
//! settings are fail-closed: missing, corrupt, or unknown values collapse to
//! `review-only`, and hard environment disables always win.

use rusqlite::Connection;
use serde::Deserialize;
use std::env;

/// Public error codes returned across N-API / IPC / MCP.
pub const NARRATIVE_ENGINE_DISABLED: &str = "NARRATIVE_ENGINE_DISABLED";
pub const NARRATIVE_REVIEW_ONLY: &str = "NARRATIVE_REVIEW_ONLY";
pub const NARRATIVE_MAINTENANCE_DISABLED: &str = "NARRATIVE_MAINTENANCE_DISABLED";
pub const NARRATIVE_GENERIC_IMPORT_DISABLED: &str = "NARRATIVE_GENERIC_IMPORT_DISABLED";
pub const NARRATIVE_BACKGROUND_AI_DISABLED: &str = "NARRATIVE_BACKGROUND_AI_DISABLED";
pub const NARRATIVE_APPROVAL_REQUIRED: &str = "NARRATIVE_APPROVAL_REQUIRED";

pub const SETTING_RUNTIME_MODE: &str = "narrative.runtimeMode";
pub const SETTING_MAINTENANCE_ENABLED: &str = "narrative.maintenanceEnabled";
pub const SETTING_GENERIC_IMPORT_ENABLED: &str = "narrative.genericImportEnabled";
pub const SETTING_BACKGROUND_AI_ENABLED: &str = "narrative.backgroundAiEnabled";

const ENV_DISABLE_ENGINE: &str = "GRIMODEX_DISABLE_NARRATIVE_ENGINE";
const ENV_DISABLE_MAINTENANCE: &str = "GRIMODEX_DISABLE_NARRATIVE_MAINTENANCE";
const ENV_DISABLE_GENERIC_IMPORT: &str = "GRIMODEX_DISABLE_GENERIC_IMPORT";
const ENV_DISABLE_BACKGROUND_AI: &str = "GRIMODEX_DISABLE_BACKGROUND_AI";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NarrativeRuntimeMode {
    Disabled,
    #[default]
    ReviewOnly,
    ManualApply,
    Automatic,
}

impl NarrativeRuntimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::ReviewOnly => "review-only",
            Self::ManualApply => "manual-apply",
            Self::Automatic => "automatic",
        }
    }

    pub fn parse_fail_closed(raw: &str) -> Self {
        match raw.trim() {
            "disabled" => Self::Disabled,
            "review-only" => Self::ReviewOnly,
            "manual-apply" => Self::ManualApply,
            "automatic" => Self::Automatic,
            _ => Self::ReviewOnly,
        }
    }

    pub fn allows_extraction(self) -> bool {
        !matches!(self, Self::Disabled)
    }

    pub fn allows_proposal_mutation(self) -> bool {
        !matches!(self, Self::Disabled)
    }

    pub fn allows_domain_apply(self) -> bool {
        matches!(self, Self::ManualApply | Self::Automatic)
    }

    pub fn allows_redo(self) -> bool {
        self.allows_domain_apply()
    }

    pub fn allows_undo(self) -> bool {
        true
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NarrativeRuntimePolicy {
    pub runtime_mode: NarrativeRuntimeMode,
    pub maintenance_enabled: bool,
    pub generic_import_enabled: bool,
    pub background_ai_enabled: bool,
    pub hard_disable_engine: bool,
    pub hard_disable_maintenance: bool,
    pub hard_disable_generic_import: bool,
    pub hard_disable_background_ai: bool,
}

impl Default for NarrativeRuntimePolicy {
    fn default() -> Self {
        Self {
            runtime_mode: NarrativeRuntimeMode::ReviewOnly,
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
            hard_disable_engine: false,
            hard_disable_maintenance: false,
            hard_disable_generic_import: false,
            hard_disable_background_ai: false,
        }
    }
}

impl NarrativeRuntimePolicy {
    pub fn effective_mode(&self) -> NarrativeRuntimeMode {
        if self.hard_disable_engine {
            return NarrativeRuntimeMode::Disabled;
        }
        self.runtime_mode
    }

    pub fn extraction_allowed(&self) -> bool {
        self.effective_mode().allows_extraction()
    }

    pub fn proposal_mutation_allowed(&self) -> bool {
        self.effective_mode().allows_proposal_mutation()
    }

    pub fn domain_apply_allowed(&self) -> bool {
        self.effective_mode().allows_domain_apply()
    }

    pub fn undo_allowed(&self) -> bool {
        true
    }

    pub fn redo_allowed(&self) -> bool {
        self.effective_mode().allows_redo()
    }

    pub fn maintenance_allowed(&self) -> bool {
        if self.hard_disable_engine || self.hard_disable_maintenance {
            return false;
        }
        if !self.effective_mode().allows_extraction() {
            return false;
        }
        self.maintenance_enabled
    }

    pub fn generic_import_allowed(&self) -> bool {
        if self.hard_disable_engine || self.hard_disable_generic_import {
            return false;
        }
        if !self.effective_mode().allows_extraction() {
            return false;
        }
        self.generic_import_enabled
    }

    pub fn background_ai_allowed(&self) -> bool {
        if self.hard_disable_engine || self.hard_disable_background_ai {
            return false;
        }
        matches!(self.effective_mode(), NarrativeRuntimeMode::Automatic) && self.background_ai_enabled
    }
}

fn env_flag_enabled(name: &str) -> bool {
    match env::var(name) {
        Ok(value) => {
            let trimmed = value.trim();
            trimmed == "1"
                || trimmed.eq_ignore_ascii_case("true")
                || trimmed.eq_ignore_ascii_case("yes")
                || trimmed.eq_ignore_ascii_case("on")
        }
        Err(_) => false,
    }
}

fn parse_bool_fail_closed(raw: Option<&str>) -> bool {
    match raw.map(str::trim) {
        Some("true") | Some("1") | Some("yes") | Some("on") => true,
        Some("false") | Some("0") | Some("no") | Some("off") => false,
        _ => false,
    }
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// Load workspace Narrative policy. Missing table／row／corrupt values fail closed.
pub fn load_narrative_runtime_policy(conn: &Connection) -> NarrativeRuntimePolicy {
    let mode_raw = read_setting(conn, SETTING_RUNTIME_MODE);
    let runtime_mode = mode_raw
        .as_deref()
        .map(NarrativeRuntimeMode::parse_fail_closed)
        .unwrap_or_default();

    NarrativeRuntimePolicy {
        runtime_mode,
        maintenance_enabled: parse_bool_fail_closed(
            read_setting(conn, SETTING_MAINTENANCE_ENABLED).as_deref(),
        ),
        generic_import_enabled: parse_bool_fail_closed(
            read_setting(conn, SETTING_GENERIC_IMPORT_ENABLED).as_deref(),
        ),
        background_ai_enabled: parse_bool_fail_closed(
            read_setting(conn, SETTING_BACKGROUND_AI_ENABLED).as_deref(),
        ),
        hard_disable_engine: env_flag_enabled(ENV_DISABLE_ENGINE),
        hard_disable_maintenance: env_flag_enabled(ENV_DISABLE_MAINTENANCE),
        hard_disable_generic_import: env_flag_enabled(ENV_DISABLE_GENERIC_IMPORT),
        hard_disable_background_ai: env_flag_enabled(ENV_DISABLE_BACKGROUND_AI),
    }
}

pub fn load_narrative_runtime_policy_from_db(
    db: &crate::Database,
) -> anyhow::Result<NarrativeRuntimePolicy> {
    db.with_conn(|conn| Ok(load_narrative_runtime_policy(conn)))
}

fn deny(code: &str, detail: &str) -> anyhow::Error {
    anyhow::anyhow!("{code}: {detail}")
}

pub fn require_narrative_extraction_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if policy.hard_disable_engine || !policy.extraction_allowed() {
        return Err(deny(
            NARRATIVE_ENGINE_DISABLED,
            "narrative extraction is disabled by runtime policy",
        ));
    }
    Ok(())
}

pub fn require_narrative_apply_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if policy.hard_disable_engine {
        return Err(deny(
            NARRATIVE_ENGINE_DISABLED,
            "narrative engine hard-disabled",
        ));
    }
    if !policy.domain_apply_allowed() {
        return Err(deny(
            NARRATIVE_REVIEW_ONLY,
            "domain apply requires manual-apply or automatic runtime mode",
        ));
    }
    Ok(())
}

pub fn require_narrative_redo_allowed(conn: &Connection) -> anyhow::Result<()> {
    require_narrative_apply_allowed(conn)
}

pub fn require_narrative_undo_allowed(_conn: &Connection) -> anyhow::Result<()> {
    Ok(())
}

pub fn require_narrative_maintenance_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if !policy.maintenance_allowed() {
        return Err(deny(
            NARRATIVE_MAINTENANCE_DISABLED,
            "narrative maintenance is disabled",
        ));
    }
    Ok(())
}

pub fn require_generic_import_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if !policy.generic_import_allowed() {
        return Err(deny(
            NARRATIVE_GENERIC_IMPORT_DISABLED,
            "generic import is disabled",
        ));
    }
    Ok(())
}

pub fn require_background_ai_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if !policy.background_ai_allowed() {
        return Err(deny(
            NARRATIVE_BACKGROUND_AI_DISABLED,
            "background AI is disabled",
        ));
    }
    Ok(())
}

/// Native-side consistency check for already-loaded apply authority.
///
/// This does **not** read proposal / decision rows from the database. Callers
/// (Narrative Extraction Native apply) must load the exact ProposalSet,
/// current revision, and latest decision from DB, then pass those facts here.
/// Treating renderer-supplied values as authoritative is a security bug.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManualApplyAuthority {
    pub proposal_set_id: String,
    pub expected_revision_id: String,
    pub current_revision_id: String,
    pub latest_decision_status: String,
    pub decision_revision_id: String,
}

pub fn require_manual_apply_authority(
    conn: &Connection,
    authority: &ManualApplyAuthority,
) -> anyhow::Result<()> {
    require_narrative_apply_allowed(conn)?;

    if authority.proposal_set_id.trim().is_empty() {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "exact proposal set is required",
        ));
    }
    if authority.expected_revision_id != authority.current_revision_id {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "proposal revision is stale",
        ));
    }
    if authority.latest_decision_status != "approved" {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "latest decision must be approved",
        ));
    }
    if authority.decision_revision_id != authority.current_revision_id {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "decision does not match current revision",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn open_db() -> Database {
        Database::new(std::path::Path::new(":memory:")).expect("open db")
    }

    fn write_setting(db: &Database, key: &str, value: &str) {
        db.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            &[serde_json::Value::from(key), serde_json::Value::from(value)],
            "run",
        )
        .expect("write setting");
    }

    #[test]
    fn missing_settings_fail_closed_to_review_only() {
        let db = open_db();
        db.migrate().expect("migrate");
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);
        assert!(!policy.maintenance_enabled);
        assert!(!policy.generic_import_enabled);
        assert!(!policy.background_ai_enabled);
        assert!(policy.extraction_allowed());
        assert!(!policy.domain_apply_allowed());
    }

    #[test]
    fn corrupt_and_unknown_mode_fail_closed() {
        let db = open_db();
        db.migrate().expect("migrate");
        write_setting(&db, SETTING_RUNTIME_MODE, "{not-json");
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);

        write_setting(&db, SETTING_RUNTIME_MODE, "full-auto-please");
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);
    }

    #[test]
    fn apply_denied_until_manual_apply_or_automatic() {
        let db = open_db();
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            let err = require_narrative_apply_allowed(conn).expect_err("default deny apply");
            assert!(err.to_string().contains(NARRATIVE_REVIEW_ONLY));
            Ok(())
        })
        .expect("conn");

        write_setting(&db, SETTING_RUNTIME_MODE, "manual-apply");
        db.with_conn(require_narrative_apply_allowed)
            .expect("manual-apply allows domain apply");
    }

    #[test]
    fn disabled_blocks_run_but_allows_undo() {
        let db = open_db();
        db.migrate().expect("migrate");
        write_setting(&db, SETTING_RUNTIME_MODE, "disabled");
        db.with_conn(|conn| {
            let err = require_narrative_extraction_allowed(conn).expect_err("disabled");
            assert!(err.to_string().contains(NARRATIVE_ENGINE_DISABLED));
            require_narrative_undo_allowed(conn).expect("undo always allowed");
            Ok(())
        })
        .expect("conn");
    }

    #[test]
    fn hard_env_disable_overrides_workspace_settings() {
        let _guard = env_lock().lock().expect("env lock");
        let db = open_db();
        db.migrate().expect("migrate");
        write_setting(&db, SETTING_RUNTIME_MODE, "automatic");
        write_setting(&db, SETTING_MAINTENANCE_ENABLED, "true");
        write_setting(&db, SETTING_BACKGROUND_AI_ENABLED, "true");

        // SAFETY: serialized by env_lock for this test module.
        unsafe {
            env::set_var(ENV_DISABLE_ENGINE, "1");
        }
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.effective_mode(), NarrativeRuntimeMode::Disabled);
        assert!(!policy.domain_apply_allowed());
        assert!(!policy.maintenance_allowed());
        assert!(!policy.background_ai_allowed());
        unsafe {
            env::remove_var(ENV_DISABLE_ENGINE);
        }
    }

    #[test]
    fn manual_apply_requires_exact_approved_revision() {
        let db = open_db();
        db.migrate().expect("migrate");
        write_setting(&db, SETTING_RUNTIME_MODE, "manual-apply");

        let authority = ManualApplyAuthority {
            proposal_set_id: "ps-1".into(),
            expected_revision_id: "rev-1".into(),
            current_revision_id: "rev-1".into(),
            latest_decision_status: "approved".into(),
            decision_revision_id: "rev-1".into(),
        };
        db.with_conn(|conn| require_manual_apply_authority(conn, &authority))
            .expect("valid authority");

        let stale = ManualApplyAuthority {
            current_revision_id: "rev-2".into(),
            ..authority.clone()
        };
        db.with_conn(|conn| {
            let err = require_manual_apply_authority(conn, &stale).expect_err("stale");
            assert!(err.to_string().contains(NARRATIVE_APPROVAL_REQUIRED));
            Ok(())
        })
        .expect("conn");
    }
}
