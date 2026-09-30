# Chronicle HOLD P1 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HOLD レビューの P1（＋必須 CI 赤／関連 P2）を直し、解析→承認→取り込み→Undo/Redo の製品経路が Native 正本で成立するようにする。

**Architecture:** Renderer の Zustand／メモリ Map は投影キャッシュに留め、承認・Revision・Artifact・ProposalSet・Task 失敗はすべて Native DB を正本とする。Commit／Decision／Lease／Undo の整合は同一トランザクションまたは明示的な順序保証で fail-closed にする。

**Tech Stack:** Electron IPC / N-API / grimodex-db (Rust+SQLite) / React+Zustand / Vitest / cargo test

## Global Constraints

- branch-first: 現ブランチ `cursor/5deb9455` 上で作業（新規ブランチ不要）
- commit はユーザー明示依頼があるまで作らない
- renderer は `window.grimodex` / typed invoke のみ。Node/N-API 直 import 禁止
- 新規 IPC は `electron/shared/ipcContract.ts` 正本＋N-API＋テストまで一括
- `local-proposal-*` / `local-rev-*` / `crypto.randomUUID()` による Revision 捏造を製品経路から除去
- 日本語で設計メモ・進捗を書く

---

### Task 1: CI — Prettier / Clippy / Hook 警告

**Files:**
- Modify: `src/application/narrative-extraction/extractionCoordinator.ts`
- Modify: `src/application/narrative-extraction/extractionCoordinator.test.ts`
- Modify: `src/application/narrative-extraction/aiTasks/runObservationExtractionTask.ts`
- Modify: `src/features/chronicle/ChronicleProposalReview.tsx`
- Modify: `src-tauri/crates/grimodex-db/src/narrative_extraction/chronicle_operations.rs`
- Modify: `src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs`

- [ ] **Step 1:** `pnpm exec prettier --write` で上記 TS 3 ファイルを整形
- [ ] **Step 2:** `ChronicleProposalReview` の `proposals` を `useMemo` で安定化（空配列はモジュール定数）
- [ ] **Step 3:** Clippy: `is_ascii_lowercase/uppercase`、`map(parse_json_column)`、`apply_chronicle_event_create` 引数を Context struct 化
- [ ] **Step 4:** `pnpm exec prettier --check` 対象＋ `cargo clippy --manifest-path src-tauri/Cargo.toml -p grimodex-db --all-targets -- -D warnings` が通ることを確認

### Task 2: Lease 期限を日時として比較

**Files:**
- Modify: `src-tauri/crates/grimodex-db/src/narrative_extraction/task_leases.rs`
- Test: `src-tauri/crates/grimodex-db/tests/narrative_extraction.rs`（または lease 専用テスト）

- [ ] **Step 1:** 失敗するテストを追加（同日過去の RFC3339 lease が `datetime('now')` 空白形式より「未期限切れ」と誤判定される現状を再現）
- [ ] **Step 2:** 全 `lease_expires_at < datetime('now')` を `julianday(lease_expires_at) < julianday('now')` に置換（SELECT 候補＋UPDATE WHERE）
- [ ] **Step 3:** 同日過去／同日未来／UTC 日付境界／期限切れ後 finish 拒否をテスト

### Task 3: Decision / Revision OCC

**Files:**
- Modify: `src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs` (`append_decision`, `append_revision`)
- Modify: `src-tauri/crates/grimodex-db/src/narrative_extraction/models.rs`（必要なら `expected_current_revision_id`）
- Test: `src-tauri/crates/grimodex-db/tests/narrative_extraction.rs`

- [ ] **Step 1:** 失敗テスト: 古い revision への approve が status=approved かつ current=最新のままになり、未承認最新が Apply 可能になる競合を再現
- [ ] **Step 2:** `append_decision` で ProposalSet JOIN により run/project を検証し、同一 TX で `current_revision_id = requested_revision_id` を必須化
- [ ] **Step 3:** `append_revision` に `expectedCurrentRevisionId` OCC を追加（不一致は fail-closed）
- [ ] **Step 4:** IPC / nativeApi / renderer 呼び出し側に expected を伝播

### Task 4: Undo → Redo 後の再 Undo

**Files:**
- Modify: `src-tauri/crates/grimodex-db/src/narrative_extraction/undo.rs`
- Test: `src-tauri/crates/grimodex-db/tests/narrative_extraction.rs`

- [ ] **Step 1:** 失敗テスト: Apply → Undo → Redo → Undo が `NEX_COMMIT_EVENT_EDITED` になる
- [ ] **Step 2:** Redo 成功時に journal の after snapshot（version 含む）を live 状態へ更新
- [ ] **Step 3:** 2 巡以上の Undo/Redo が通ることを確認

### Task 5: Observation localId の Window 再採番

