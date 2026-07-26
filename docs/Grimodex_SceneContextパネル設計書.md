# Grimodex Scene Contextパネル設計書

## 概要

Scene Context パネルは、いま編集中のシーンに紐づく文脈（本文中に出現する Codex
エントリと、意味的に関連する過去シーン）を 1 つのパネルへまとめた統合パネル。
旧「Codex Quick」と旧「関連する過去シーン」の 2 つの専用パネルを、縦積みの
折りたたみセクションとして吸収したもの（出荷: 2026-06-29 / PR#215 = commit
`9662f0c1`「feat(layout): CodexQuickと関連過去シーンを Scene Context パネルへ統合」）。

Grimodex のコア体験 **TALK→EXTRACT→RECALL** ループのうち、Scene Context は
**RECALL（過去に書いた／抽出した知識を執筆中に引き戻す）の人間向け窓口**を担う。
上段の Codex セクションが「いま書いている本文に出てくる固有名詞・設定」を引き、
下段の関連過去シーンセクションが「いま書いている内容に意味的に近い既読シーン」を
引く。どちらも read-only で、クリックすると該当エントリ／該当箇所へ移動する
（`src/features/tree/SceneContextPanel.tsx:15-22`）。

**最重要事項 — 内部 panel id は `codex-quick` のまま、表示名のみ "Scene Context"。**
統合に際しコンポーネント木は大きく変わった（Panel 単体 → Panel + 2 Section）が、
パネル ID は旧 CodexQuick の `codex-quick` を維持し、旧 `related-scenes` を吸収・廃止
した。ストライプ・キーバインド・ビルトインプリセット・保存済みレイアウト
（`layout.json`）はすべて panel id を参照キーにするため、ID を変えると
`stripUnknownPanels` が「未知パネル」とみなして既存ユーザーのレイアウトから黙って
消してしまう。そこで **システム内部は安定 ID、UI は新名称** に切り離す。表示名は
i18n キー `layout.panel.codex-quick` を介して ja/en とも `"Scene Context"` に解決する
（`src/locales/ja.json:1225` / `src/locales/en.json:1225`、いずれも値 `"Scene Context"`。
パネルコンポーネント側のコメントは `src/features/tree/SceneContextPanel.tsx:20-21`）。

デフォルト位置: 左 stripe の Bottom スロット（`LB`）、region `left`、region 内 index 1
（`src/features/layout/toolWindowDefaults.ts:45`、`DEFAULT_SLOT_MAP["codex-quick"] = "LB"` /
`SLOT_TO_INDEX["LB"] = 1`、`src/features/layout/panelRegions.ts:12` で region `"left"`）。

---

## パネル構造

縦 1 カラム。最上部にパネル共通の `PanelHeader`（ここだけが最大化・右クリック
メニューのジェスチャを持つ）、その下に `overflow-y-auto` のスクロール領域へ
`CollapsibleSection` を 2 つ縦積みする。上が Codex セクション、下が関連過去シーン
セクション（`src/features/tree/SceneContextPanel.tsx:50-65`）。

```
┌─────────────────────────────────────────┐
│ Scene Context                       … ⋮ │ ← PanelHeader (data-panel-header)
├─────────────────────────────────────────┤
│ ▼ CODEX                      [category▾]│ ← CollapsibleSection (actions=sort)
│   ● Elara                       character│
│   ● The Obsidian Tower           location│
│   ─ ピン留め ─                          │
│   ● Soulbind Amulet                  item│
├─────────────────────────────────────────┤
│ ▼ 関連する過去シーン                  ⟳ │ ← CollapsibleSection (actions=spinner)
│   井戸端の密談                       92% │ ← シーン名 + スコア(%)
│     …エリカが鍵を渡した場面             │ ← 一致チャンク(2行クランプ)
│   赤い封蝋                           85% │
│     …封蝋の紋章は東の塔のもの           │
└─────────────────────────────────────────┘
   Codex 行クリック → Codex パネルで該当エントリ選択
   シーン行クリック → そのシーンを開き一致箇所へジャンプ
```

