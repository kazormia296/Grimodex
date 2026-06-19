# Grimodex 関連する過去シーンパネル設計書

## 概要

「関連する過去シーン」は、いま編集中のシーンに意味的に関連する**「前の」シーン**（既定＝
読書順で前＝既読。`phase_resolution_mode` が story/auto なら作中時系列で前）を一覧する専用
tool window パネル（`src/features/related-scenes/RelatedScenesPanel.tsx`、tool window id
`related-scenes`）。クリックでそのシーンの一致箇所へジャンプできる。

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
- 「過去」の時間軸は**プロジェクトの `phase_resolution_mode`（reading/story/auto）に従う**
  （Codex フェーズ解決と統一。`computeSceneTimeIndex(nodes, resolutionMode)`）。
  - **reading**（既定）: 読書順（原稿ツリーの DFS = `computeGlobalSceneOrder`）。「過去＝既読＝
    原稿で手前」。回想シーンが読書順で後ろにあれば「未来（未読）」扱い。
  - **story / auto**: 作中時系列（`storyTimeOrder` 順、未設定シーンは読書順末尾）。「過去＝作中で
    前に起きた」。読書順では後ろの回想シーンでも作中時系列で前なら「過去」に入る。
  いずれも現在シーンより**前**だけを出し、現在シーン自身・現在以降・順序外（folder/削除済）は
  除外する。順序軸は `selectRelatedPastScenes` には透過で、渡された index map の前後だけで判定する。
  これが「単なる関連シーン（相関図領域）」との違い。Settings での mode 切替はパネルが購読して即時
  取り直す（`RelatedScenesPanel` が `resolutionMode` を effect 依存に持つ）。
- 各行は **1 シーン**（最良スコアのチャンクを代表に集約）。並び順は hybrid の RRF 融合＋
  dense 勝者アンカー（下記「検索とランキング」）、純 dense 時のみ cosine 降順、同点は sceneId で
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
  → buildSemanticRecallQuery({ userMessage: "", sceneBody })（本文末尾 最大 500 文字 = dense seed）
  → buildSparseQuery(query, body)（本文全体から固有名詞 seed を抽出し sparse 用に拡張＝③）
  → dense と sparse を並列取得（hybrid。一方が失敗してもグレースフルに退避）:
      semanticSearch({ projectId, query, limit: 30 })          … dense。失敗/未 index は空配列
      fetchSparseSceneIds({ projectId, query: sparseQuery })   … sparse=FTS5/bm25。失敗→dense 単独
  → computeSceneTimeIndex(treeStore.nodes, usePhaseStore.resolutionMode) で順序軸を算出
      （reading=読書順 / story・auto=作中時系列。reading は computeGlobalSceneOrder と同義）
  → selectRelatedPastScenes(hits, { currentSceneId, sceneOrder, minScore=gate, maxScenes=8,
      sparseSceneIds, rescueMargin=0.05, relativeRescue:{ gap=0.05 } })
  → パネルに行として描画（RRF 融合＋dense 勝者アンカーで順位付け、下記「検索とランキング」）
