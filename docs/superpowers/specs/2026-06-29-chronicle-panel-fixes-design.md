# 作中年表(Chronicle)パネル 不具合修正＋要望 設計書

- 日付: 2026-06-29
- ブランチ: `docs/chronicle-scenecontext-timeline-design-sync`（現行ブランチ上で実装）
- 前提: PR 相当の panel 再設計（DOM pan/zoom 暦タイムライン）が既にコミット済み（HEAD=5d5efc53）。本書はその上に積む。

## 目的

ユーザー報告の不具合・要望（計 22 項目）を、既存の純関数アーキテクチャ
（chronicleAxis / chronicleTicks / chronicleLanePack / chronicleLayout /
chronicleTime / chronicleCausalBezier）を崩さずに実装する。座標数学は純関数へ、
React は描画と配線に専念、の分離を維持する。

## ユーザー確定事項（質問への回答）

1. **暦/閏年 = グレゴリオ暦を完全実装**（4/100/400 ルール）。
2. **年齢 = 満年齢/数え年の切替を追加**（既定=満年齢）。

## アーキテクチャ判断

### A. 暦エンジン（chronicleTime.ts）— 可変年長対応

現状は「1年=固定長（月長合計 or daysPerYear）」前提で `year = startYear + floor(d/dpy)`。
グレゴリオ閏年は年長が可変（365/366）になるため、以下を導入する:

- `ChronicleCalendar` に任意フィールド追加:
  - `leap?: LeapRule` — `{ kind: "none" }`（既定）/ `{ kind: "gregorian"; monthIndex: number }`。
    gregorian は暦年 Y（startYear 基準の絶対年）に対し 4/100/400 で閏判定し、`monthIndex`（既定=1月相当の2月＝index 1）に +1 日。
  - `ageReckoning?: "full" | "counting"` — 満年齢（既定）/ 数え年。
- 新ヘルパ（すべて純関数・決定性）:
  - `isLeapYear(year, cal)`, `daysInYear(year, cal)`, `monthLength(year, monthIndex, cal)`。
  - `dayNumberToDate` / `dateToDayNumber` を可変年長対応に書き換え。
    閏なし（`leap.kind!=="gregorian"`）の場合は従来の定数 dpy 高速経路を維持 → 既存テスト不変。
    閏ありは「平均年長で year を推定→累積で補正」する決定的ループ（O(1)〜数回）。
  - `computeAge(birthDay, eventDay, cal)` — 満年齢=誕生日(記念日)経過数、数え年=暦年差+1。
- 既定グレゴリオプリセット（暦エディタの「現実準拠」ボタン）:
  12ヶ月 [31,28,31,30,31,30,31,31,30,31,30,31]、`leap={kind:"gregorian",monthIndex:1}`、
  7曜日、daysPerYear=365。

**月の日数の規定（ユーザー疑問への回答）**: 月日数は暦設定で自由。グレゴリオでは
2月のみ閏年に +1。閏判定は「開始年からの相対」ではなく**作中の絶対年番号**に対する
4/100/400（startYear をずらせば実質相対にもなる）。

### B. ルーラー目盛り（chronicleTicks.ts）

- **週メイン目盛りの「年グリッド複数表示」バグ**の原因 = major グリッドが均等
  `monthDays = dpy/monthCount` を step していたため、非均等月/小数月長で実際の月境界と
  ずれる。**実際の月/年境界（`dateToDayNumber` で算出した累積位置）**に置き換える。
  これでグレゴリオ可変月長にも自動対応。
- **拡大時の月サブ目盛り**: minor が day/week 粒度のとき、月境界を独立した中目盛り
  （`subTicks`）として描画。年境界はより太い major。3 段（major=年/月ラベル・
  minor=細目盛り・月境界の中線）構成にする。

### C. マーカー/確度/エッジ（EventMarker.tsx / ChronicleViewport.tsx）

- **確度が外周線に即反映されないバグ**: 再現テストを書いてから修正。確度の視覚表現を
  外周線スタイルで一意化（exact=実線・approx=実線+淡破線リング・unknown=破線）。選択中でも
  確度が分かるよう、選択リングと確度ボーダーを別レイヤーにする。
- **因果エッジは実線**（ユーザー提案を採用）。非矛盾=実線・muted、矛盾=実線・赤・太。
  凡例の「因果の矛盾」も実線に統一。
- **フォーカス中イベントがレーンヘッダーより上に出るバグ**: gutter の z を全マーカー
  （選択時 z=9）より上へ（`z-20`）。加えてマーカー left を 0 未満にクランプ。
  → browser test で gutter が選択マーカーを覆うことを gate。

### D. レーンガター（ChronicleLaneGutter.tsx）

- **Codex ポップオーバー**: `editor/CodexPopover`（containerEl モード）を再利用。レーン名 span に
  `.codex-highlight` + `data-codex-entry-id`（codexId 保有時）を付け、gutter 要素を containerEl で渡す。
- **「追加」ボタン（ガター最後尾）**: Codex ドロップダウン（inspector と同じ laneOptions）を開き、
  選択した Codex を**空レーンとしてピン留め**（`pinnedLaneIds`／chronicleStore 永続）。
  空レーンは packLanes が捨てないよう最小高で表示し、`＋出来事` 導線を出す。
- **「未割当」レーンの割当機能**: 未割当レーン見出しに Codex ドロップダウン（inspector と同じ一覧）。
  選択中の未割当イベントを当該 Codex へ割当（`primaryCodexId` 更新）。未選択時はヒント表示。
  併せてグラフのコンテキストメニューに「レーンへ割当 ▸ Codex一覧」を用意（イベント単位）。