ホスト（`SceneContextPanel`）が `PanelHeader` と外枠だけを持ち、各セクションの本体
（自動検出・ピン留め・意味検索・状態表示）はセクションコンポーネントへ委譲する。
ホストが持つ局所状態は Codex セクションの開閉（`codexOpen`）と sort select だけで、
関連過去シーンセクションは自前で開閉・fetch を管理する
（`src/features/tree/SceneContextPanel.tsx:23-72`）。

---

## A. Codex セクション

本文中に出現する Codex エントリを引く上段セクション。本体は
`CodexQuickSection`（`src/features/tree/CodexQuickSection.tsx:24-196`、196 行）で、
ホストの `CollapsibleSection`（`title=t("sceneContext.codexSection")`、既定
`open=codexOpen=true`）の中に置く（`src/features/tree/SceneContextPanel.tsx:54-61`）。

- **本文中 Codex エントリの自動検出**: エディタ本文 → 構文的ハイライト経由で即時に
  match し、`useCodexHighlightStore.matchedEntryIds` を購読して一覧化する
  （`src/features/tree/CodexQuickSection.tsx:24-196`）。これは Codex-ai 側の semantic
  injection とは別ファネルで、エディタ内 Codex ハイライト（Pure Decorations）と
  同一パイプラインを共有する。マッチング・タブ種別ごとの挙動・ピン永続化の詳細は
  [[Grimodex_CodexQuickパネル設計書]] の「表示ルール」「データフロー」を正本とする。
- **色ドット・カテゴリラベル**: 各行左端に type 別カラードット
  （`typeColorMap[entry.type]?.fg`）、右端にカテゴリラベル（`entry.type` をそのまま
  10px フォントで表示）。「今の真実」バッジ・未開示伏線警告の行内表示順は
  [[Grimodex_CodexQuickパネル設計書]] を参照（統合後も同挙動）。
- **ピン留め**: 行ホバーでピンボタンが出現（`group-hover:flex`、ピン済みは常時
  表示 + `text-primary`）、`togglePinnedCodex(entry.id)` でトグル。
  自動検出に漏れたエントリを手動で固定するための補完で、`useTreeStore.pinnedCodexIds`
  を購読する。`[+ Pin Codex entry]` は `CodexCommandPalette` を開いて検索選択する。
- **sort select の配置**: ソート選択は `CollapsibleSection` の `actions` に渡し、
  セクション見出しの右端に出す（`src/features/tree/SceneContextPanel.tsx:35-48`）。
  選択肢は `CODEX_SORT_OPTIONS` から `most-referenced` を除外したもの — CodexQuick は
  参照カウントを持たないため（`src/features/tree/SceneContextPanel.tsx:30-33`）。
  保存値が `most-referenced` の場合は表示上 `category` にフォールバックする
  （`src/features/tree/SceneContextPanel.tsx:37`）。`sortOrder` は `useCodexStore` を
  共有し、Codex 管理パネルと同期する。
- **split mode（2 グループ表示）での扱い**: `CodexQuickSection` は `activeGroupIndex`
  を購読しない。常に `useCodexStore` のグローバル状態で entries / sortOrder を参照する。
  「どのグループの本文がマッチ対象か」はフォーカスグループのみが Quick を更新する
  上位ルーティングで制御する（[[Grimodex_CodexQuickパネル設計書]] の「Split mode」が正本）。

---

## B. 関連過去シーンセクション

いま編集中シーンに意味的に関連する**「前の」シーン**を引く下段セクション。本体は
`RelatedScenesSection`（`src/features/related-scenes/RelatedScenesSection.tsx:45-132`）。
親が `enabled=isActive` を渡し（`src/features/tree/SceneContextPanel.tsx:62`）、
セクション自身が開閉 state（既定 `open=true`）を持つ。

