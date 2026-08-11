//! Narrative Engine runtime authority (Release Gate B Foundation).
//!
//! Policy is stored in the Native-owned `narrative_runtime_policy` singleton
//! table (not `app_settings`). Renderer／generic SQL cannot mutate it because
//! the table is an active protected writer. Typed Native setter is the only
//! write path.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::env;

/// Public error codes returned across N-API / IPC / MCP.
pub const NARRATIVE_ENGINE_DISABLED: &str = "NARRATIVE_ENGINE_DISABLED";
pub const NARRATIVE_REVIEW_ONLY: &str = "NARRATIVE_REVIEW_ONLY";
pub const NARRATIVE_MAINTENANCE_DISABLED: &str = "NARRATIVE_MAINTENANCE_DISABLED";
pub const NARRATIVE_GENERIC_IMPORT_DISABLED: &str = "NARRATIVE_GENERIC_IMPORT_DISABLED";
pub const NARRATIVE_BACKGROUND_AI_DISABLED: &str = "NARRATIVE_BACKGROUND_AI_DISABLED";
pub const NARRATIVE_APPROVAL_REQUIRED: &str = "NARRATIVE_APPROVAL_REQUIRED";
pub const NARRATIVE_RUNTIME_POLICY_CONFLICT: &str = "NARRATIVE_RUNTIME_POLICY_CONFLICT";

const ENV_DISABLE_ENGINE: &str = "GRIMODEX_DISABLE_NARRATIVE_ENGINE";
const ENV_DISABLE_MAINTENANCE: &str = "GRIMODEX_DISABLE_NARRATIVE_MAINTENANCE";
const ENV_DISABLE_GENERIC_IMPORT: &str = "GRIMODEX_DISABLE_GENERIC_IMPORT";
const ENV_DISABLE_BACKGROUND_AI: &str = "GRIMODEX_DISABLE_BACKGROUND_AI";