### E. ツールバー/凡例/暦ポップオーバー/ボタン意匠（ChronicleToolbar.tsx）

- **ボタン意匠を他パネル準拠の枠なしへ**: `rounded-lg border bg-card` を廃し、
  `rounded p-1 text-muted-foreground hover:bg-accent`（borderless）に統一。トグルは
  active で `bg-accent/text-primary`。primary「新しい出来事」のみ塗り。ズームボタンも統一。
- **凡例の種別アイコン**: マーカーと同一グリフを使用。「背景（オフページ）」は EventKind に
  存在しない（`["generic","birth","death"]`）ため**凡例から削除**。「出来事」は汎用ドット。
  因果矛盾は実線へ。確度（不確定=破線）はツールチップ説明を付す。
- **暦設定をポップオーバー化**: `ChronicleCalendarEditor` を inline パネルから
  `useAnchoredPopover` ベースのポップオーバー（暦ボタンアンカー）へ。グレゴリオプリセット
  ボタンと年齢表記（満/数え）トグルを追加。
- **「ラベル表示」に文字追加**: Tags アイコン＋「ラベル」テキスト。

### F. インスペクタ（ChronicleInspector.tsx）

- 1 行目（タイトル）は左寄せ維持。横長で間延びを解消するため、フィールド群を
  **広い時 2 カラム**（`@container`/`sm:grid-cols-2` 相当）に再構成。余白を詰める。

### G. グラフ操作（ChronicleViewport.tsx + chronicleStore + ChroniclePanel）

新規純モジュール `chronicleSnap.ts`（吸着）と `chronicleInteractions`（ヒットテスト/ドラッグ種別）を追加。

- **位置選択状態**: `selectedDay: number | null`（＋任意 `selectedLaneKey`）。空白クリックで設定し、
  縦ガイドラインを描画。「新しい出来事」はこの位置に作成。
- **空白ダブルクリックで作成**: dblclick→ `xToDay` で日を算出し当該レーンに作成、選択して inspector を開く。
- **マーカー・ドラッグ再配置**: 横ドラッグで startTime（interval は期間維持で start/end）更新。
  縦にレーンをまたぐと `primaryCodexId` を再割当。
- **期間端の拡張ドラッグ**: interval の左右端ハンドルで start/end を伸縮。
- **D&D で因果エッジ作成**: マーカーから他マーカーへドラッグで `uiAddEventRelation(cause→effect)`。ドラッグ中はガイド線。
- **グリッド吸着**: ドラッグ中の日を**見えている minor 目盛り**（無ければ 1 日）へ吸着（`chronicleSnap`）。
- **ロックモード**: ツールバーのトグル（`locked`／chronicleStore 永続）。on で上記編集系・作成系を全無効化（パン/ズーム/選択は可）。
- **コンテキストメニュー**: 既存 `components/ui/context-menu`（Radix）を流用。
  - 空白: 「ここに出来事を作成」。
  - マーカー: 「編集 / 期間化⇄点化 / レーンへ割当 ▸ / 原因に追加… / 削除」。

### H. Rust MCP パリティ（chronicle_snapshot.rs）

`day_number_to_date` / `calendar_days_per_year` / `season_of` / age を Rust が移植済み。
グレゴリオ閏＋年齢表記をフロントに入れたら、AI スナップショットの日付/年齢がドリフトするため
同等のロジック（`leap`/`age_reckoning`）を Rust 側にも移植し、`cargo test` で固定する。

### 永続化（DB）

`project_calendar` に 2 列追加（既存の `add_column_if_missing` パターン）:
- `leap_rule TEXT NOT NULL DEFAULT '{"kind":"none"}'`
- `age_reckoning TEXT NOT NULL DEFAULT 'full'`

更新点: `src/db/schema.ts`（Drizzle）/ `src-tauri/src/database/migrate.rs` /
`api.ts`（CalendarRow・getProjectCalendar・calendarFromRow・upsertProjectCalendar）/
`useSeasonConflicts.saveCalendar`。

## テスト方針

- 純関数（chronicleTime 閏・年齢、chronicleTicks 月/年境界、chronicleSnap 吸着、
  因果エッジ実線）は happy-dom 単体 TDD（red→green）。
- 幾何不変（gutter z-index ↔ 選択マーカー、ドラッグ吸着位置、期間端ハンドル位置）は
  `*.browser.test.tsx`。
- Rust 閏/年齢は `cargo test --no-default-features`。

## 実装フェーズ（コミット単位）

1. 暦エンジン（閏＋年齢）＋テスト＋DB/Rust パリティ。
2. ルーラー（実月境界＋月サブ目盛り）＋テスト。
3. マーカー/エッジ/z-index（確度反映・実線エッジ・gutter z）＋ browser test。
4. ツールバー/凡例/暦ポップオーバー/ボタン意匠/ラベル文字。
5. レーンガター（Codex ポップオーバー＋追加ボタン＋未割当割当）。
6. インスペクタ 2 カラム化。
7. グラフ操作（位置選択・dblclick 作成・ドラッグ再配置・端伸縮・因果 D&D・吸着・ロック・コンテキストメニュー）＋ browser test。
8. i18n（ja/en）追補・検証（test/tsc/lint/browser/cargo）・敵対レビュー。

## 未確定（既定で進め、要なら後で是正）

- 「追加」ボタン = 空レーンのピン留め（vs 即イベント作成）。本書では**ピン留め**を採用。
- 「未割当」割当 = 選択中イベントの割当＋コンテキストメニューの per-event 割当。
