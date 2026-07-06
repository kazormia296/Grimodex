# 校閲パネル Refine — 統合トリアージ UI 設計書（2026-07-06）

## 背景とデザイン出典

受信箱モデル再編（PR#281/#282/#285、`2026-07-06-kouetsu-panel-rework-design.md`）で
データ層・実行系は整理されたが、指摘タブの表示は「8 観点セクションの縦積み」のままで、

- 指摘の全体量・重大度の分布が一目で分からない（セクションを開かないと見えない）
- 1 件ずつ判断していく動線（トリアージ）がない
- 全体チェックの進捗・結果がトーストと小さな進捗表示にしか出ない
- folder/project スコープで件数バッジが出ない（フェッチが観点別に分散しているため）

という課題が残っていた。

Claude Design プロジェクト「Grimodexの校閲パネルリファイン」
（`校閲パネル Refine.dc.html`）でリファイン 5 案 + 統合プロトタイプを検討し、
**統合プロトタイプ 2a（1b 統合インボックス基盤 + 1c 観点ダッシュボード / 1d パイプライン /
1f フォーカストリアージの状態切替）** を実装対象として確定した。

## 対象 / 非対象

**対象**: 指摘タブ（`IssuesInbox`）の全面リワーク。ヘッダ行・ステージ・統合リスト・
フッター。`fullCheckStore` の per-step 進捗拡張。観点別最終実行時刻の表示。

**非対象**:
- コメント / ブロッカータブ（現状維持。`DismissedAnnotationsView` は CommentsTab が
  使用するため**削除しない**）
- runner 群（`runners/*`）・fullCheck オーケストレータの実行セマンティクス
  （直列順・abort 契約・per-run 化はそのまま）
- バックエンド（Rust）変更なし。既存 `list_post_effect_runs` を初めて配線するのみ
- エディタ側の annotation mark / lint 装飾

## 新 UI 構造（指摘タブ）

```
KouetsuPanel（3 タブ: 指摘/コメント/ブロッカー — 変更なし）
└─ IssuesInbox（全面書き換え）
   ├─ TriageHeader（旧 KouetsuScopeBar の再設計）
   │   ├─ スコープピッカー trigger（既存 ScopeTreePickerList popover を維持）
   │   └─ 右側: RunControl + ダッシュボードトグル（LayoutGrid アイコン）
   ├─ ステージ（排他 4 モード、優先順: triage > pipeline > dashboard > summary）
   │   ├─ TriageCard   … 行選択時。詳細 + アクション（本文へ/Fix/解決/無視/あとで）
   │   ├─ PipelineStage… 全体チェック実行中〜閉じるまで。ステップ一覧 + 進捗バー
   │   ├─ DashboardStage… 8 観点タイル（件数/最終実行/実行ボタン）。タイル=観点フィルタ
   │   └─ SummaryStage … 既定。開いている件数 + 重大度分布バー
   ├─ リストツールバー: 「開いている N」「除外 N」pill + 観点フィルタ chip + 並びラベル
   ├─ IssueList（統合トリアージリスト、セクション廃止）
   └─ TriageFooter: 観点別の最終実行ドット + 実行履歴 popover
```

### ステージのモード導出（デザイン 2a のロジックを踏襲）

```
mode = selectedIssueId ? "triage"
     : (pipelineVisible && runState !== "idle") ? "pipeline"
     : dashboardOn ? "dashboard"
     : "summary"
```

- 全体チェック開始で `pipelineVisible=true`・選択解除。実行中に「戻る」で
  `pipelineVisible=false`（ヘッダに「実行中 n/N」pill が残り、クリックで復帰）。
- 完了後は `runState="done"` のままパイプラインを表示し続け、「閉じる」で
  `runState="idle"` に戻す。
- ダッシュボードトグルは選択・パイプライン表示を解除する。

## データモデル — UnifiedIssue

場所: `src/features/kouetsu/triage/issueModel.ts`（純関数のみ、store 参照なし）。