/// Pre-Foundation shadow keys. Never promoted into Native authority — Schema 4
/// always seeds Stage 1 defaults and deletes these rows if present.
const LEGACY_SETTING_RUNTIME_MODE: &str = "narrative.runtimeMode";
const LEGACY_SETTING_MAINTENANCE_ENABLED: &str = "narrative.maintenanceEnabled";
const LEGACY_SETTING_GENERIC_IMPORT_ENABLED: &str = "narrative.genericImportEnabled";
const LEGACY_SETTING_BACKGROUND_AI_ENABLED: &str = "narrative.backgroundAiEnabled";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
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
    pub version: i64,
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
            version: 0,
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

    pub fn maintenance_preview_allowed(&self) -> bool {
        if self.hard_disable_engine || self.hard_disable_maintenance {
            return false;
        }
        if !self.effective_mode().allows_extraction() {
            return false;
        }
        self.maintenance_enabled
    }

    pub fn maintenance_mutation_allowed(&self) -> bool {
        self.maintenance_preview_allowed() && self.domain_apply_allowed()
    }

    pub fn generic_import_capture_allowed(&self) -> bool {
        if self.hard_disable_engine || self.hard_disable_generic_import {
            return false;
        }
        if !self.effective_mode().allows_extraction() {
            return false;
        }
        self.generic_import_enabled
    }

    pub fn generic_import_apply_allowed(&self) -> bool {
        self.generic_import_capture_allowed() && self.domain_apply_allowed()
    }

    pub fn background_ai_allowed(&self) -> bool {
        if self.hard_disable_engine || self.hard_disable_background_ai {
            return false;
        }
        matches!(self.effective_mode(), NarrativeRuntimeMode::Automatic)
            && self.background_ai_enabled
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNarrativeRuntimePolicyInput {
    pub expected_version: i64,
    pub runtime_mode: String,
    pub maintenance_enabled: bool,
    pub generic_import_enabled: bool,
    pub background_ai_enabled: bool,
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

/// Stage 1 defaults with current process env hard-disable flags applied.
/// Used for every fail-closed branch (missing table／row／query／corrupt values).
fn fail_closed_policy_with_env() -> NarrativeRuntimePolicy {
    NarrativeRuntimePolicy {
        hard_disable_engine: env_flag_enabled(ENV_DISABLE_ENGINE),
        hard_disable_maintenance: env_flag_enabled(ENV_DISABLE_MAINTENANCE),
        hard_disable_generic_import: env_flag_enabled(ENV_DISABLE_GENERIC_IMPORT),
        hard_disable_background_ai: env_flag_enabled(ENV_DISABLE_BACKGROUND_AI),
        ..NarrativeRuntimePolicy::default()
    }
}

/// INTEGER flags must be exactly 0 or 1. Any other value fails closed to OFF.
fn parse_sql_bool_flag(raw: i64) -> bool {
    raw == 1
}

fn deny(code: &str, detail: &str) -> anyhow::Error {
    anyhow::anyhow!("{code}: {detail}")
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
        )",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .is_some_and(|exists| exists != 0)
}

fn delete_legacy_app_settings_shadow_keys(conn: &Connection) -> anyhow::Result<()> {
    if !table_exists(conn, "app_settings") {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM app_settings
          WHERE key IN (?1, ?2, ?3, ?4)",
        rusqlite::params![
            LEGACY_SETTING_RUNTIME_MODE,
            LEGACY_SETTING_MAINTENANCE_ENABLED,
            LEGACY_SETTING_GENERIC_IMPORT_ENABLED,
            LEGACY_SETTING_BACKGROUND_AI_ENABLED,
        ],
    )?;
    Ok(())
}

/// Ensure singleton row exists. Idempotent; safe during migrate and open.
///
/// Never promotes legacy `app_settings` values into Native authority — no public
/// release treated those keys as authority, so Schema 4 always seeds Stage 1
/// defaults (`review-only` / flags OFF) and deletes any shadow rows.
pub fn ensure_narrative_runtime_policy_row(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS narrative_runtime_policy (
            singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
            runtime_mode TEXT NOT NULL DEFAULT 'review-only'
              CHECK (runtime_mode IN ('disabled','review-only','manual-apply','automatic')),
            maintenance_enabled INTEGER NOT NULL DEFAULT 0
              CHECK (maintenance_enabled IN (0, 1)),
            generic_import_enabled INTEGER NOT NULL DEFAULT 0
              CHECK (generic_import_enabled IN (0, 1)),
            background_ai_enabled INTEGER NOT NULL DEFAULT 0
              CHECK (background_ai_enabled IN (0, 1)),
            version INTEGER NOT NULL DEFAULT 1
        );",
    )?;

    let exists: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM narrative_runtime_policy WHERE singleton_id = 1)",
        [],
        |row| row.get(0),
    )?;
    if exists == 0 {
        conn.execute(
            "INSERT INTO narrative_runtime_policy (
                singleton_id, runtime_mode, maintenance_enabled,
                generic_import_enabled, background_ai_enabled, version
             ) VALUES (1, 'review-only', 0, 0, 0, 1)",
            [],
        )?;
    }

    delete_legacy_app_settings_shadow_keys(conn)?;
    Ok(())
}

fn load_stored_policy(conn: &Connection) -> NarrativeRuntimePolicy {
    if !table_exists(conn, "narrative_runtime_policy") {
        return fail_closed_policy_with_env();
    }
    let loaded = conn.query_row(
        "SELECT runtime_mode, maintenance_enabled, generic_import_enabled,
                background_ai_enabled, version
           FROM narrative_runtime_policy
          WHERE singleton_id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        },
    );
    match loaded {
        Ok((mode, maintenance, generic_import, background_ai, version)) => {
            NarrativeRuntimePolicy {
                runtime_mode: NarrativeRuntimeMode::parse_fail_closed(&mode),
                maintenance_enabled: parse_sql_bool_flag(maintenance),
                generic_import_enabled: parse_sql_bool_flag(generic_import),
                background_ai_enabled: parse_sql_bool_flag(background_ai),
                version,
                hard_disable_engine: env_flag_enabled(ENV_DISABLE_ENGINE),
                hard_disable_maintenance: env_flag_enabled(ENV_DISABLE_MAINTENANCE),
                hard_disable_generic_import: env_flag_enabled(ENV_DISABLE_GENERIC_IMPORT),
                hard_disable_background_ai: env_flag_enabled(ENV_DISABLE_BACKGROUND_AI),
            }
        }
        Err(_) => fail_closed_policy_with_env(),
    }
}

