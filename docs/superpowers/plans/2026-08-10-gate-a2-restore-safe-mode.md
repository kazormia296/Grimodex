# Gate A2: Restore-only Safe Mode / Migration Certification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Release Gate A by making Safe Mode a structured restore-only startup state (Native→IPC→renderer), opaque recovery IDs, real release-schema fixtures + subprocess crash tests, and a required `migration-recovery-gate` CI job.

**Architecture:** Keep Gate A `WorkspaceOpenDbOutcome` as the DB-domain outcome. Add serde wire `WorkspaceOpenOutcome` returned by `open_workspace` (Ok, never string-collapsed Safe Mode). On Safe Mode / RecoveryRequired, publish a `SafeModeSession` (path + opaque candidate registry) instead of `WorkspaceAuthority`. Recovery Shell is a dedicated AppView; normal hydration is skipped. Restore resolves opaque IDs server-side through validate→preflight→exclusive lease→atomic replace.

**Tech Stack:** Rust (`grimodex-db`), N-API (`grimodex-node`), Electron IPC contract, React 19 + Zustand, Vitest, GitHub Actions.

## Global Constraints

- branch-first: `cursor/gate-a2-restore-safe-mode-967b`; never commit to master
- renderer never imports Node/Electron/N-API; use `window.grimodex` / typed invoke
- IPC正本: `electron/shared/ipcContract.ts`; main re-validates args
- Rust: no `unwrap()` in production paths; thiserror/anyhow
- Safe Mode must not publish `WorkspaceAuthority` or start Project hydration / Editor / Chat / AI / `db_execute` / MCP workspace / semantic indexing / auto backup / Narrative Extraction
- Recovery candidates are opaque IDs — never round-trip `migrations/foo.db` paths from renderer
- `test-failpoints` feature is CI-only; never enable in release Electron builds
- `git add` explicit paths only (no `-A`)
- docs/plans may be committed; prefer Japanese for design notes

## Impact Matrix

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | -------------- | ---------------- | ----------------------------------------- | --------------- | ------------------- | ------------------------ | ------------ | ------- |
| P1 | open_workspace Ready/Migrated | grimodex-db open + supervisor | Wire becomes `{status,workspace,migration?}` (was bare OpenWorkspaceResult) | N-API → IPC → workspace store → hydration | Authority published only on Ready/Migrated; swap-after infallible | All Ready/Migrated consumers must unwrap `workspace` | cargo test open; ipcContract; store tests | planned |
| P2 | open_workspace SafeMode / RecoveryRequired | migration_supervisor | Ok(WorkspaceOpenOutcome) + SafeModeSession; no string WORKSPACE_SAFE_MODE collapse for control flow | Recovery Shell | No WorkspaceAuthority; no Optimize/FTS/hydrate | Old FE that treated open failure as launcher error must switch on status | supervisor + open integration tests | planned |
| P3 | list/verify/restore recovery by opaque ID | recovery.rs | IPC: candidateId string; Native resolves registry; path must stay under workspace | Recovery Shell / Settings restore | Exclusive lease + checksum + disposable preflight + atomic restore | Keep `list_backups`/`restore_backup(fileName)` for normal Settings until migrated | recovery unit + ipc tests | planned |
| P4 | with_db / db_execute / MCP while Safe Mode | state.rs + execute + MCP | Fail-closed with WORKSPACE_SAFE_MODE marker (not silent NoWorkspace alone) | renderer SQL, MCP, AI | No generic SQL / AI / MCP workspace access | String marker for FE classify | rust unit + mcp smoke | planned |
| P5 | release-schema fixture + WAL + subprocess crash | grimodex-db tests + harness bin | Fixture seeds Project/Scene/Codex/Chronicle/FTS/AI audit/settings + dirty WAL; child killed at failpoints | CI migration-recovery-gate | Uncheckpointed WAL commits land in snapshot; next open → recovery or healthy | Windows smoke keeps fresh/legacy/restore | cargo test fixtures + crash harness | planned |
| P6 | migration-recovery-gate CI | ci.yml | Dedicated required job aggregating supervisor/failpoints/fixtures/WAL/crash/Windows smoke/IPC/Recovery Shell | GitHub required checks | Gate A2 completion gate | Windows job remains on windows-latest | workflow YAML review | planned |
| P7 | Tauri frozen shell | out of scope | — | — | Frozen; do not add new Safe Mode UI there | N/A | out of scope: legacy Tauri | out of scope: legacy Tauri |
| P8 | Gate B Narrative Runtime Authority | out of scope | — | — | Deferred until after Gate A2 | N/A | out of scope: Gate B | out of scope: Gate B |

---

### Task 1: RecoveryCandidate + SafeModeSession + structured open outcome (Rust)

