# 作中年表 本格暦化 — フォローアップ3件 実装計画

branch: `feat/chronicle-full-calendar`（本格暦化 P1〜P4 の続き）
設計の正本: `docs/superpowers/specs/2026-06-28-chronicle-full-calendar-design.md`
関連メモ: [[grimodex-chronicle-feature]]

本格暦化 P1〜P4 で残った非ゲート3件を完了する。すべて既存出荷物の
**parity 補完**と**橋渡し**であり、確定済みのコア設計（独立 chronicle パネル・
Event 非 scene-anchored・読む順は日付と独立）は変えない。

---

## タスク1: grimodex-mcp の write/detail への minute/granularity 露出

**現状**: 新フィールド `startMinute/endMinute`(int 0..1439 null可) と
`startGranularity/endGranularity`(`none/season/year/month/day/time`) は
in-app agent ツール（`agent_writes.rs` 経由）には P4 で配線済みだが、
別クレート `grimodex-mcp` の create/update/detail には未露出。MCP は確度
snapshot のみ parity。

**正本テンプレート**（mirror 元）= `src-tauri/src/commands/agent_writes.rs`
（payload struct → CREATE INSERT 17列 → UPSERT ON CONFLICT → collect snapshot
json_object → 動的 UPDATE SET）。

**編集サイト**（`grimodex-mcp`）:
- `src/db.rs`
  - `ChronicleEventRow`（+ start_minute/end_minute: Option<i64>, start_granularity/end_granularity: String）
  - `map_chronicle_event`（列追加）
  - `chronicle_list_events` SELECT 列追加
  - `ChronicleCreateInput`（+4）/ `INSERT INTO events`（+4列+placeholder）
  - `ChroniclePatch`（+4）/ `chronicle_update_event` 動的 SET（+4分岐）
  - `collect_event_snapshot` の json_object（camelCase キー +4）
  - `CREATE TABLE events`（+4列 DEFAULT 'none'/null）
- `src/tools/chronicle.rs`
  - `CreateEventParams` / `UpdateEventParams`（+4 Option）
  - `EventDetail` struct（+4）＋ `get_event_detail` で代入
  - `chronicle_create_event` / `chronicle_update_event` 呼び出しへ受け渡し
- `src/server.rs` create_event/update_event の description 追記

**テスト(TDD)**: `grimodex-mcp` の create→get_event_detail round-trip で
minute/granularity が往復することを assert（Rust test）。

**検証**: `cargo test --no-default-features -p grimodex-mcp` / clippy。

---

## タスク2: formatChronicleDate の Rust 移植 → 整形済み日付の AI 注入

**現状**: snapshot は season ＋ 確度のみ注入。`formatChronicleDate`(TS)は
P1 で実装済だが Rust 未移植・注入未配線。

**設計**: 整形済み日付は **構造化 snapshot の `time.formattedDate`** とする
（Rust の唯一の出力＝構造化 snapshot に載せる＝parity gate が効く）。
言語別文字列だが season 名同様 derive で確定する（render は値を読むだけ）。

- アンカーを拡張: `ChronicleAnchor` に `startMinute`/`startGranularity` を持たせる。
  `MinEvent`(TS)/`EventInput`(Rust) も読む。`resolveSceneAnchor` が伝播。
- `ChronicleSnapshot.time` に `formattedDate: string|null` 追加。
- `deriveChronicleSnapshot` に `lang` を渡し、
  `formatChronicleDate(startTime, startMinute, startGranularity, calendar, lang)` を計算。
- render（`renderAtLevel`）は `time.formattedDate` を最優先で時刻行に出す
  （無ければ従来の season / 順序のみ）。
- **Rust 移植**（`chronicle_snapshot.rs`）: `calendar_days_per_year` / `weekday_of` /
  `day_number_to_date` / `format_time_of_day` / `format_chronicle_date` を TS と
  完全一致で移植。`CalendarInput` に `start_year`/`months`(MonthDef)/`weekday_names`
  追加。`SnapshotTime` に `formatted_date`。`DeriveInput`/`AssembleInput` に `lang`。