- **「前のシーンのみ」**: 現在シーン（`useTreeStore.activeSceneId`）より前のシーン
  だけを出す。時間軸はプロジェクトの `phase_resolution_mode`（reading/story/auto）に
  従い（`usePhaseStore.resolutionMode`、`src/features/related-scenes/RelatedScenesSection.tsx:52`）、
  **既定 reading**（読書順で前＝既読）、story/auto では作中時系列で前。順序軸の
  切替を即反映させるため `resolutionMode` を `useEffect` 依存に組み込む
  （`src/features/related-scenes/RelatedScenesSection.tsx:60-84`）。パネル独自の
  reading/story トグルは意図的に作らない（同一概念の 2 つ目の設定を増やさない）。
- **fetch gate = `enabled && open`**: 親パネルが非表示、またはセクション折りたたみ中は
  意味検索を打たない（`shouldFetch = enabled && open`、
  `src/features/related-scenes/RelatedScenesSection.tsx:57-65`）。これにより非表示
  パネルの keepalive での無駄打ちを防ぐ。シーン切替連打は `FETCH_DEBOUNCE_MS = 400`ms で
  抑止する（`src/features/related-scenes/RelatedScenesSection.tsx:12,68`）。
- **表示形式**: 1 シーン 1 行（最良スコアのチャンクを代表に集約）。スコアは cosine を
  `Math.round(score * 100)%` で primary ピル表示、チャンク本文は `line-clamp-2`
  （`src/features/related-scenes/RelatedScenesSection.tsx:107-127`）。状態表示は
  アクティブシーン無し → `relatedScenes.noActiveScene`、検索中 0 件 →
  `relatedScenes.loading`、完了 0 件 → `relatedScenes.empty`
  （`src/features/related-scenes/RelatedScenesSection.tsx:98-105`）。loading スピナーは
  セクション `actions` に置く（`:91-95`）。
- **クリックでジャンプ**: 行クリックで `navigateToScene` → `requestSceneChunkJump`。
  ジャンプ順序契約（`requestJump → setActiveScene → showPanel`）は
  `requestSceneChunkJump` に集約され、意味検索ダイアログと 1 実装を共有する
  （`src/features/related-scenes/RelatedScenesSection.tsx:14-29`）。削除済みシーンへ
  飛んで空エディタが開くのを防ぐため、クリック時に `useTreeStore.nodes` の存在チェックを
  行う（`:23-28`）。
- **split mode での扱い**: `enabled=isActive` で親パネルの表示状態のみを見る。
  `activeSceneId` は常に `useTreeStore`（左エディタ）から購読し、`activeGroupIndex`
  分岐はセクション内で行わない（tree 側の一元管理に委ねる）。
- **検索・ランキングの不変条件は外部正本**: dense + sparse の RRF 融合、per-scene 床
  （言語別 gate ja 0.85 / en 0.51）、dense 勝者アンカー（`hybrid R@1 ≥ dense R@1` の
  構造保証）、固有名詞 seed 拡張といったアルゴリズム不変条件は本書では再掲しない。
  [[Grimodex_関連する過去シーンパネル設計書]] の「検索とランキング」「設計上の判断・制約」と
  [[Grimodex_セマンティック検索設計書]]・[[Grimodex_セマンティック検索の閾値とモデル特性]] を
  深掘り先・正本とする（純関数 `selectRelatedPastScenes` /
  オーケストレーション `fetchRelatedPastScenes` は統合後も不変で流用）。

---

## C. CollapsibleSection（汎用折りたたみ部品）

両セクションが共有する汎用部品（`src/features/layout/CollapsibleSection.tsx:26-54`）。
パネル内に縦積みする折りたたみ可能なセクションを描く。

