# Grimodex 関連する過去シーンパネル設計書

## 概要

「関連する過去シーン」は、いま編集中のシーンに意味的に関連する**読書順で前の（既読）
シーン**を一覧する専用 tool window パネル（`src/features/related-scenes/RelatedScenesPanel.tsx`、
tool window id `related-scenes`）。クリックでそのシーンの一致箇所へジャンプできる。

Grimodex のコア体験 **TALK→EXTRACT→RECALL** ループのうち、RECALL（過去に書いた／
抽出した知識を執筆中に引き戻す）を**初めて人間向け UI として出した read-only パネル**。
従来 scene のセマンティック検索は「AI のための recall」（Layer 4 RAG＝チャット文脈への
自動注入、`features/chat/semanticRecall.ts`）にしか使われていなかった。本パネルは同じ
`semantic_search` を人間向けに転用する（セマンティック検索設計書 §「関連する過去シーン
パネル」参照）。2026-06-18 出荷。

```
┌─────────────────────────────────────┐
│ 🕘 関連する過去シーン           ⟳   │  ← ヘッダー（右端に loading スピナー）
├─────────────────────────────────────┤
│ 井戸端の密談                  92% │  ← 章タイトル + スコア(%)
│   …エリカが鍵を渡した場面          │  ← 一致チャンク（2 行クランプ）
│ 赤い封蝋                      85% │
│   …封蝋の紋章は東の塔のもの        │
│ 裏切りの兆し                  85% │
└─────────────────────────────────────┘
   行クリックで該当シーンを開き、一致箇所へスクロール+選択
```

## 表示ルール

- 現在編集中シーン（`useTreeStore.activeSceneId`）が変わるたびに、その本文を seed に
  意味検索し、関連する**過去**シーンを出す。
- 「過去（既読）」= **読書順**（`computeGlobalSceneOrder` の正準 reading order）で現在
  シーンより**前**にあるシーンのみ。現在シーン自身・現在以降（＝未読）・順序外
  （folder / 削除済）は出さない。これが「単なる関連シーン（相関図領域）」との違い。
- 各行は **1 シーン**（最良スコアのチャンクを代表に集約）。スコア降順、同点は sceneId で
  安定ソート。最大 `RELATED_SCENES_MAX = 8` 件。
- スコアは cosine 類似度を `%` 表示（例 0.92 → `92%`）。`primary` 色のピル。
- 床（足切り）は**言語別 gate 値**（`recallParamsForLang().gateScore` = ja 0.85 / en 0.51）を
  **per-scene floor** として使う。チャット注入の top-1 ゲート（「明確な勝者が無ければ全部
  隠す」all-or-nothing）は使わない — 人間が関連性を判断できるパネルなので、各シーンが単独で
  「明確に関連」のバーを越えるものだけを出し、ruri の団子（無関係散文が ~0.79 に座る高
  ベースライン）混入を防ぐ。
- 状態別の表示:
  - アクティブシーン無し → `relatedScenes.noActiveScene`
  - 検索中で結果 0 → `relatedScenes.loading`
  - 完了して結果 0（該当なし／未 index／feature 無効ビルド） → `relatedScenes.empty`

## インタラクション

| 操作 | 動作 |
|------|------|
| 行をクリック | そのシーンを開き、一致チャンク位置へスクロール+選択。`requestJump → setActiveScene → showPanel("editor")` の順（順序は不変条件。`semanticNavStore` を EditorPane がシーンロード後に一度だけ consume する。意味検索ダイアログと同一機構） |
| `Ctrl+Alt+P` | パネルの表示トグル＋フォーカス（`focusRelatedScenes` キーバインド、既定 `Mod+Alt+P`） |

## データフロー

```
アクティブシーン (useTreeStore.activeSceneId) が変化
  → 400ms debounce（連打抑制。非表示 isActive=false なら検索しない＝keepalive）
  → loadSceneContent(sceneId)（DB の PM JSON）→ prosemirrorToText で plain text 化
  → buildSemanticRecallQuery({ userMessage: "", sceneBody })（本文末尾 最大 500 文字）
  → semanticSearch({ projectId, query, limit: 30 })（dense 単独。失敗/未 index は空配列）
  → computeGlobalSceneOrder(treeStore.nodes) で読書順を算出
  → selectRelatedPastScenes(hits, { currentSceneId, sceneOrder, minScore=gate, maxScenes=8 })
  → パネルに行として描画
```

実装ファイル:

- `selectRelatedScenes.ts` — `selectRelatedPastScenes` 純関数（既読フィルタ＋1 シーン集約
  ＋床＋件数 cap）。ストア・DOM 非依存で単体テスト対象。
- `fetchRelatedScenes.ts` — `fetchRelatedPastScenes`。本文取得→クエリ組み立て→
  `semanticSearch`→読書順算出→選別の取得オーケストレーション。失敗は空配列フォールバック。
- `RelatedScenesPanel.tsx` — パネル UI（debounce fetch・loading/empty 状態・行クリック
  ジャンプ）。

## 設計上の判断・制約

- **read-only**: DB 書き込み・schema 変更・Rust 変更なし。既存 `semantic_search` /
  `semanticNavStore` / `computeGlobalSceneOrder` / `loadSceneContent` を組み合わせるだけ。
- **dense 単独（MVP）**: sparse（FTS5/bm25）救済ハイブリッドは未実装。固有名詞（人名・
  地名）起点の recall を強めたい場合の Phase 2 候補。Layer 4 RAG の `ai.hybridRecall` と
  同じ RRF 機構を流用できる。
- **クエリは現在シーン本文のみ**: チャット recall と違いユーザー発話が無いので、seed は
  本文末尾だけ。本文が空（新規シーン等）ならクエリ空＝結果なし。
- **未 index / feature 無効**: `semantic_search` は `semantic-embedding` feature gate 内。
  無効ビルドや未 index プロジェクトでは静かに空配列へフォールバックし、`empty` 表示になる
  （チャット recall と同契約）。
- **ジャンプの順序契約は共有**: 行クリックの `requestJump → setActiveScene → showPanel`
  は `features/semantic-search/sceneChunkJump.ts` の `requestSceneChunkJump` に集約し、
  意味検索ダイアログ（`semanticSearchProvider`）と 1 実装を共有する。
- **list は取得時点のスナップショット（既知の軽微な stale）**: 取得後に tree が変化しても
  パネルはアクティブシーン変更まで再取得しない。(a) クリック先シーンが削除済みなら
  `navigateToScene` が tree 存在チェックで弾く（空エディタ誤生成を防ぐ）。(b) 並び替え後の
  「既読」境界ズレは表示上のみで、次のシーン切替で自己修復するため許容。tree 変更への即時
  追従は過剰フェッチを招くので MVP では行わない。
- **パネル登録**: 既定 region/slot は `BR`（center-bottom）、全 5 ビルトインプリセットで
  stripe 既定非表示（`hiddenStripePanels`、執筆統計と同様の「必要時に開く」運用）。
  登録は `panelIds` / `panelComponents` / `panelIcons`（`History`）/ `panelRegions` /
  `toolWindowDefaults` / `layoutPresets`（5 プリセット）/ `keybindings` / locale の 8 系統。
