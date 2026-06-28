# 作中年表 — 本格暦化 設計書（2026-06-28）

## 背景

作中年表(Chronicle)は P0(#188)〜P4g(#199) で「暦ライト」（`daysPerYear` ＋季節境界のみ・
月/曜日/開始年なし）として意図的に最小実装された。出来事の時刻は `startTime`/`endTime` =
「紀元からの日数」整数（時刻なし）、x軸順は手動 fractional-index `ordinal`。

オーナー要望により、この「暦ライト（再提案禁止）」凍結を**明示的に解除**し、本格暦へ拡張する。

## 確定事項（2026-06-28・ユーザー回答）

1. **暦の月**＝月ごとに日数を配列で保持。`startYear` と `weekdayNames` も追加。
   `daysPerYear` は月長合計から導出。
2. **曖昧な日時**＝年/月/日の部分指定＋「季節のみ」指定を許可。**加えて時刻(時:分)も任意**で持つ
   （推理小説等の時刻精度需要）。相対表現（「〜の3年後」）は対象外。
3. **出生**＝単独チェックボックス廃止 → 出来事の**種別(kind)ドロップダウン**
   （汎用/出生/死亡/即位…）の一項目へ統合。`kind=birth` は年齢計算の基準点として現状踏襲。

## ターゲット・データモデル

### project_calendar（拡張）
| 列 | 型 | 説明 |
|---|---|---|
| `startYear` | INTEGER | 暦の開始年ラベル。day番号 0 = startYear の最初の月の1日 |
| `months` | JSON `[{name,days}]` | 月ごとの日数（31/28/… や独自暦の月長差を表現） |
| `weekdayNames` | JSON `string[]` | 例 `[月,火,水,木,金,土,日]`。週長 = 配列長 |
| `daysPerYear` | INTEGER | **導出値**（Σ months.days）。`seasonOf` と後方互換のため列は残置・保存時に再計算 |
| `seasonBoundaries` | JSON（既存） | 変更なし。年内通日基準の季節境界 |

### events（拡張）
`startTime`/`endTime`（日数整数）は **sort/季節/年齢/2か所同時の正本**として不変。追加：
| 列 | 型 | 説明 |
|---|---|---|
| `startMinute` / `endMinute` | INTEGER null | 0..1439 時刻（24h時計）。null=時刻未指定 |
| `startGranularity` / `endGranularity` | TEXT | `none\|season\|year\|month\|day\|time` |
| `kind` | TEXT | `generic\|birth\|death\|coronation\|…`（単独checkbox→dropdown）。`birth`=年齢基準 |

- 部分日付は「日数整数＋粒度フラグ」で保持。季節のみ指定 = 粒度`season`＋日数を当該年の季節開始日へ写像。
- UI/スナップショットは粒度に応じて整形：`1247年` / `1247年5月` / `1247年5月12日 14:30` / `1247年・春`。
- **x軸順**＝日付があれば日付(startTime,startMinute)から導出、無ければ従来 `ordinal` フォールバック。

### chronicleTime エンジン（追加関数）
- `calendarDaysPerYear(cal)` = Σ months.days
- `dayNumberToDate(dayNum, cal)` → `{year, monthIndex, dayOfMonth, dayOfYear, weekdayIndex}`
- `dateToDayNumber({year, monthIndex, dayOfMonth}, cal)` → 整数
- `formatChronicleDate(dayNum, minute, granularity, cal, locale)` → 表示文字列
- `seasonOf`（既存・年内通日基準）は不変

## 移行（migration）
- 既存 events：`startTime`/`endTime` 整数はそのまま。`*Granularity` は null → 読出時 `day`（startTime非null）/ `none`（null）扱い。`*Minute` は null。
- 既存 calendar：`months`/`weekdayNames`/`startYear` null → フォールバック（months 未定義時は年内通日のみ表示・startYear=0）。`add_column_if_missing` で既存ユーザー保護（P0 で events 作成済みユーザーがいる）。

## フェーズ計画（branch+PR 分割）
- **P1 暦+日付エンジン**：schema 拡張（＋ Rust `migrate.rs` ミラー）／`chronicleTime` 変換・整形・週末算出／`projectSnapshotScopes`＋browser-mock SCHEMA_DDL＋round-trip 回帰。
- **P2 UI**：暦エディタ拡張（月リスト/曜日/開始年）／インスペクタに架空暦駆動の日付＋時刻ピッカー（shadcn Popover＋独自グリッド・グレゴリオ DatePicker は不可）／主人物=character・場所=location で絞った共通 Codex コンボボックス／kind ドロップダウン。
- **P3 注入+整合**：確度ラベル→「日付の確度」＋ `chronicleSnapshot` へ日付/確度注入（TS＋Rust parity＋fixture）／年齢チェックを kind=birth 基準で維持。
- **P4 追随**：events RAG 索引テキスト・MCP parity・i18n 1:1 確定。

## 影響範囲ゲート（取りこぼし=データ消失/CI落ち）
- `projectSnapshotScopes` 登録＋browser-mock `SCHEMA_DDL`＋スナップショット round-trip 回帰（過去にデータ消失事故）。
- `chronicleSnapshot.ts`(TS) と `chronicle_snapshot.rs`(Rust) の fixture parity（`fixtures/chronicle-snapshot/*.json` deep-equal が CI gate）。
- 季節/年齢/2か所同時チェックの日数計算が暦拡張に追随。
- i18n 1:1（kind/precision/暦ラベル）、`EventKind`/`EventPrecision` 型、`EVENT_PRECISIONS`。
- agent/MCP ツールが date/kind フィールドを露出する場合 READ_ONLY/MUTATING 登録サイトと EXPECTED_* テスト。

## 検証済み波及計画（2026-06-28 Workflow `wf_1a54533f-f5c`・7 finder＋完全性 critic）

### フェーズ別チェックリスト（gate=CI/parity/snapshot 必須）
**P1 schema/migration**
- `src/db/schema.ts`: events +startMinute/+endMinute(int null)・+startGranularity/+endGranularity(text CHECK)／`EVENT_GRANULARITIES` 新規／`EVENT_KINDS` 拡張／projectCalendar +startYear/+months(JSON)/+weekdayNames(JSON)。【gate】
- `src-tauri/src/database/migrate.rs`: events/project_calendar の CREATE 拡張＋**`add_column_if_missing` 7 本（events 4・calendar 3）**。【gate・最重要】
- `src/lib/browser-mock.ts` `SCHEMA_DDL`: events 4 列・calendar 3 列・kind CHECK を migrate.rs と完全一致で追加。【gate】

**P1b 暦/日付エンジン**
- `src/features/chronicle/chronicleTime.ts`: `ChronicleCalendar` に startYear/months/weekdayNames／`calendarDaysPerYear`・`dayNumberToDate`・`dateToDayNumber`・`weekdayOf`・`formatChronicleDate` 追加（純関数・seasonOf 不変）。

**P2 永続化 API**
- `src/features/chronicle/api.ts`: EventRow＋4 列・normalizeEvent(snake/camel)・createEvent/updateEvent Pick／CalendarRow＋3 列・get/upsertProjectCalendar。【gate】
- `src/features/agent-writes/event.ts`: AgentEventCreate/UpdateInput＋4 列・kind 拡張。【gate】

**P2a UI**
- `ChronicleInspector.tsx`: people を **people(character)/locations(location) に分割**（現状バグ＝場所欄に全 Codex）／主人物=character・場所=location ピッカー／kind を checkbox→**select**(EVENT_KINDS)／時刻入力＋granularity select。
- `ChroniclePanel.tsx`: entries を type で character/location に分け Inspector へ両 props。
- `ChronicleCalendarEditor.tsx`: months 行エディタ・weekdayNames・startYear。

**P3 注入＋parity**
- `chronicleSnapshot.ts`: SnapshotTime+precision／derive で最保守則集計／LABELS.precision／renderAtLevel に確度行（≤600tok）。
- `src-tauri/crates/grimodex-mcp/src/chronicle_snapshot.rs`: EventInput+precision/time、CalendarInput+startYear/months(MonthDef)/weekdayNames、SnapshotTime+precision、derive parity。
- `chronicle.rs`/`db.rs`/`server.rs`: SELECT/INSERT/構造体/JsonSchema/valid_kind 拡張。
- `agent_writes.rs`: payload＋collect/apply snapshot SQL に 4 列＋precision。

**P3a i18n**
- `ja/en.json`: precisionLabel「確度」→「日付の確度」／kindLabel＋kind 各値／granularity 各値／startMinute/endMinute ラベル。**EVENT_KINDS/EVENT_GRANULARITIES の全値に 1:1 キー必須**。

**P3b fixtures/parity・round-trip**
- `fixtures/chronicle-snapshot/*.json`(3): events に precision・calendar に startYear/months/weekdayNames・expected.time.precision。【TS↔Rust deep-equal gate】
- `projectSnapshotApi.test.ts`: 新 7 列の save/restore round-trip 回帰。【gate】

**P4 agent tools**
- `toolDefinitions.ts`/`chronicleReadTools.ts`/`chronicleWriteTools.ts`/`toolExecutors.ts`/`aiLiveHarness.ts`＋各 `*.test.ts`: 新パラメータ・kind 列挙を **EVENT_KINDS 定数参照**へ（ハードコード排除）。READ_ONLY/MUTATING の数は不変。

### リスク登録簿（critic・データ消失/CI落ち直結）
1. **add_column_if_missing 漏れ→既存 DB が新列を得ず null 参照クラッシュ**（最優先）。
2. fixture JSON が schema と乖離→TS/Rust snapshot parity gate ブロック。
3. **kind ハードコード 4+ 箇所**（chronicleWriteTools/toolDefinitions/chronicleReadTools/Rust valid_kind）→必ず EVENT_KINDS 参照に。
4. **ChroniclePanel people/locations フィルタ未分割バグ**→誤った codex 紐付け。
5. Rust EventInput/CalendarInput が新フィールドを deserialize しないと snapshot が読めない。
6. browser-mock SCHEMA_DDL を migrate.rs と一致させないとテスト DB 崩れ。
7. CHECK 制約と EVENT_GRANULARITIES/EVENT_KINDS の値ずれ→INSERT 失敗。

## 実装完了状況（2026-06-28・branch `feat/chronicle-full-calendar`）
全フェーズ実装・各フェーズ green でコミット済（未 PR）。
- **P1**(78b75a1a) schema/migration＋暦・日付エンジン（chronicleTime TDD）。
- **P2**(adc2ef4a) UI=CodexEntryPicker(種別フィルタ)・EventDateEditor(暦駆動 粒度別 年/月/日/季節/時刻)・kind ドロップダウン・暦エディタ(月/曜日/開始年)・people/locations 分割。
- **P3**(0f2aca2a) 日付の確度を snapshot へ注入（TS↔Rust parity・fixtures exact/approx/unknown/null・intro 明記）。
- **P4**(055ab18c) 新フィールドを tracked-write(agent_writes 全SQL)＋agent ツール(create/update/get_event_detail)へ配線・kind→EVENT_KINDS。
  - **重要**: UI 手動編集(uiUpdateEvent)も Rust agent_event_update を通るため、P4 の配線がないと粒度/時刻編集が永続化されない（P2 の潜在ギャップを P4 で解消）。

**機械検証（全 green）**: tsc / chronicle+revision+agent-writes / chat(agent+contextBuilder) / cargo test agent_writes(round-trip)+grimodex-mcp(128) / fixtures parity(TS+Rust) / eslint / clippy --all-targets。
**残（非ゲート・要別作業）**: フル vitest スイート＋browser test＋ライブ LLM QA（実機・API キー必須）。MCP(grimodex-mcp)の write/detail への minute/granularity 露出（in-app 専用で出荷・MCP は snapshot 確度のみ parity）。`statBuilder` 等の formatChronicleDate を Rust へ移植した完全日付注入（現状は season＋確度のみ注入・日付整形は UI/TS 専用）。

## 確定したギャップ既定（critic gaps への回答）
- **kind 初期セット** = `generic`/`birth`/`death`/`accession(即位)`（最小・EVENT_KINDS 定数経由で後付け拡張可）。
- **weekday 意味論** = 独立参照配列。週長=配列長、`weekdayOf(dayNum)=((dayNum%wl)+wl)%wl`。daysPerYear と割り切れる必要なし。day 0=index 0。
- **月日数の制約** = days≥1 の正整数・上限なし。daysPerYear は months 有時 Σ 導出・空時は手入力値フォールバック。
- **precision 集計（snapshot）** = 最保守則 `unknown > approx > exact`。
- **時刻ピッカー UX** = インスペクタは HH:MM 数値入力＋granularity select（最小）。shadcn Popover カレンダーグリッドは P2a で。
- **暦エディタ months/weekday** = 季節行と同型のインライン行エディタ（name＋days・追加/削除）、weekdayNames はインライン配列、startYear は数値。
- **2か所同時の分単位精緻化** = 当面は日数粒度のまま（時刻は表示/注入用）。将来 follow-up。
- **季節のみ指定で年なし** = 当面は年必須・年なしは ordinal フォールバック。