/// Load workspace Narrative policy. Missing table／row／corrupt values fail closed.
pub fn load_narrative_runtime_policy(conn: &Connection) -> NarrativeRuntimePolicy {
    load_stored_policy(conn)
}

pub fn load_narrative_runtime_policy_from_db(
    db: &crate::Database,
) -> anyhow::Result<NarrativeRuntimePolicy> {
    db.with_conn(|conn| Ok(load_narrative_runtime_policy(conn)))
}

pub fn set_narrative_runtime_policy(
    db: &crate::Database,
    input: SetNarrativeRuntimePolicyInput,
) -> anyhow::Result<NarrativeRuntimePolicy> {
    db.with_conn(|conn| set_narrative_runtime_policy_in_tx(conn, &input))
}

pub fn set_narrative_runtime_policy_in_tx(
    conn: &Connection,
    input: &SetNarrativeRuntimePolicyInput,
) -> anyhow::Result<NarrativeRuntimePolicy> {
    ensure_narrative_runtime_policy_row(conn)?;
    if input.expected_version < 0 {
        return Err(deny(
            NARRATIVE_RUNTIME_POLICY_CONFLICT,
            "expected_version must be a non-negative integer",
        ));
    }
    let mode = NarrativeRuntimeMode::parse_fail_closed(&input.runtime_mode);
    // Unknown modes collapse for reads, but typed setter must reject unknowns
    // so callers cannot accidentally persist garbage.
    if mode.as_str() != input.runtime_mode.trim() {
        return Err(deny(
            NARRATIVE_RUNTIME_POLICY_CONFLICT,
            "unknown runtime mode",
        ));
    }

    let updated = conn.execute(
        "UPDATE narrative_runtime_policy
            SET runtime_mode = ?1,
                maintenance_enabled = ?2,
                generic_import_enabled = ?3,
                background_ai_enabled = ?4,
                version = version + 1
          WHERE singleton_id = 1 AND version = ?5",
        rusqlite::params![
            mode.as_str(),
            i64::from(input.maintenance_enabled),
            i64::from(input.generic_import_enabled),
            i64::from(input.background_ai_enabled),
            input.expected_version,
        ],
    )?;
    if updated != 1 {
        return Err(deny(
            NARRATIVE_RUNTIME_POLICY_CONFLICT,
            "runtime policy version conflict",
        ));
    }
    Ok(load_narrative_runtime_policy(conn))
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

pub fn require_narrative_maintenance_preview_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if !policy.maintenance_preview_allowed() {
        return Err(deny(
            NARRATIVE_MAINTENANCE_DISABLED,
            "narrative maintenance preview is disabled",
        ));
    }
    Ok(())
}

pub fn require_narrative_maintenance_mutation_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if !policy.maintenance_mutation_allowed() {
        return Err(deny(
            NARRATIVE_MAINTENANCE_DISABLED,
            "narrative maintenance mutation requires apply-capable mode",
        ));
    }
    Ok(())
}

/// Backward-compatible name: preview-only. Mutation callers must use
/// [`require_narrative_maintenance_mutation_allowed`].
pub fn require_narrative_maintenance_allowed(conn: &Connection) -> anyhow::Result<()> {
    require_narrative_maintenance_preview_allowed(conn)
}

pub fn require_generic_import_capture_allowed(conn: &Connection) -> anyhow::Result<()> {
    let policy = load_narrative_runtime_policy(conn);
    if !policy.generic_import_capture_allowed() {
        return Err(deny(
            NARRATIVE_GENERIC_IMPORT_DISABLED,
            "generic import capture is disabled",
        ));
    }
    Ok(())
}

pub fn require_generic_import_apply_allowed(conn: &Connection) -> anyhow::Result<()> {
    require_generic_import_capture_allowed(conn)?;
    require_narrative_apply_allowed(conn)?;
    Ok(())
}

