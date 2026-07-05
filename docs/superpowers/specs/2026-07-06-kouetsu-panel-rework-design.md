# 校閲パネル リワーク設計書（受信箱モデル）

日付: 2026-07-06
ステータス: 承認済み（方向性の 4 決定はユーザー確認済み）

## 背景と課題

校閲パネルの現行構造（指摘 / 批評 / コメント / ブロッカー の 4 タブ + タブごとの独立スコープバー）には、コードで裏付けの取れた構造的な歪みがある。

1. **「指摘/批評」の分割は表示層にしか存在しない。** 両タブとも `PostEffectAnnotationPanel` / `AnnotationItem` を category フィルタ違いで共用しており、データ層に区別はない。「矛盾検出」ファミリーが整合性（指摘）と時系列整合性（批評）に割れて分類として破綻している。
2. **性格の違うタブが同格に並ぶ。** 指摘/批評 = 実行 + 結果、コメント = 対話の集約（読み取り専用）、ブロッカー = annotation を入力に取らないドメイン横断ダッシュボード。さらに疑似コメントは批評タブとコメントタブに同一 annotation が二重表示される。
3. **「除外」が場所軸に混線。** `IssuesScope = "current" | "project" | "ignored"`（`kouetsuStore.ts:5`）は場所軸とステータス軸が同一 union。persist されるため「除外」のまま終了すると次回起動も除外ビューで復帰する。スコープが current 以外だとセクションバッジが 0 になる件数バグもある。
4. **全体チェックの動線が破綻。** 最短 9 クリックで、それでも意図ドリフト（project 実行ボタンなし）・疑似コメント（scene 限定）・影響レビュー（パネル内に実行ボタンなし）は網羅できない。Rust の中止フラグはアプリ全体で単一の `AtomicBool`（`post_effect.rs:5509` 付近）であり、並走時に中止が全 run に波及する。

2026-06 の taxonomy レビューの結論（「種別過多ではなく軸の混線が真因」「検出主体でのタブ再編が north-star、defer」）と整合する。本リワークは defer されていた north-star を包含・置換する。

## 決定事項（2026-07-06 ユーザー確認）

- **案A（受信箱モデル）を採用。** トップタブを「指摘 / コメント / ブロッカー」の 3 つに再編。
- **疑似コメントはコメントタブへ一本化**（批評セクションからは撤去、実行導線ごと移設）。
- **全体チェックの既定範囲**: 疑似コメントは除外（コスト大 + scene 限定）、影響レビューは Codex 側導線のまま対象外。
- **2 フェーズ分割**: Phase 1 = UI 再編（Rust 変更なし）、Phase 2 = 全体チェック + Rust 手当て。
- **スコープは Chat パネルのスコープピッカーを流用**: 「シーン（アクティブ追従）/ フォルダ（act・章）/ プロジェクト」。フォルダ単位のチェックが新規に可能になる。

## 新構造

### トップタブ（3 つ・性格で分離）

| タブ | 性格 | 内容 |
|---|---|---|
| 指摘 | 実行 + 結果の受信箱 | 全 8 観点グループ（校正 / 誤字脱字 / 整合性 / 影響レビュー / レビュー / 意図ドリフト / メタ構造 / 時系列整合性）を折りたたみで縦積み。機械系 → 批評系の順 |
| コメント | 対話 | 人間インラインコメント + AI 疑似コメントスレッド。疑似コメントの実行ボタン（ペルソナ選択、現在シーン対象）をタブヘッダに移設 |
| ブロッカー | 次にやること | 現状維持（変更なし） |

「指摘/批評」の区別はタブではなく**グループの並び順**に降格する。一覧 → 詳細への画面遷移は導入しない（Grimodex のパネル慣習であるセクション折りたたみ型を維持）。

### 指摘タブ

ヘッダ行: **スコープピッカー + ステータスフィルタ +（Phase 2）全体チェックボタン**。

**スコープ**（`KouetsuScope`）:

```ts
type KouetsuScope =
  | { type: "scene" }                       // アクティブシーン追従（現行 current と同義）
  | { type: "folder"; anchorId: string }    // act / 章単位
  | { type: "project" };
```

- Chat の scene/folder/project モデルと同一セマンティクス。ピッカーでシーンをクリックしたらエディタ移動 + scene スコープ（Chat と同挙動）。
- scene → 既存 `CurrentScene*` ビュー（アクティブシーン追従のまま、内部変更なし）。
- folder / project → 既存 `Project*` ビュー。folder は subtree の sceneIds でフィルタ（`flattenTree` の DFS で導出）。multi 実行も同じ部分集合を `req.scenes` に渡すだけで、Rust 変更は不要。
- スコープ状態は指摘タブに 1 つ（現行の `activeIssuesScope` / `activeEditorialScope` の二重管理を廃止）。

**ステータスフィルタ**（スコープから分離）:

- `open`（既定・「開いている」）/ `dismissed`（「除外」）の 2 値チップ。
- `dismissed` 時は各観点グループが category 別 `DismissedAnnotationsView`、校正グループは `DisablesView` を表示（現行の ignored スコープの中身をフィルタに移設）。
- resolved は現行どおり open ビュー内の下部表示のまま（第 3 フィルタ値は導入しない）。

**観点グループ**:

- 現行セクション UI（ResizablePanelGroup + collapsible）を踏襲し、Issues 4 + Editorial 5 − 疑似コメント = 8 グループに統合。
- 各グループヘッダ: 件数バッジ + 個別実行ボタン（現行の筋肉記憶を維持）。
- メタ構造（lens 経路）・時系列整合性（本質的に project 全域、scene スコープ時はその旨のチップ表示）・影響レビュー（表示専用、実行は Codex 側）の特殊性は現行のまま。