- props: `title` / `open`（親が管理）/ `onToggle()`（見出しクリック）/
  `actions`（見出し右端に並べる sort select・spinner 等）/ `children`
  （`src/features/layout/CollapsibleSection.tsx:5-16`）。`open` のとき children を描く
  （`:51`）。chevron は `open` で `ChevronDown` / 閉で `ChevronRight`（`:34`）。
- **`data-panel-header` を付けない（設計判断）**: セクション見出しには
  `data-panel-header` を**付けない**（`src/features/layout/CollapsibleSection.tsx:18-25`
  のコメント）。最大化・右クリックメニューのジェスチャはパネル全体の `PanelHeader`
  だけが持つべきで、セクション見出しにも付けると `PanelChromeMenu` のダブルクリック
  最大化が二重発火するため。ジェスチャ管理はパネル全体レベルのみに閉じる。
  パネルヘッダー標準は [[Grimodex_パネルヘッダー設計書]] を参照。

---

## DBスキーマ

Scene Context パネルが直接所有する永続データは Codex セクションの手動ピン留めのみ。
関連過去シーンセクションは read-only で、既存 `semantic_search` / `fts_search` を
組み合わせるだけ（独自テーブルなし）。

`codex_quick_pins`（手動ピン留め。正本 = `src-tauri/crates/grimodex-db/src/migrate.rs:118-123`）:

```
CREATE TABLE IF NOT EXISTS codex_quick_pins (
    entry_id   TEXT PRIMARY KEY REFERENCES codex_entries(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_codex_quick_pins_created
    ON codex_quick_pins(created_at);
```

Drizzle 側ミラー（`src/db/schema.ts:236-247`）:

- `entryId` = `text("entry_id").primaryKey().references(() => codexEntries.id, { onDelete: "cascade" })`
- `createdAt` = `text("created_at").notNull().$defaultFn(() => new Date().toISOString())`
- index: `idx_codex_quick_pins_created` on `createdAt`

メモリ保持は `useTreeStore.pinnedCodexIds`、永続化は `codexQuickPinApi` 経由、
起動時に DB から復元する（詳細は [[Grimodex_CodexQuickパネル設計書]] 「ピン留めの
永続化」を正本）。SQL 正本は migrate.rs、Drizzle 列定義はそのミラーである点に注意。

---

## レイアウト統合

旧 CodexQuick の `codex-quick` id を**維持**しつつ、旧 `related-scenes` id を
**廃止**した。登録は次の系統で一括更新する。

| 系統 | サイト | 内容 |
|------|--------|------|
| panelIds | `src/features/layout/panelIds.ts:10` | `PanelId` に `"codex-quick"` 維持。`"related-scenes"` を型から削除 |
| panelComponents | `src/features/layout/panelComponents.tsx:4,37` | `import { SceneContextPanel }` → `"codex-quick": SceneContextPanel` |
| panelIcons | `src/features/layout/panelIcons.ts:4,31` | `"codex-quick": ScanSearch`（旧 Pin から変更） |
| panelRegions | `src/features/layout/panelRegions.ts:12` | `"codex-quick": "left"` |
| toolWindowDefaults | `src/features/layout/toolWindowDefaults.ts:45` | `DEFAULT_SLOT_MAP["codex-quick"] = "LB"`（region left / index 1） |
| layoutPresets | `src/features/layout/layoutPresets.ts:91-92,173,268,354-355,445` | 全 5 ビルトインプリセットの左 l1 スロットに `codex-quick` |
| keybindings | `src/features/settings/keybindings.ts:71-73` | `focusCodexQuick` = `Mod+Alt+Q` 維持。`focusRelatedScenes` 削除 |
| locale (表示名) | `src/locales/ja.json:1225` / `src/locales/en.json:1225` | `layout.panel.codex-quick = "Scene Context"`（ja/en 共通） |
| locale (節見出し) | `src/locales/ja.json:3495-3496` / `src/locales/en.json:3500-3501` | `sceneContext.codexSection` = `"Codex"`、`sceneContext.scenesSection` = ja「関連する過去シーン」/ en「Related Scenes」 |