- **MCP calendar 読取**: `db.rs` `ChronicleCalendarRaw` + `chronicle_get_calendar` /
  `tools/chronicle.rs` `parse_calendar` を start_year/months/weekday_names まで拡張。
- **fixtures**: 既存3件は event 粒度未指定=`none`→formattedDate `null`（`expected.time`
  に追記のみ）。新規 fixture（months/startYear 付き暦＋粒度 day/time＋分）で
  整形文字列を gate。`lang` を input に追加（既定 ja）。

**検証**: vitest（chronicleSnapshot/resolveSceneAnchor/chronicleTime）/ tsc /
`cargo test --no-default-features -p grimodex-mcp`（fixtures parity）。

---

## タスク3: Scene に日時 — chronicleTime を tree_nodes と共有（橋強化・完全統合せず）

ユーザー確定: **データ模型＋AI注入＋最小UI**（フル）。命名 = **`chronicle*` 接頭辞**。
読む順(sortOrder)は日付と独立・オフページ可・複数時刻保全。Event エンティティは作らない。

**新列**（`tree_nodes`、すべて nullable）:
`chronicleStartTime`/`chronicleStartMinute`/`chronicleStartGranularity`/
`chronicleEndTime`/`chronicleEndMinute`/`chronicleEndGranularity`/`chroniclePrecision`。
granularity 既定 `'none'`、precision 既定 `'exact'`。

**3a スキーマ/マイグレーション/round-trip**:
- `schema.ts` `treeNodes` ＋ `projectSnapshotTreeNodes`（snapshot 部分集合）に列追加。
- `migrate.rs` `tree_nodes` CREATE ＋ `add_column_if_missing`×7、snapshot 表も同様。
- `browser-mock.ts` SCHEMA_DDL（tree_nodes ＋ snapshot tree_nodes）一致。
- snapshot create SELECT / restore INSERT に列追加（明示列リストなら手当て・
  動的 buildInsert なら自動）→ **復元でシーン日付が消えないこと**を round-trip test で gate。

**3b アンカー源 'scene'（TS＋Rust parity）**:
- `resolveSceneAnchor` を v2 化: 各シーンの「直接アンカー」=
  自前 chronicle 日付(granularity≠none) があれば `source='scene'`、無ければ stamped、
  無ければ前方近傍 proxy、無ければ none。明示設定時のみ 'scene' が発火するので
  stamped-only の既存挙動は不変。
- 'scene' アンカーの `ordinal`（recent/offpage/causal 用）= startTime ≤ scene.startTime の
  最大 startTime を持つ event の ordinal を合成（イベント順序空間へ橋渡し）。
- Rust `resolve_scene_anchor` を同仕様で移植。`SceneNode`/`AssembleInput` に
  scene chronicle を載せ fixtures に 'scene' ケース追加。

**3c 永続化＋AI注入配線**:
- tree_nodes load（Rust command + TS store + 型）に chronicle 列を含める。
- `assembleChronicleSnapshotText` / `buildChronicleSnapshotTextForScene`(chatStore) /
  `contextBuilder` の全送出経路へ「現在シーンの chronicle 日付」を渡し anchor に反映。

**3d UI（最小）**:
- `EventDateEditor` を再利用してシーンの chronicle 日付を閲覧/編集。
  挿入先 = シーンのプロパティ/インスペクタ（calendar コンテキストのある場所）。実装時に確定。
- 保存は既存 node 更新経路（manual provenance）。レイアウト幾何に触れるなら browser test。

**検証**: vitest（全）/ tsc / lint / `cargo check` / `cargo test --no-default-features` /
clippy --all-targets。必要なら `pnpm test:browser`。

---

## 全体方針
- 各タスクは順番に（共有ファイル db.rs / chronicle_snapshot.rs / resolveSceneAnchor.ts /
  chronicleSnapshot.ts / fixtures が重複するため並列 worktree は不可）。
- TDD（red→green）。各タスク完了時に該当検証を実行し証拠を確認。
- 全タスク後に敵対的レビュー（Workflow fan-out）→ 指摘修正 → 最終フル検証。
- commit は変更ファイルを個別 add。master 直 commit/push 禁止（branch + PR）。
