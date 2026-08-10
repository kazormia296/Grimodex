# Release Gate B — Narrative Runtime Authority / SQL Protection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native 境界で Narrative Engine を fail-closed に止め、untrusted SQL から protected domain writer を守り、設定欠損時も `review-only` へ倒す。

**Architecture:** schema-neutral。Runtime Mode は `app_settings`、Writer 保護は JSON registry + SQLite authorizer、`SqlOrigin` で Renderer／MCP／Trusted を分岐。Narrative Extraction 本体は未マージのため guard API を先に公開し、stack rebase 時に配線する。

**Tech Stack:** Rust (`grimodex-db`)、TypeScript runtime policy、Node CI validator、既存 Electron／Tauri／MCP DB 経路

## Global Constraints

- schema version を増やさない（sidecar / app_settings のみ）
- AI policy の fail-open は維持し、Narrative だけ fail-closed
- Undo は emergency disable 中も許可
- 既存 domain の Drizzle cutover は #493〜#499 側。Gate B は registry に `ciEnforce` を持ち、cutover 済み table だけ CI 0 件を強制する
- production build に test-only 経路を入れない

---

## Task 1: Runtime Policy (Rust)

**Files:**
- Create: `src-tauri/crates/grimodex-db/src/narrative_runtime_policy.rs`
- Create: `src-tauri/crates/grimodex-db/tests/narrative_runtime_authority.rs`
- Modify: `src-tauri/crates/grimodex-db/src/lib.rs`

- [ ] RED: missing/corrupt/unknown → review-only、env override 優先、Undo 許可
- [ ] GREEN: `require_*_allowed` 実装
- [ ] Commit

## Task 2: SqlOrigin + Protected Writers

**Files:**
- Create: `policies/narrative/protected-writers.json`
- Create: `src-tauri/crates/grimodex-db/src/protected_writers.rs`
- Modify: `src-tauri/crates/grimodex-db/src/execute.rs`
- Modify: `src-tauri/src/commands/db.rs`

- [ ] RED: untrusted UPDATE/INSERT on protected table denied; trusted allowed
- [ ] GREEN: authorizer + statement classifier
- [ ] Tauri `db_execute*` → renderer origin
- [ ] Commit

## Task 3: TypeScript + CI

**Files:**
- Create: `src/features/narrative-extraction/runtime/narrativeRuntimePolicy.ts` (+test)
- Create: `src/features/narrative-extraction/maintenance/maintenanceFlags.ts` (+test)
- Create: `scripts/quality/validate-narrative-writers.mjs` (+test)
- Modify: `package.json`, `.github/workflows/ci.yml`, `evals/impact-map.yaml`, `scripts/quality/impact-map.mjs`

- [ ] RED/GREEN TS policy defaults
- [ ] CI script + rust/frontend hooks
- [ ] Commit / push / PR