**Files:**
- Modify: `src/application/narrative-extraction/extractionCoordinator.ts`（observe 収集ループ）
- Modify: `src/features/chronicle/extraction/windowExtractor.ts`（必要なら prefix ヘルパ）
- Test: `src/application/narrative-extraction/extractionCoordinator.test.ts` 等

- [ ] **Step 1:** 失敗テスト: 2 Window が共に `obs-1` を返すと後勝ちで欠落する
- [ ] **Step 2:** 受信時に `window-{n}:obs-...` 形式へ決定的再採番。結合後に一意性検査して重複なら throw
- [ ] **Step 3:** clustering / synthesis / planner の Map が衝突しないことをテスト

### Task 6: Task 例外時に fail_task

**Files:**
- Modify: `src/application/narrative-extraction/extractionCoordinator.ts`
- Test: `src/application/narrative-extraction/extractionCoordinator.test.ts`

- [ ] **Step 1:** 失敗テスト: claim 後 `executeTask` throw でも `narrativeExtractionFailTask` が呼ばれない現状
- [ ] **Step 2:** claim 後を try/catch で囲み、同一 runId/taskId/attemptId/leaseOwner で `narrativeExtractionFailTask` を呼んでから再 throw
- [ ] **Step 3:** 再試行可能／終端失敗を payload で区別（既存 FailTaskPayload に合わせる）

### Task 7: ProposalSet 保存完了まで Run を completed にしない

**Files:**
- Modify: `src/application/narrative-extraction/extractionCoordinator.ts`
- Modify（必要なら）: `src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs` (`maybe_complete_run`)
- Test: coordinator + Rust

- [ ] **Step 1:** 失敗テスト: 最終 task finish 後・ProposalSet 保存前に Run が completed になる
- [ ] **Step 2:** proposals artifact 生成後、finish 前に `saveChronicleProposalSet` し proposalSetId を artifact に bind。または最後の finish を ProposalSet 保存後に遅延
- [ ] **Step 3:** プロセス途中死を想定し、completed かつ ProposalSet 無しの状態を作れないことを検証

### Task 8: 承認・編集の Native 永続化（製品経路）

**Files:**
- Modify: `src/features/chronicle/ChronicleProposalReview.tsx`
- Modify: `src/features/chronicle/chronicleExtractionApi.ts`（swallow 撤廃、fail-closed）
- Modify: `src/features/chronicle/chronicleExtractionStore.ts`（必要なら async ラッパは API 側）
- Test: Review / Store / Dialog（モック無し or Native stub で永続呼び出し必須）

- [ ] **Step 1:** 失敗テスト: approve が `appendDecision` を呼ばない／revise が randomUUID revision を使う
- [ ] **Step 2:** 編集 → `recordChronicleProposalRevision`（Native revisionId のみ採用）→ store 更新
- [ ] **Step 3:** 承認／却下／保留 → 最新 revision で `recordChronicleProposalDecision` → 成功後のみ store 更新
- [ ] **Step 4:** 一括承認も逐次永続化し途中失敗を UI に出す
- [ ] **Step 5:** `record*` の try/catch swallow を削除しエラーを伝播

### Task 9: コールドスタート Review 復元（Native read API）

**Files:**
- Create/Modify Rust: `get_run_review_bundle`（artifacts + proposal set + proposals + current revision + latest decision）
- Modify: `electron/shared/ipcContract.ts`, N-API, `nativeApi.ts`
- Modify: `src/application/narrative-extraction/artifactRepository.ts`
- Modify: `src/features/chronicle/chronicleExtractionApi.ts`
- Test: 統合（Map/Zustand/module cache クリア後に restore → approve → apply）

- [ ] **Step 1:** IPC `narrative_extraction_get_run_review_bundle` を add-electron-command 手順で追加
- [ ] **Step 2:** `loadInlineJsonArtifact` は Map miss 時に Native bundle／artifacts から hydrate
- [ ] **Step 3:** `getChronicleExtractionReview` / `restoreChronicleExtractionReview` は DB のみで投影再構築（local-* fallback 除去）
- [ ] **Step 4:** コールド復元 → 承認永続化 → Apply の統合テスト

### Task 10: P2 — operations/applications 対応検証 と failed commit 監査

**Files:**
- Modify: `src-tauri/crates/grimodex-db/src/narrative_extraction/commit.rs`
- Test: narrative_extraction tests

- [ ] **Step 1:** operations と applications の長さ／同 index の proposalId・revisionId 一致を Native で必須検証
- [ ] **Step 2:** Apply 失敗時は domain 書込を rollback したうえで、別 TX で commit status=failed を残す

### Task 11: 検証ゲート

- [ ] Frontend: 変更ファイルの prettier/eslint + 関連 vitest
- [ ] Electron: IPC 契約テスト（Task 9 実施時）
- [ ] Rust: `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db`
- [ ] Clippy: grimodex-db `-D warnings`