**バッジ正直化 + 誤字/校正の重複解消**（taxonomy レビューの defer を同梱）:

- typo lint ルールは校正グループのみに表示・計上。誤字脱字グループ = AI 検出のみ。`LocalTypoList` 削除。`issueCounts` の意図的二重計上を廃止。
- 不変条件: **バッジ件数は現在のスコープ / フィルタで実際に表示される件数と一致する**（スコープ外で 0 固定になる嘘バッジ禁止）。

### 共有 ScopeTreePicker の抽出

- `ChatPanelHeader.tsx` 内の `flattenTree` + ツリーピッカー popover（トリガチップ + `useAnchoredPopover`）を共通コンポーネントとして抽出（例: `src/components/ui/ScopeTreePicker.tsx`）。
- Chat 側は codex / snippet のピッカータブを自前に残し、ツリー部分だけ共通化。Chat の既存テストは green を維持する。
- 校閲側はツリーピッカーのみ使用（codex / snippet タブなし）。

### store / persist migration

- `kouetsuStore`: `activeTab: "issues" | "comments" | "blocker"`、`scope: KouetsuScope`、`statusFilter`、`projectGroupBy`（現行維持）、（Phase 2）`includedEffects`。
- persist version bump + migrate: `editorial` → `issues`、`current` → `{type:"scene"}`、`project` → `{type:"project"}`、`ignored` → `{type:"scene"}` + `statusFilter:"dismissed"`。

### パネル正本への準拠

- 生 div + `data-panel-header` の自前再現をやめ、正本 `PanelHeader`（`src/features/layout/PanelHeader.tsx`）+ タブリストに載せ替える。APG tablist（roving tabindex / 矢印キー）は維持。
- `IssuesScopeBar` / `EditorialScopeBar`、`SectionHeader` ×2 のコピペ重複はリワークで自然消滅させる。

## Phase 2: 全体チェック

- 指摘タブヘッダに「全体チェック」ボタン。対象観点はポップオーバーのチェックボックスで選択（persist）。
- 既定対象: 整合性（consistency + intra_scene_consistency）/ 誤字 AI / レビュー / メタ構造 / 時系列 / 意図ドリフト / 校正の全章 Lint スキャン（ローカルなので既定 ON）。疑似コメント・影響レビューは対象外（決定事項）。
- 実行は現在のスコープに従う: scene → 単発 run、folder / project → multi（scenes 部分集合）。**観点を 1 つずつ直列実行**（レート制限・ローカル LLM・中止セマンティクスに安全側。input_hash キャッシュにより未変更シーンは cache hit で流れるため、再実行は実質差分のみ）。
- 進捗: 各 run を既存 runStore に順次登録（常駐トースト / stripe バッジがそのまま可視化）+「n/m 観点」のサマリ表示。中止 = 実行中 run の abort + 残り観点のスキップ。
- Rust 手当て:
  1. `intent_drift` を `start_post_effect_run_multi` の allowlist と `run_multi_task` dispatch に追加。
  2. 中止フラグの per-run 化: グローバル `AtomicBool` を run_id キーのマップに置換。`abort_post_effect_run(run_id)` は該当 run のみ停止し、新 run 開始が他 run の中止状態を上書きしない。

## テスト

- `KouetsuPanel.test.tsx` を 3 タブ構成に改修（APG tablist 検証は維持）。
- store migration テスト（旧 persist 値 → 新形式）。
- `issueCounts` 正直化テスト（二重計上廃止、スコープ / フィルタ整合）。
- ScopeTreePicker 抽出後の Chat 側既存テスト green 維持 + 校閲側ピッカーテスト。
- folder subtree フィルタのユニットテスト。
- Rust: multi allowlist + per-run abort のテスト（`cargo test --no-default-features`）。
- パネル内部のみの変更だが `pnpm test:browser` も実行して layout invariant を確認。

## 実装計画時の確定逸脱（2026-07-06 精読で判明）

1. **intent_drift は multi 化しない** — シーン毎の `intent` が system_prompt と input_hash に畳み込まれるため（`intentDriftPayloadBuilder.ts`）、multi の共有 system_prompt では成立しない。FE の直列単発ループ（per-scene キャッシュ活用、intent 未設定はスキップ）で実装する。Rust の multi allowlist 追加は不要となり、Phase 2 の Rust 変更は per-run abort 化のみ。
2. **バッジは scene スコープ + open フィルタのみ実数、それ以外は非表示（null）** — folder/project の実数集計は全 Project ビューのフェッチ統合が必要で blast radius が大きい。嘘の 0 固定の根治（非表示は嘘ではない）を優先し、実数化はフェッチ統合時の将来課題とする。
3. **校正の全章 Lint スキャンは folder 絞り込み非対応のまま** — `lintProjectStore.start` が project 単位のため、全体チェックでは project 全域で実行する。

実装計画: `docs/superpowers/plans/2026-07-06-kouetsu-panel-rework.md`

## 非スコープ

- 検出主体タブ再編（案B / north-star）は本リワークが包含・置換する。
- `foreshadow_anchor` / `theme_anchor` の新規実装はしない。
- コメント / ブロッカータブの内部改修（疑似コメント移設を除く）。
- 実装完了後、`docs/Grimodex_PostEffects設計書.md` の校閲パネル UI 記述を本設計に追従させる（design-doc-sync）。