```

実装ファイル:

- `selectRelatedScenes.ts` — `selectRelatedPastScenes` 純関数（既読フィルタ＋1 シーン集約＋
  床＋sparse/相対救済の admit＋RRF 融合＋dense 勝者アンカー＋件数 cap）。ストア・DOM 非依存で
  単体テスト対象。
- `seedTerms.ts` — `buildSparseQuery` / `extractProperNounSeeds`。本文全体からカタカナ連続・
  大文字始まり Latin（連語可）の固有名詞 seed を頻度順に抽出し、sparse クエリを拡張する（③）。
  LLM 不要・決定的（シーンを開く度に走るので HyDE は不可）。漢字固有名詞は形態素器が無く対象外。
- `fetchRelatedScenes.ts` — `fetchRelatedPastScenes`。本文取得→クエリ組み立て→dense/sparse 並列
  取得→`computeSceneTimeIndex` で順序軸算出（`phase_resolution_mode` に従う）→選別の取得
  オーケストレーション。失敗は空配列／dense 単独フォールバック。
- `RelatedScenesPanel.tsx` — パネル UI（debounce fetch・loading/empty 状態・行クリック
  ジャンプ）。`usePhaseStore.resolutionMode` を購読し、順序軸の切替で再取得する。

## 検索とランキング（hybrid + dense 勝者アンカー）

固有名詞（人名・地名）は密ベクトルだと過小評価されがちで、小説では強い手がかりなのに
dense 単独だと recall を落とす。そこで Layer 4 RAG（チャット注入）と同じ **dense + sparse
(FTS5/bm25) の RRF 融合**を人間向けパネルにも適用する（2026-06-19, PR#126）。

- **admit（どのシーンを出すか）= recall**:
  - `denseConfident`: cosine ≥ 床（言語別 gate）。明確に関連。
  - `sparseRescue`: sparse 上位 N に居て cosine ≥ 床 − `rescueMargin(0.05)`。固有名詞の語彙一致で
    床ぎりぎり下を救済。
  - `relativeRescue`（②, browse 向けの recall 追加）: **二段ガード**で床下を救済。(a) cosine ≥
    床 − nearFloorMargin かつ (b) pool に明確な勝者（最大 cosine ≥ 床）が居る かつ (c) cosine が
    pool 中央値より `gap(0.05)` 以上際立つ — 3 条件全てで初めて admit。絶対床を撤廃しないので
    「勝者不在クエリの団子最上位を過大評価」を避ける（`docs/Grimodex_セマンティック検索の閾値と
    モデル特性.md` の二段ガード方式。ruri は無関係散文でも cosine が ~0.79 に座る高ベースライン）。
    注入用途では使わない（precision 優先）。誤検出コストの低い browse パネルだけで許容する。
- **rank（どの順に並べるか）= RRF 融合 + dense 勝者アンカー**:
  - `rrf(s) = 1/(k+rank_dense) + 1/(k+rank_sparse)`（k=`RRF_K`=60、sparse 不一致は dense 項のみ）。
  - **dense 勝者アンカー**（2026-06-19, PR#129）: RRF 純ソートは語彙一致の弱関連を「意味的に
    最も近い既読シーン（= dense 勝者）」の上へ押し上げ、パネル先頭の体験を劣化させる
    （R@1/MRR ↓）。そこで RRF ソート後、pool 最大 cosine のシーンが confident（床 ≥ gate）なら
    **その 1 件だけ rank1 に固定**する。固定は先頭のみで 2 位以降は RRF のまま残すので、固有名詞
    recall の押し上げ（R@3/recall の伸び）は維持される。勝者不在（rescue-only: 最大 cosine が床
    未満）では固定せず RRF の語彙順を尊重する。
  - これにより `hybrid R@1 ≥ dense R@1` が**構造的に保証**される（confident 勝者がいれば
    hybrid rank1 = dense rank1、不在なら dense は空＝R@1 0）。新しい閾値 knob は導入せず、admit が
    既に使う confidence 床（gate）を再利用するだけ。
- **チャット注入との差**: チャット recall（`selectHybridRecallChunks`）も同じ RRF を使うが、
  precision-first（top-1 ゲートで「明確な勝者が無ければ何も注入しない」all-or-nothing）かつ
  **dense 勝者アンカーは意図的に持ち込まない**。パネルは人間が判断する read-only なので recall
  寄り（per-scene 床 + 救済 + アンカー）にする。融合・救済・アンカーは `selectRelatedPastScenes`
  （純関数）に集約。

計測: 実埋め込みライブ eval ハーネス（`liveEval/relatedScenesLive.eval.test.ts`、production と同一
int8 ONNX で bilingual コーパスを実埋め込み。`embeddings.generated.json` は gitignore＝再生成可）が
dense/hybrid/+seed/+rel の Recall@k・Precision・MRR を実測し、`hybrid R@1 ≥ dense R@1` をゲートする。
実測（all=ja+en）: アンカー導入で R@1 0.29→0.40・MRR 0.60→0.73 を回復しつつ recall 1.00・R@3 0.54 を維持。

## 設計上の判断・制約

- **read-only**: DB 書き込み・schema 変更・Rust 変更なし。既存 `semantic_search` /
  `fts_search` / `semanticNavStore` / `computeSceneTimeIndex` / `loadSceneContent` を
  組み合わせるだけ（sparse 腕も既存 FTS5 を流用、Rust 0）。
- **hybrid（dense + sparse RRF）出荷済み**: 当初は dense 単独 MVP（2026-06-18）だったが、
  固有名詞 recall を補うため Layer 4 RAG と同じ RRF 機構＋固有名詞 seed 拡張（③）＋二段ガード
  相対救済（②）＋dense 勝者アンカーへ拡張（2026-06-19, PR#126/#129）。詳細は上記「検索と
  ランキング」。dense 単独へは sparse 失敗時にグレースフルに退避する（＝従来挙動）。
- **クエリは現在シーン本文のみ**: チャット recall と違いユーザー発話が無いので、dense seed は
  本文末尾だけ。sparse seed だけは本文全体の固有名詞で拡張する（末尾 500 字に主題が無い長い
  シーン対策、③）。本文が空（新規シーン等）ならクエリ空＝結果なし。
- **「過去」の時間軸は専用設定を増やさず `phase_resolution_mode` を再利用する**（2026-06-20）:
  当初は読書順固定だったが、Codex フェーズ解決が既に持つ reading/story/auto 設定にパネルも従わせる
  （`computeSceneTimeIndex`）。reading が既定かつ `computeGlobalSceneOrder` と同義なので既存
  プロジェクトの挙動は不変。**パネル独自の reading/story トグルは意図的に作らない** — 同一概念の
  2 つ目の設定を増やさず、プロジェクト全体の時間軸を 1 設定に統一するため。story モードでは「過去」が
  「既読」ではなく「作中で前に起きた」に変わる点に注意（回想の扱いが変わる。`storyTimeOrder` 未設定
  シーンは読書順末尾＝ほぼ未来扱い）。
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