ビルトインプリセットでの `codex-quick` 配置と `activePanel`（左 l1 スロット）:

| プリセット | 左 l1 スロットの panels | activePanel |
|-----------|------------------------|-------------|
| builtin:default | codex-quick, foreshadow, kouetsu | `codex-quick`（`layoutPresets.ts:91-92`） |
| builtin:plan | codex-quick のみ | null（`:173`） |
| builtin:chat-main | codex-quick, foreshadow, kouetsu | null（`:268`） |
| builtin:review | codex-quick, foreshadow, attribution | `codex-quick`（`:354-355`） |
| builtin:codex-main | codex-quick, foreshadow, kouetsu | null（`:445`） |

各プリセットは map/grid/matrix/chronicle/trash-bin/writing-stats 等を
`hiddenStripePanels` で stripe 非表示にする（panel は state に存在するが「必要時に
開く」運用）。

### related-scenes id の削除と自動移行（移行コード不要）

旧 `related-scenes` panel id は `panelIds.ts` の `PanelId` 型から削除し、
toolWindowDefaults / panelRegions / panelIcons / keybindings の関連エントリも除いた
（`TOOL_WINDOW_PANEL_IDS` からも自動除外される）。`focusRelatedScenes`
キーバインドは削除済み（`grep` で keybindings.ts に該当なし）。

保存済みレイアウト（`layout.json`）の移行は専用コード不要。load 時の
`validateLayoutState` → `stripUnknownPanels(migrateLayoutStateV2toV3(state))`
（`src/features/layout/layoutStateUtils.ts:87-88`、関数本体 `:148-`）が、型から
消えた `related-scenes` を「未知 panel id」として全 regions / center.segments から
自動フィルタし、空になった slot を除去、`activePanel` が解決不能なら panel[0] に
フォールバックする。回帰ガードは
`src/features/layout/layoutStateUtils.test.ts:655-693`（「削除済み related-scenes を
strip しつつ codex-quick のカスタム配置を保持する」）。古い `layout.json` に
`related-scenes` が復活することはなく、panel 統合として正常な挙動。

---

## キーボードショートカット

| バインド | 動作 | サイト |
|----------|------|--------|
| `Mod+Alt+Q` | Scene Context パネルの表示トグル＋フォーカス（id `codex-quick`、`focusCodexQuick`） | `src/features/settings/keybindings.ts:71-73`、`KEYBOARD_SHORTCUT_MAP["codex-quick"]="Ctrl+Alt+Q"`（`src/features/layout/panelRegions.ts:37`） |
| `Mod+Alt+P` | **解放**（旧 `focusRelatedScenes`。related-scenes 廃止に伴い削除） | 旧 keybindings から除去（現状 keybindings.ts に該当なし） |

`Mod` はプラットフォーム依存（Win/Linux = Ctrl）。常駐コマンドパレットは
撤去済みのため、Scene Context にはショートカットまたはパネルトグルから到達する。

---

## 実装ファイル配置