/// Backward-compatible name: capture-only.
pub fn require_generic_import_allowed(conn: &Connection) -> anyhow::Result<()> {
    require_generic_import_capture_allowed(conn)
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

/// DB-bound manual apply gate. Loads ProposalSet／revision／decision from the
/// same connection. Renderer-supplied decision strings are never trusted.
pub fn require_manual_apply_authority_in_tx(
    conn: &Connection,
    proposal_set_id: &str,
    expected_revision_id: &str,
) -> anyhow::Result<()> {
    require_narrative_apply_allowed(conn)?;

    if proposal_set_id.trim().is_empty() || expected_revision_id.trim().is_empty() {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "proposal set and revision are required",
        ));
    }

    for table in [
        "narrative_proposal_sets",
        "narrative_proposal_revisions",
        "narrative_proposal_decisions",
    ] {
        if !table_exists(conn, table) {
            return Err(deny(
                NARRATIVE_APPROVAL_REQUIRED,
                "narrative proposal authority tables are unavailable",
            ));
        }
    }

    let (current_revision_id, project_id): (String, String) = conn
        .query_row(
            "SELECT current_revision_id, project_id
               FROM narrative_proposal_sets
              WHERE id = ?1",
            [proposal_set_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| {
            deny(
                NARRATIVE_APPROVAL_REQUIRED,
                "proposal set was not found",
            )
        })?;

    if current_revision_id != expected_revision_id {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "proposal revision is stale",
        ));
    }

    let revision_belongs: i64 = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM narrative_proposal_revisions
             WHERE id = ?1 AND proposal_set_id = ?2
        )",
        rusqlite::params![expected_revision_id, proposal_set_id],
        |row| row.get(0),
    )?;
    if revision_belongs == 0 {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "revision does not belong to proposal set",
        ));
    }

    let decision = conn.query_row(
        "SELECT status, revision_id, proposal_set_id
           FROM narrative_proposal_decisions
          WHERE proposal_set_id = ?1
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1",
        [proposal_set_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    );
    let (status, decision_revision_id, decision_set_id) = decision.map_err(|_| {
        deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "no decision exists for proposal set",
        )
    })?;

    if status != "approved" {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "latest decision must be approved",
        ));
    }
    if decision_revision_id != expected_revision_id || decision_set_id != proposal_set_id {
        return Err(deny(
            NARRATIVE_APPROVAL_REQUIRED,
            "decision does not match current proposal set revision",
        ));
    }

    // project_id is retained for future workspace／project authority checks when
    // extraction runs land; reading it proves the set is project-scoped.
    let _ = project_id;
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
        let db = Database::new(std::path::Path::new(":memory:")).expect("open db");
        db.migrate().expect("migrate");
        db
    }

    #[test]
    fn missing_policy_row_fail_closed_to_review_only_defaults() {
        let db = open_db();
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);
        assert!(!policy.maintenance_enabled);
        assert!(!policy.generic_import_enabled);
        assert!(!policy.background_ai_enabled);
        assert!(policy.version >= 1);
        assert!(!policy.domain_apply_allowed());
    }

    #[test]
    fn renderer_cannot_mutate_runtime_policy_table() {
        let db = open_db();
        let error = db
            .execute_renderer(
                "UPDATE narrative_runtime_policy
                    SET runtime_mode = 'automatic', version = version + 1
                  WHERE singleton_id = 1",
                &[],
                "run",
            )
            .expect_err("renderer policy update denied");
        assert!(
            error.to_string().contains("PROTECTED_WRITER_SQL"),
            "unexpected error: {error}"
        );
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);
    }

    #[test]
    fn typed_setter_cas_updates_mode() {
        let db = open_db();
        let before = load_narrative_runtime_policy_from_db(&db).expect("load");
        let after = set_narrative_runtime_policy(
            &db,
            SetNarrativeRuntimePolicyInput {
                expected_version: before.version,
                runtime_mode: "manual-apply".into(),
                maintenance_enabled: false,
                generic_import_enabled: false,
                background_ai_enabled: false,
            },
        )
        .expect("set");
        assert_eq!(after.runtime_mode, NarrativeRuntimeMode::ManualApply);
        assert_eq!(after.version, before.version + 1);
        db.with_conn(require_narrative_apply_allowed)
            .expect("manual-apply allows apply");
    }

    #[test]
    fn hard_env_disable_overrides_typed_automatic() {
        let _guard = env_lock().lock().expect("env lock");
        let db = open_db();
        let before = load_narrative_runtime_policy_from_db(&db).expect("load");
        set_narrative_runtime_policy(
            &db,
            SetNarrativeRuntimePolicyInput {
                expected_version: before.version,
                runtime_mode: "automatic".into(),
                maintenance_enabled: true,
                generic_import_enabled: true,
                background_ai_enabled: true,
            },
        )
        .expect("set");
        unsafe {
            env::set_var(ENV_DISABLE_ENGINE, "1");
        }
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.effective_mode(), NarrativeRuntimeMode::Disabled);
        assert!(!policy.domain_apply_allowed());
        assert!(!policy.maintenance_preview_allowed());
        unsafe {
            env::remove_var(ENV_DISABLE_ENGINE);
        }
    }

    #[test]
    fn legacy_app_settings_are_never_promoted_into_native_policy() {
        let db = open_db();
        db.with_conn(|conn| {
            conn.execute("DELETE FROM narrative_runtime_policy", [])?;
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![LEGACY_SETTING_RUNTIME_MODE, "automatic"],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![LEGACY_SETTING_MAINTENANCE_ENABLED, "true"],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![LEGACY_SETTING_GENERIC_IMPORT_ENABLED, "true"],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![LEGACY_SETTING_BACKGROUND_AI_ENABLED, "true"],
            )?;
            ensure_narrative_runtime_policy_row(conn)?;
            Ok(())
        })
        .expect("seed legacy shadow settings");

        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);
        assert!(!policy.maintenance_enabled);
        assert!(!policy.generic_import_enabled);
        assert!(!policy.background_ai_enabled);
        assert!(!policy.domain_apply_allowed());

        db.with_conn(|conn| {
            let leftover: i64 = conn.query_row(
                "SELECT COUNT(*) FROM app_settings
                  WHERE key IN (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    LEGACY_SETTING_RUNTIME_MODE,
                    LEGACY_SETTING_MAINTENANCE_ENABLED,
                    LEGACY_SETTING_GENERIC_IMPORT_ENABLED,
                    LEGACY_SETTING_BACKGROUND_AI_ENABLED,
                ],
                |row| row.get(0),
            )?;
            assert_eq!(leftover, 0, "legacy shadow keys must be deleted");
            Ok(())
        })
        .expect("legacy keys removed");
    }

    #[test]
    fn missing_policy_table_still_honors_env_hard_disable() {
        let _guard = env_lock().lock().expect("env lock");
        let db = open_db();
        db.with_conn(|conn| {
            conn.execute_batch("DROP TABLE narrative_runtime_policy")?;
            Ok(())
        })
        .expect("drop policy table");
        unsafe {
            env::set_var(ENV_DISABLE_ENGINE, "1");
        }
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert!(policy.hard_disable_engine);
        assert_eq!(policy.effective_mode(), NarrativeRuntimeMode::Disabled);
        assert!(!policy.extraction_allowed());
        db.with_conn(|conn| {
            let err = require_narrative_extraction_allowed(conn).expect_err("disabled");
            assert!(err.to_string().contains(NARRATIVE_ENGINE_DISABLED));
            Ok(())
        })
        .expect("conn");
        unsafe {
            env::remove_var(ENV_DISABLE_ENGINE);
        }
    }

    #[test]
    fn missing_singleton_row_still_honors_env_hard_disable() {
        let _guard = env_lock().lock().expect("env lock");
        let db = open_db();
        db.with_conn(|conn| {
            conn.execute("DELETE FROM narrative_runtime_policy", [])?;
            Ok(())
        })
        .expect("delete singleton");
        unsafe {
            env::set_var(ENV_DISABLE_ENGINE, "1");
        }
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert!(policy.hard_disable_engine);
        assert!(!policy.extraction_allowed());
        unsafe {
            env::remove_var(ENV_DISABLE_ENGINE);
        }
    }

    #[test]
    fn corrupt_sql_bool_flags_fail_closed_to_off() {
        let db = open_db();
        db.with_conn(|conn| {
            conn.execute_batch(
                "DROP TABLE narrative_runtime_policy;
                 CREATE TABLE narrative_runtime_policy (
                    singleton_id INTEGER PRIMARY KEY,
                    runtime_mode TEXT NOT NULL,
                    maintenance_enabled INTEGER NOT NULL,
                    generic_import_enabled INTEGER NOT NULL,
                    background_ai_enabled INTEGER NOT NULL,
                    version INTEGER NOT NULL
                 );
                 INSERT INTO narrative_runtime_policy (
                    singleton_id, runtime_mode, maintenance_enabled,
                    generic_import_enabled, background_ai_enabled, version
                 ) VALUES (1, 'manual-apply', 2, -1, 99, 1);",
            )?;
            Ok(())
        })
        .expect("seed corrupt flags");
        let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
        assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ManualApply);
        assert!(!policy.maintenance_enabled);
        assert!(!policy.generic_import_enabled);
        assert!(!policy.background_ai_enabled);
    }

    #[test]
    fn maintenance_and_import_guards_split_preview_from_mutation() {
        let db = open_db();
        let before = load_narrative_runtime_policy_from_db(&db).expect("load");
        set_narrative_runtime_policy(
            &db,
            SetNarrativeRuntimePolicyInput {
                expected_version: before.version,
                runtime_mode: "review-only".into(),
                maintenance_enabled: true,
                generic_import_enabled: true,
                background_ai_enabled: false,
            },
        )
        .expect("set");
        db.with_conn(require_narrative_maintenance_preview_allowed)
            .expect("preview allowed in review-only");
        db.with_conn(|conn| {
            let err = require_narrative_maintenance_mutation_allowed(conn)
                .expect_err("mutation denied in review-only");
            assert!(err.to_string().contains(NARRATIVE_MAINTENANCE_DISABLED));
            let err = require_generic_import_apply_allowed(conn)
                .expect_err("import apply denied in review-only");
            assert!(
                err.to_string().contains(NARRATIVE_REVIEW_ONLY)
                    || err.to_string().contains(NARRATIVE_GENERIC_IMPORT_DISABLED)
            );
            Ok(())
        })
        .expect("conn");
    }

    #[test]
    fn manual_apply_authority_reads_db_not_caller_strings() {
        let db = open_db();
        let before = load_narrative_runtime_policy_from_db(&db).expect("load");
        set_narrative_runtime_policy(
            &db,
            SetNarrativeRuntimePolicyInput {
                expected_version: before.version,
                runtime_mode: "manual-apply".into(),
                maintenance_enabled: false,
                generic_import_enabled: false,
                background_ai_enabled: false,
            },
        )
        .expect("set");

        db.with_conn(|conn| {
            let err = require_manual_apply_authority_in_tx(conn, "ps-1", "rev-1")
                .expect_err("missing tables");
            assert!(err.to_string().contains(NARRATIVE_APPROVAL_REQUIRED));
            Ok(())
        })
        .expect("conn");

        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE narrative_proposal_sets (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    current_revision_id TEXT NOT NULL
                 );
                 CREATE TABLE narrative_proposal_revisions (
                    id TEXT PRIMARY KEY,
                    proposal_set_id TEXT NOT NULL
                 );
                 CREATE TABLE narrative_proposal_decisions (
                    id TEXT PRIMARY KEY,
                    proposal_set_id TEXT NOT NULL,
                    revision_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );
                 INSERT INTO narrative_proposal_sets (id, project_id, current_revision_id)
                 VALUES ('ps-1', 'p1', 'rev-1');
                 INSERT INTO narrative_proposal_revisions (id, proposal_set_id)
                 VALUES ('rev-1', 'ps-1');
                 INSERT INTO narrative_proposal_decisions
                    (id, proposal_set_id, revision_id, status, created_at)
                 VALUES ('d1', 'ps-1', 'rev-1', 'approved', '2026-01-01T00:00:00Z');",
            )?;
            require_manual_apply_authority_in_tx(conn, "ps-1", "rev-1")?;
            let stale = require_manual_apply_authority_in_tx(conn, "ps-1", "rev-old")
                .expect_err("stale");
            assert!(stale.to_string().contains(NARRATIVE_APPROVAL_REQUIRED));
            Ok(())
        })
        .expect("fixture");
    }
}