**Files:**
- Create: `src-tauri/crates/grimodex-db/src/recovery.rs`
- Modify: `src-tauri/crates/grimodex-db/src/state.rs`, `open.rs`, `migration_supervisor.rs`, `lib.rs`, `error.rs`
- Test: `src-tauri/crates/grimodex-db/tests/workspace_safe_mode_outcome.rs`

**Interfaces:**
- Produces:
  - `RecoveryCandidate { id, kind, created_at, schema_version, app_version, size_bytes, checksum_status }`
  - `WorkspaceOpenOutcome` serde enum: `ready` / `migrated` / `recovery-required` / `safe-mode`
  - `SafeModeSession` on `WorkspaceState` (path + id→path registry, no DB)
  - `open_workspace_sync` → `Result<WorkspaceOpenOutcome, AppError>`

- [ ] **Step 1: Write failing tests** for opaque candidates, Safe Mode open returning structured Ok without authority, and with_db failing under Safe Mode
- [ ] **Step 2: Implement recovery module + state/open wiring**
- [ ] **Step 3: Run tests green; commit**

### Task 2: Restore-by-ID pipeline

**Files:**
- Modify: `recovery.rs`, `backup_restore.rs`
- Test: extend `workspace_safe_mode_outcome.rs` / `backup_restore` tests

**Interfaces:**
- Produces: `list_safe_mode_candidates`, `verify_recovery_candidate`, `restore_recovery_candidate`, `export_safe_mode_diagnostics`, `retry_safe_mode_migration`, `quarantine_live_database`

- [ ] **Step 1: Failing tests** for path escape reject, checksum invalid, migration-snapshot restore, automatic-backup restore
- [ ] **Step 2: Implement ID resolve → workspace confine → regular file → manifest/checksum → disposable preflight → exclusive lease → atomic restore**
- [ ] **Step 3: Green + commit**

### Task 3: Release-schema fixtures + WAL + subprocess crash

**Files:**
- Create: `src-tauri/crates/grimodex-db/src/bin/migration-crash-harness.rs`
- Create: `src-tauri/crates/grimodex-db/tests/release_schema_fixtures.rs`
- Create: `src-tauri/crates/grimodex-db/tests/migration_subprocess_crash.rs`
- Modify: `Cargo.toml` ([[bin]])

- [ ] **Step 1: Fixture builder** seeding Project/Folder/Scene body/Codex/Chronicle/FTS/AI audit/app_settings + dirty WAL commit
- [ ] **Step 2: Assert** old release DB migrates; WAL-only commit appears in migration snapshot
- [ ] **Step 3: Subprocess harness** kill after snapshot / after staged migrate / after replace / before reopen; reopen enters RecoveryRequired or healthy recovery path
- [ ] **Step 4: Commit**

### Task 4: N-API + IPC contract

**Files:**
- Modify: `electron/native/grimodex-node/src/lib.rs`, `electron/shared/ipcContract.ts`, `electron/shared/ipcContract.test.ts`
- Follow `/add-electron-command` for new recovery commands

**Commands:**
- `open_workspace` returns `WorkspaceOpenOutcome`
- `list_recovery_candidates`, `verify_recovery_candidate`, `restore_recovery_candidate`, `export_safe_mode_diagnostics`, `retry_safe_mode_migration`, `quarantine_live_database`

- [ ] **Step 1: Contract tests red**
- [ ] **Step 2: Wire N-API + IPC**
- [ ] **Step 3: `pnpm test:electron --run` green; commit**

### Task 5: Recovery Shell UI

**Files:**
- Create: `src/features/workspace/recovery/` (RecoveryShell, types, api)
- Modify: `App.tsx`, `workspace/store.ts`, `workspaceOpenRequest.ts` (rename FE outcome if needed)

- [ ] **Step 1: Store tests** — Safe Mode skips hydration; Recovery view set
- [ ] **Step 2: Recovery Shell** lists candidates by ID; restore / quarantine / retry / diagnostics
- [ ] **Step 3: Frontend tests + commit**

### Task 6: CI `migration-recovery-gate`

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add job** running supervisor unit/integration, failpoints, fixtures, WAL, subprocess crash, Safe Mode IPC contract, Recovery Shell tests
- [ ] **Step 2: Keep Windows supervisor smoke** (fresh / legacy / restore) in Windows job
- [ ] **Step 3: Commit + push + PR**

## Gate A2 PASS checklist (verification)

- [ ] Migration failure preserves old DB
- [ ] Rollback old schema not published to normal app
- [ ] Newer schema opens Safe Mode
- [ ] Safe Mode blocks generic SQL / AI / project hydration
- [ ] Automatic backup + migration snapshot both restore via opaque ID
- [ ] Uncheckpointed WAL commits preserved in snapshot
- [ ] Process kill → next open enters recovery path
- [ ] Linux migration-recovery-gate green; Windows smoke green