```ts
export type IssueCat =
  | "linter" | "typo" | "consistency" | "impact"
  | "review" | "intent" | "meta" | "timeline";
export type IssueSev = "high" | "mid" | "low";

export interface UnifiedIssue {
  id: string;              // "ann:<annId>" | "lint:<sceneId>:<i>" | "lens:<recordId>"
  cat: IssueCat;
  sev: IssueSev;
  sceneId: string | null;  // timeline 等 scene 不定は null
  title: string;           // annotation.content / diagnostic.message / lens.finding
  metaLine: string;        // rule_id / codexChipLabel / persona / lensType ラベル等
  excerpt: { pre: string; mark: string; post: string } | null;
  quote: string | null;    // textSnapshot / found_context
  compare: { leftLabel: string; left: string; rightLabel: string; right: string } | null;
  suggest: { found: string; suggestion: string } | null; // typo のみ
  fixable: boolean;        // typo(suggestion あり) / lint(fix あり)
  confidence: "high" | "medium" | "low" | null;
  createdAt: string | null;
  source:
    | { kind: "annotation"; ann: PostEffectAnnotation; parsed: ParsedAnnotationMeta }
    | { kind: "lint"; sceneId: string; diag: Diagnostic }
    | { kind: "lens"; record: SceneLensRecord };
}
```

### severity 写像（単一の正）

| ソース | high（重大） | mid（注意） | low（提案） |
|---|---|---|---|
| annotation.severity | `error` | `warning` | `suggestion` / `info` / null |
| lint Diagnostic.severity | `error` | `warning` | `info` |
| SceneLensRecord.severity | `error` | `warning` | `suggestion` / `info` |

デザインのチップ表記「整合性・高/中/低」は **severity 側**（この写像）を使う。
confidence（high/medium/low）は別軸のままで、トリアージカードにのみ補助表示する。

### アダプタ規則

- `fromAnnotation(ann)`: `parseAnnotationMeta` を再利用。category → cat の写像は
  `typo_anchor→typo / consistency_anchor→consistency（intra 含む）/ review→review /
  intent_anchor→intent / timeline_anchor→timeline / impact_review_anchor→impact`。
  `pseudo_comment` / `foreshadow_anchor` / `theme_anchor` は**対象外**（受信箱に出さない）。
  - excerpt は `foundContext` を `foundText` で 1 回分割して pre/mark/post を作る
    （不一致時は excerpt=null、quote=foundContext）。
  - compare は consistency（codex.expectedValue/foundValue がある場合）と
    impact（changeSummary vs foundText）で生成。
  - metaLine: consistency=`codexChipLabel(codex)`、typo=カテゴリラベル+確信度、
    review/intent/timeline=relation ラベル等、impact=entryName。
- `fromLintDiagnostic(sceneId, i, diag)`: metaLine=rule_id、fixable=!!diag.fix。
- `fromSceneLens(record)`: `finding` が空のレコードは**行にしない**。metaLine=lensType
  のラベル。解決/無視/Fix 不可（annotation ではないため）。

### ソート・グルーピング・件数（純関数）

- `sortIssues`: sev（high→mid→low）→ createdAt 降順 → id の安定ソート。
- `groupByCat`: dashboardOn 時に観点固定順（linter→typo→consistency→impact→review→
  intent→meta→timeline）でグループ化。
- `advanceFrom(order, id, statusChange)`: トリアージの「次へ」純関数
  （デザイン 2a の advanceFrom と同じ仕様。あとで=ステータス変更なしで次の open へ、
  自分しか残っていなければ選択解除）。
- 件数はフィルタ済みリストの実長から導出する（**バッジ正直の不変条件**:
  表示件数と常に一致。unified フェッチにより folder/project でも実数を出せる。
  これは受信箱リワーク設計の逸脱 2「folder/project バッジ実数化は将来課題」の解消）。

## データ配管 — useUnifiedIssues

場所: `src/features/kouetsu/triage/useUnifiedIssues.ts`。