| ファイル | 役割 |
|----------|------|
| `src/features/tree/SceneContextPanel.tsx:23-72` | ホスト。`PanelHeader(panelId="codex-quick")` + 2 セクションの縦積み・sort select 生成 |
| `src/features/tree/CodexQuickSection.tsx:24-196` | Codex セクション本体（自動検出・色ドット・ピン留め） |
| `src/features/related-scenes/RelatedScenesSection.tsx:45-132` | 関連過去シーンセクション本体（fetch gate・状態表示・行ジャンプ） |
| `src/features/related-scenes/RelatedScenesSection.tsx:23-29` | `navigateToScene`（削除済みシーンの存在チェック → `requestSceneChunkJump`） |
| `src/features/layout/CollapsibleSection.tsx:26-54` | 汎用折りたたみ部品（`data-panel-header` 非付与の判断は `:18-25`） |
| `src/features/layout/panelComponents.tsx:4,37` | `"codex-quick": SceneContextPanel` 登録 |
| `src/features/layout/panelIcons.ts:31` | `"codex-quick": ScanSearch` |
| `src/features/layout/panelRegions.ts:12,37` | region `"left"` / ショートカット `Ctrl+Alt+Q` |
| `src/features/layout/toolWindowDefaults.ts:45` | `DEFAULT_SLOT_MAP["codex-quick"] = "LB"` |
| `src/features/layout/layoutPresets.ts:91-92,173,268,354-355,445` | 5 ビルトインプリセット |
| `src/features/layout/layoutStateUtils.ts:87-88,148-` | `stripUnknownPanels`（related-scenes 自動除去） |
| `src/features/layout/layoutStateUtils.test.ts:655-693` | related-scenes 削除の回帰ガード |
| `src/features/settings/keybindings.ts:71-73` | `focusCodexQuick = Mod+Alt+Q` |
| `src/db/schema.ts:236-247` | `codexQuickPins` Drizzle 定義（migrate.rs のミラー） |
| `src-tauri/crates/grimodex-db/src/migrate.rs:118-123` | `codex_quick_pins` SQL 正本 |
| `src/locales/ja.json:1225,3495-3496` / `src/locales/en.json:1225,3500-3501` | 表示名・節見出しの i18n |

---

## 既存設計書との整合

Scene Context は 2 つの旧パネル設計書を「セクション挙動の正本」として温存し、本書は
統合（ホスト構造・レイアウト登録・id 維持戦略）に集中する。

- [[Grimodex_CodexQuickパネル設計書]] — Codex セクションのマッチング・ピン永続化・
  タブ種別挙動・split mode・「今の真実」バッジ／未開示伏線警告の正本。「独立パネル」
  「Dock 登録」記述は本統合で無効化（パネルではなくセクション）。
- [[Grimodex_関連する過去シーンパネル設計書]] — 関連過去シーンセクションの検索・
  ランキング・dense 勝者アンカー・時間軸（`phase_resolution_mode`）・設計上の制約の
  正本。パネル登録・tool window id・`Ctrl+Alt+P`・5 プリセット登録の記述は本統合で無効化。
- [[Grimodex_セマンティック検索設計書]] — 関連過去シーンが転用する `semantic_search` の
  上流。閾値・モデル特性は [[Grimodex_セマンティック検索の閾値とモデル特性]]。
- [[Grimodex_パネルヘッダー設計書]] — `PanelHeader` / `data-panel-header` ジェスチャの
  標準（CollapsibleSection が見出しに付与しない理由の前提）。
- [[Grimodex_レイアウトシステム置換設計書]] — panelIds / プリセット / stripUnknownPanels の
  上流。
- 上流計画 / 仕様: `docs/superpowers/specs/`・`docs/superpowers/plans/` 配下（フェーズ
  解決の適用範囲拡大など）。

---

## 未実装 / 今後

- **実機 GUI QA（残）**: ストライプ整列・最大化ジェスチャ・split mode でのセクション
  更新は単体／回帰テストでガード済みだが、左 stripe 実寸での折りたたみ挙動・スピナー
  整列の実機確認は findings 上「未確認」。レイアウト幾何が絡むため、必要なら
  `*.browser.test.tsx`（`layoutInvariants.browser.test.tsx`）での追加 gate を検討。
- **横断ドキュメントの追従（未確認）**: [[Grimodex_Scenesパネル設計書]] /
  [[Grimodex_Editorパネル設計書]] / [[Grimodex_統合DBスキーマ]] 等に残る旧
  「Codex Quick / related-scenes 独立パネル」前提の記述は、本統合に合わせた更新が
  未反映の可能性がある（出荷日・反映状況は findings に無く未確認）。
- 出荷情報: PR#215 / commit `9662f0c1` / 2026-06-29（git ログで確認済み）。
