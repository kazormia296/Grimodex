# MP-7 decisions

## Precheck

脅威モデルは U-1（2026-11-19 確定）の範囲内。信頼する主体は migration と、7b の main 専用 typed writer。renderer の汎用 SQL は信頼しない。新しい送信先や保存範囲は加えない。根拠は [脅威モデル](mastra-migration-threat-model.md) §1、§2.1 の X5/X7/X10、§3 の T7/D9/D10 と、計画 §12.1 の P18。

受入れは、6 表すべての D2a `closed` 登録と完全性、汎用 SQL の拒否、旧 schema からの migration、FK/cascade、project 削除、clock trigger の追加を確認する。FK cascade を使い、既存 migration の clock trigger は維持する。U-10/U-11（2026-11-26 回答済み）に従い、schema は 47、`chat_messages` と `chat_sessions` に列を足さず、D2a の版を 1 上げる。

## Decisions

- **DR-MP7-1 — schema version:** `SCHEMA_VERSION` を唯一の Rust 定数とする。直前 marker 46 と target marker 47 は直書きで、次の版上げで止まる guard を保つ。
- **DR-MP7-2 — message parts:** `mastra_message_parts(message_id PK/FK → chat_messages.id ON DELETE CASCADE, parts_json TEXT NOT NULL)`。1 message につき 1 JSON document。JSON 形式を CHECK する。
- **DR-MP7-3 — thread metadata:** `mastra_thread_metadata(session_id PK/FK → chat_sessions.id ON DELETE CASCADE, metadata_json TEXT NOT NULL)`。metadata は JSON object として検査する。session の JSON は専用表に置く。
- **DR-MP7-4 — resources:** `mastra_resources(id PK, project_id UNIQUE/FK → projects.id ON DELETE CASCADE, working_memory TEXT, metadata_json, created_at TEXT, updated_at TEXT)`。project ごとに 1 resource とし、Mastra の resource ID は保持する。metadata は JSON object。
- **DR-MP7-5 — observational memory:** `mastra_observational_memory` は `id, scope, thread_id, project_id, resource_id, created_at, updated_at, last_observed_at, origin_type, generation_count, superseded_by, active_observations, buffered_observation_chunks_json, buffered_observations, buffered_observation_tokens, buffered_message_ids_json, buffered_reflection, buffered_reflection_tokens, buffered_reflection_input_tokens, reflected_observation_line_count, observed_message_ids_json, observed_timezone, total_tokens_observed, observation_token_count, pending_message_tokens, is_reflecting, is_observing, is_buffering_observation, is_buffering_reflection, last_buffered_at_tokens, last_buffered_at_time, config_json, metadata_json` を保持する。`thread_id` は `chat_sessions.id`、`project_id` は `projects.id` に cascade する。scope の CHECK で thread/resource のどちらか一方を必須にする。resource ID は別列で保持する。`(thread_id, updated_at)` と `(project_id, updated_at)` の index で scope lookup を行う。
- **DR-MP7-6 — vectors:** `mastra_memory_vectors(index_name, id, vector BLOB, metadata_json, message_id)`。主キーは `(index_name, id)` で index 間の ID 衝突を避ける。metadata は JSON object、`message_id` は `chat_messages.id` に cascade する。`message_id` index で message delete の子行検索を行う。
- **DR-MP7-7 — access:** 6 表は D2a `closed`。汎用 SQL の read/write は許可しない。書込み API と N-API は 7b に送る。
- **DR-MP7-8 — clock:** 新表を既存の write-clock migration の対象に含める。clock trigger を除外しない。
- **DR-MP7-9 — D2a wire:** 台帳 version は 3。Electron main の受入れ値と Native fixture も同じ版に揃える。
- **DR-MP7-10 — vector index dimensions:** `mastra_memory_vector_indexes(index_name TEXT PRIMARY KEY, dimension INTEGER NOT NULL CHECK(dimension > 0))` を D2a `closed` に追加する。vector index ごとに次元を固定するため（U-11・P18 と同じく closed）。

## Impact matrix

| Flow | Owner → contract → consumer | 保つ境界 / fallback | Verification |
| --- | --- | --- | --- |
| Migration | `grimodex-db` → schema 47 + checkpoint → workspace open / restore | 46 から full migration。部分 schema は checkpoint で拒否し再 migration。 | 旧 marker migration、FK/cascade、clock trigger 数 |
| D2a status | DB ledger → Native JSON v3 → Electron main gate | unknown version は既存どおり unavailable。新6表は closed。 | Native/Electron policy tests、generic SQL rejection |
| Schema contract | Rust generator → generated JSON → Drizzle parity test | 6表は Rust-only。renderer schema/read/write は追加しない。 | schema-contract parity |

## 未確認 / 7b への申し送り

- migration は schema と削除境界だけを確定する。Mastra adapter の往復、JSON の意味検証、vector の符号化、thread と resource の ID 写像、message 削除時の OM/WM purge は 7b/後続 lane で決めて試験する。
- Drizzle は renderer の読み定義を確認し、新表を renderer が読む必要がなければ追加しない。