| scope × filter | annotations | lint | meta lens |
|---|---|---|---|
| scene + open | `listAnnotationsForScene(activeSceneId)` → `annotationStore` ミラー購読 | `useLintStore.diagnostics`（live） | `listSceneLensForProject` → targetId=activeScene で絞る |
| folder/project + open | `listAnnotationsForProject({status:"open"})` 1 回 → category + スコープ sceneIds（`getSceneIdsForScope`）で絞る | `lintProjectStore.scenes`（phase==="done" のときのみ、スコープ絞り） | `listSceneLensForProject` → スコープ絞り |
| dismissed（全スコープ） | `listAnnotationsForProject({status:"dismissed"})` → `selectManuallyDismissed`（全対象 category） | 出さない（lint に dismissed 概念なし。校正の無効化は従来どおり Linter 設定側） | 出さない（lens に dismissed 概念なし） |

- scene+open の annotation は従来の CurrentScene 系ビューと同じく
  fetch → `setAnnotations(sceneId, …)` → `applyAnnotationsToEditor` を維持する
  （**本文ハイライト反映の後退禁止**。過去に落として回帰させた実績あり）。
- refresh 契約: `refresh()` を公開し、(a) scope / activeSceneId / statusFilter 変更時、
  (b) 追跡した post-effect run の done 終端時（`usePostEffectRunStore` の runs を購読し
  outcome が undefined→確定 に変わったら）、(c) fullCheck の done 数変化時に再取得。
- folder/project は**単一フェッチ**に統合される（旧: 観点別 7 ビューが各自フェッチ）。

## fullCheckStore 拡張（Phase 1B）

既存キー（running/currentStep/done/total/failures/cancelRequested）と
abort 契約（追跡集合・try/finally・cancel 後 error を failures に積まない）は不変。追加:

```ts
export type FullCheckStepState =
  | { state: "pending" }
  | { state: "running" }
  | { state: "done"; count: number }
  | { state: "error"; error: string }
  | { state: "skipped"; reason: "unchecked" | "sceneLint" }; // 対象外表示用
runState: "idle" | "running" | "done";  // done = パイプラインを閉じるまで維持
steps: Record<FullCheckStepId, FullCheckStepState>;
pipelineVisible: boolean;
lastFinishedAt: string | null;          // ISO。完了時に更新（中止/blocked では更新しない）
findingsTotal: number;                  // 完了 run の指摘合計
closePipeline(): void;                  // runState done→idle, pipelineVisible=false
hidePipeline(): void;                   // 実行中の「戻る」
showPipeline(): void;
```

`runFullCheck` は開始時に steps を初期化（対象=pending、非対象=skipped）し、
各ステップの開始/終了で steps を更新する。`running` は `runState==="running"` の
派生に置き換えてよい（既存購読箇所は少ない）。中止時は残 pending を据え置き、
`runState="done"`（done カウンタは加算しない — 既存仕様）。

## 観点別最終実行時刻（Phase 1C）

場所: `src/features/kouetsu/triage/useEffectLastRuns.ts`。

- 既存 API `listPostEffectRuns({ projectId, effectType, limit: 1 })`（未配線）を
  effect 6 種（typo_detection / consistency / review / intent_drift / meta_structure /
  timeline_consistency）について並列で叩き、最新 completed run の `completedAt` を返す。
- 再取得トリガ: マウント時・fullCheck 完了時・個別 run done 時。
- 相対時刻フォーマッタ `formatRelativeTime(iso, now)`: たった今（<60s）/ N分前（<1h）/
  HH:MM（当日）/ 昨日 / M/D。既存に同等ユーティリティがあれば再利用する
  （実装時に `src/lib` を確認）。
- linter は「自動」、impact は「手動」の固定ラベル（run 時刻を出さない）。

## アクション配線

| アクション | 実装 |
|---|---|
| 本文へ | annotation: `openSceneInEditor(sceneId)`（非アクティブシーンなら）→ `setFocusedAnnotationId(id)` を rAF リトライ付きで（`jumpToComment` と同じ最大 60 フレーム方式、`triage/jumpToIssue.ts`）。lint: LinterPanel と同じ `buildOffsetMap`→`strOffsetToPmPos`→`setTextSelection().scrollIntoView()`。lens: シーンを開くのみ |
| Fix | typo: `applyTypoFixAndResolve(editor, ann)`。lint: `insertContentAt(fix.replacement)`（LinterPanel.applyFix と同等。共通化できる場合は lint 側からヘルパを export） |
| 解決 / 無視 | `closeAnnotation(ann, "resolved"/"dismissed", editor)`（annotation のみ。lint/lens 行では非表示） |
| あとで | `advanceFrom`（ステータス変更なし） |
| 再表示（除外リスト） | `updateAnnotationStatus(ann.id, "open")` + store 反映（DismissedAnnotationsView.reopen と同等） |
| タイル実行 | 各観点 runner（`runners.ts`）を現在スコープで起動。完了後 refresh。実行中は `useIsPostEffectRunning(effect, scopeType, scopeTargetId)`（**scope 厳密一致** — folder 実行を project で引かない） |

解決/無視/Fix 後は `advanceFrom` で次の open 項目へ自動遷移（トリアージカード表示中のみ）。

## UI 状態（kouetsuStore 追加、すべて非永続）

```ts
selectedIssueId: string | null;
dashboardOn: boolean;
catFilter: IssueCat | null;
```

partialize に**含めない**（persist キーは既存 5 つのまま）。`projectGroupBy` は
統合リストでは使わないため state・persist から削除する（shallow merge により
旧 persist に残っていても無害）。スコープ・フィルタ変更時は selectedIssueId /
catFilter をリセットする。

## 色トークン（ライト/ダーク両対応）

`src/index.css` の `:root` / `.dark` に追加（デザインはライトのみ定義のため
ダークは同系統の明度反転で新設）:

```
--kouetsu-accent            #534AB7 / (dark) #8d84e0
--kouetsu-accent-weak       #eeecf6 / #2e2a4a
--kouetsu-sev-high          #D64545 / #e07070
--kouetsu-sev-mid           #E09A3A / #e0ac62
--kouetsu-sev-low           #7A72CE / #948ce0
--kouetsu-chip-high-bg/fg   #F6E7E7 · #A33232 / #4a2626 · #e8a9a9
--kouetsu-chip-mid-bg/fg    #F7EEDD · #946417 / #453722 · #e0be85
--kouetsu-chip-low-bg/fg    #EDEBF8 · #4A4390 / #2e2a4a · #b3ace8
--kouetsu-mark-high/mid/low （excerpt の <mark> 背景、chip-bg と同系）
--kouetsu-ok                #3fa66c / #5dbd88
```

利用は Tailwind v4 の arbitrary 値 `bg-[var(--kouetsu-sev-high)]` 等。ブランド紫は
既存慣習どおり `#534AB7` 系（正規トークンが無いため kouetsu スコープの変数として持つ）。

## i18n

`kouetsu.triage.*` を ja.json / en.json に追加（開いている N 件・重大/注意/提案・
全体チェック・チェックする観点・8つの観点・最終チェック・実行中 n/N・待機中・対象外・
検出なし・本文へ・解決・無視・あとで・再表示・実行履歴・未実行・自動・手動 等）。
観点名は既存キー（`FULL_CHECK_STEP_LABEL_KEY` が指すもの）を再利用する。

## 削除対象と維持対象

**削除**（統合リストで置換され、到達不能になるもの）:
- `InboxSection.tsx` / `SectionHeader.tsx` / `issueCounts.ts`（+テスト）
- `sections/`（8 ファイル）
- `views/CurrentScene{Typo,Review,Annotations,IntentDrift}View.tsx`、
  `views/Project*.tsx`、`views/MetaStructureView.tsx`（+テスト）

**維持**:
- `views/DismissedAnnotationsView.tsx`（CommentsTab が pseudo_comment で使用）
- `dismissedAnnotations.ts`（unified フックが再利用）
- `runners/*`・`fullCheck*`・`PostEffectAnnotationPanel`（editor 側で使用があるため
  削除は grep で使用ゼロを確認できた場合のみ）

**パリティテスト移植（必須）**: `views/CurrentScene{Typo,Review,Annotations}View.test.tsx`
は runner scene パスの特性テスト（`runPostEffect` request 全フィールド `toEqual` 固定）。
ビュー削除に伴い、**同じ expected request を runner 直叩き**
（`runTypoCheck({type:"scene",...})` 等）で検証するテストへ移植してから旧テストを消す。
期待値のバイト同等を維持すること（プロンプト合成順・model 導出・override 伝搬の回帰ゲート）。

## 実装時の確定逸脱（2026-07-06 実装完了時点）

1. **metaLine は構造化 `IssueMeta` に変更** — i18n をモデルに持ち込まないため、
   `issueModel` は構造化値を持ち、ラベル化は `triage/catalog.ts` の
   `issueMetaLabel` が担う。
2. **フッターの「実行履歴」ボタンは省略** — 表示データが footer の観点別
   鮮度ドットと同一になるため。代わりに footer に AI 観点 6 種すべての
   最終実行を常設表示（デザインの 3 観点より情報量は上位互換）。
   run 履歴一覧 UI（`list_post_effect_runs` のページング表示）は将来課題。
3. **観点別「実行中」判定は effect 種別レベル**（`useCatRunning`、スコープ
   非依存） — タイル/フッターは観点レベルの UI で、スコープ違いの並走 run も
   「動いている」と見せるのが正しく、取り逃しによる二重起動穴も起きない。
   `useIsPostEffectRunning` の scope 厳密一致はビュー単位の spinner 用で、
   ここでは意図的に使わない。
4. **観点単発実行の完了時トーストは runStore の進捗トーストへ一本化** —
   旧 CurrentScene 系ビュー各自の from_cache / noIssues / 部分失敗トーストは
   重複表示になるため付けない（ハード失敗のみ `runCategoryFailed` で報告）。
   これに伴い旧 CurrentSceneAnnotationsView の**「別モデルで検出」警告は
   一旦喪失**（実使用モデル集合との突合が必要で、統合リストでは別設計が
   要る）。復活させる場合は issueActions.runCategoryCheck の consistency
   分岐に models 比較を戻す。
5. **LinterPanel は未参照化するが削除しない** — 検索/重大度フィルタ/レポート
   出力/インライン無効化などの校正詳細ツールを持つため、再配置か削除かの
   判断は別途（残課題）。無効化 directive の管理（DisablesView）は除外ビュー
   下部に併設して機能維持した。
6. **multi パスの flush 順ゲートは runner テストの has-been-called 検証のみ**
   （旧 ProjectReviewView テストの実 flush 順検証はビューと共に削除）。
7. **除外リストはプロジェクト全体・スコープ非依存**（旧 DismissedAnnotationsView
   と同じ挙動を踏襲）。「除外 N」pill の件数もプロジェクト全体の実数。
8. **`docs/Grimodex_PostEffects設計書.md` の校閲パネル UI 記述（旧 8 セクション
   構造）への追従は別 PR**（受信箱リワーク時の #284 相当の docs 作業）。

## 既知の罠との整合（再掲）

- scene+open の annotation 反映 3 点セット（fetch→setAnnotations→applyAnnotationsToEditor）を
  落とさない。
- `useIsPostEffectRunning` は scope 厳密一致で引く。フックは無条件呼び出し
  （sceneId 未選択は `""` を渡す）。
- fullCheck orchestrator の try/finally・abort 自 run 限定・cancel 後 error 無視は不変。
- 折りたたみ mount 抑制は不要になる（フェッチが unified に統合されるため
  project フェッチの束の問題自体が消える）。
