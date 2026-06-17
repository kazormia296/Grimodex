# Grimodex セマンティック検索の閾値とモデル特性

本文セマンティック検索（関連シーン注入 / RAG）のスコア閾値設計の根拠と、採用方針・
将来オプションをまとめる。2026-06-14 のキャリブレーション実測 + Web 一次情報調査に基づく。

## 背景と観測

- モデル: ja=`cl-nagoya/ruri-v3-30m`（256d, mean pooling, prefix `検索クエリ: ` / `検索文書: `,
  L2 正規化ドット積 = cosine）、en=`BAAI/bge-small-en-v1.5`（384d, CLS pooling, prefix 無し）。
- 閾値 `SEMANTIC_RECALL_MIN_SCORE`（`src/features/chat/semanticRecall.ts`）で related chunk を選別。
- 計測ツール: `scripts/calibrate-embedding-threshold.py`（合成ペアの related/unrelated cosine 分布 →
  推奨閾値）と、dev の Run search eval（実機 `semantic_search` × クエリ集で Recall@k/閾値跨ぎ）。
- 観測: **ruri は無関係 0.79 / 関連 0.88（分離マージン ~0.05）**、**bge は無関係 0.40 / 関連 0.58
  （マージン ~0.18）**。ruri は全体が高く狭い帯に圧縮される。

## 結論

ruri の「高く狭い cosine 帯」は **対照学習（contrastive learning）+ 低温度パラメータで訓練された
埋め込みモデルに共通する既知かつ意図的な特性**であり、ruri のバグでも prefix の誤用でもない。
cosine の絶対値はモデル間で比較不能なので、**ja=0.85 / en=0.51 とモデル別に独立して閾値を
決めている現方針は教科書的に正しい**。

## Q1 / Q3 高ベースラインは「温度」由来・cosine の絶対値はモデル間非互換

- E5 公式 FAQ（`intfloat/multilingual-e5-base`）: InfoNCE 対照損失で温度 0.01 を使うため cosine が
  通常の −1〜1 でなく **0.7〜1.0 の帯に圧縮**される。これは既知・期待された挙動で、検索/STS では
  絶対値でなく**相対順位**が重要。公式ディスカッションに「完全に無関係な文ペアでも cosine 0.75 前後」
  の実例あり。
- ruri-v3-30m 公式モデルカードのサンプル自体が同じ挙動: 関連 0.948〜0.954 / **無関係 0.727〜0.744**。
  本プロジェクトの実測（無関係短句クエリ 0.73〜0.77 / 関連 0.82〜0.95）は公式例とほぼ一致 = **正常分布**。
- 理論背景: 埋め込み空間の**異方性（anisotropy）**で点群が細い円錐に乗り、角度が小さく cosine が
  高止まりする。arXiv 2403.05440「Is Cosine-Similarity Really About Similarity?」= 正則化次第で
  cosine は任意の類似度を生みうる → 絶対値を額面通り信用するな。
- cosine はクエリ間・**モデル間で比較不能**（arXiv 2408.04887 ほか）。閾値を普遍値として扱わない。
  多ドメイン corpus は単一トピックより自然に低い絶対値になる。
- 本ケースで分離マージンが公式例（0.73 vs 0.95 ≒ 0.20）より狭く見える（0.79 vs 0.89）のは、
  **doc-doc（長い散文シーン vs 散文シーン）を比べているため**。散文同士は「小説的文体」という共通成分を
  大量に共有するので無関係でもベースラインが 0.82〜0.84 に上振れ、短いクエリ句は共通成分が少なく
  0.73〜0.77 に落ちる。mean pooling が prefix トークン込み（`include_prompt: True`）なので、短い
  チャンクほど共通 prefix 成分の比率が上がりベースラインを押し上げる = 仕様どおり。

## Q2 prefix / pooling は正しい

- ruri-v3 は「1+3」prefix スキーム: `""`（意味エンコード）/ `トピック: `（分類・クラスタリング）/
  `検索クエリ: `（query）/ `検索文書: `（doc）。現用の `検索クエリ: ` / `検索文書: ` の使い分けは仕様どおり。
- pooling は mean（`pooling_mode_mean_tokens: True`）かつ `include_prompt: True`（prefix トークンも
  込みで平均）。設計と一致。
- prefix を外すと訓練前提が崩れて性能劣化（E5 で明言）。**「prefix を外してベースラインを下げる」のは
  誤った対処**。高ベースラインは正しく prefix を付けている結果でもある。

## Q4 サイズ別・reranker

JMTEB（公式モデルカード）。RAG で効くのは Retrieval 列:

| モデル | params | dim | 層 | JMTEB平均 | Retrieval |
|---|---|---|---|---|---|
| ruri-v3-30m（現用） | 37M | 256 | 10 | 74.51 | 78.08 |
| ruri-v3-70m | 70M | 384 | 13 | 75.48 | 79.96 |
| ruri-v3-130m | 132M | 512 | 19 | 76.55 | **81.89** |
| ruri-v3-310m | 315M | 768 | 25 | 77.24 | **81.89** |

- **130m が retrieval のコスパ点**。30m→130m で Retrieval +3.8pt。**Retrieval は 130m と 310m が同値**
  なので、検索目的だけなら 310m まで上げても retrieval は伸びない（STS/分類は 310m が上）。
  → 将来差し替えは **検索目的なら 130m で同等 retrieval + 同梱サイズを抑えられる**。
- 30m（37M, 256d）でも multilingual-e5-large(70.98) / text-embedding-3-large(74.48) / 旧 Ruri-Large
  v2(76.34) を上回る。現用選定は良い。
- **reranker は v3 では 310m（ModernBERT-Ja CrossEncoder, 最大8192トークン, model.safetensors ~1.26GB）
  の1サイズのみ**。ローカル同梱（Tauri）には embedding 310m よりさらに重い。小型は旧 v1/v2 系
  （`ruri-reranker-small` ~68M / `ruri-reranker-base` ~111M）だが旧トークナイザ（形態素分割前提）依存で
  Lindera 系の複雑さが reranker 側にも乗る。

## Q5 「関連 0.82 と 無関係 0.82〜0.84 が重なる」への対処（適合度順）

1. **reranker（cross-encoder）併用 — 最有効だが重い**。クエリと文書を連結同時スコアで、bi-encoder
   cosine より doc-doc を遥かによく分離。標準は「bi-encoder で top-K(12〜20) 粗取り → reranker で精選」。
   難点は v3 で 1.26GB 同梱。**MVP では入れず、precision 不満時に導入**。
2. **クエリ相対正規化（z-score / min-max）— 軽量・数行**。絶対閾値でなく、そのクエリのスコア分布内の
   相対位置で判定。本実装は「全チャンク総当たり → 降順ソート」済なので、ソート済み集合から z-score /
   min-max を算出するのは数行。`new = (cos − floor)/(1 − floor)` で 0.79〜0.89 を 0〜1 付近へ再マップ。
3. **top-1 マージン — 注入用途に好相性**。「絶対床（例 0.80）以上 かつ top-1 から一定差以内」の二段条件。
   無関係シーンが 0.82〜0.84 に団子状に並ぶ状況では、団子内の微差より「明確に抜けた1件があるか」を見る方が頑健。
4. **ハイブリッド（dense + sparse, bge-m3 等）**。固有名詞・語彙一致を sparse が補完。小説の人名・地名が
   「関連シーン」の強い手がかりなので相性良。**→ 2026-06-17 実装（下記「ハイブリッド検索」節）。**
5. 学習ベース（Cosine Adapter / MLP 分類器）。ラベル要・単一作品ツール規模では過剰。

## 採用方針（2026-06-14 確定）

- **ja=0.85 / en=0.51（モデル別・独立判定）**。`semanticRecall.ts` にコミット済。
- **注入用途は recall でなく precision 重視**: 無関係シーンを注入すると LLM を能動的にミスリードするので
  「迷ったら何も注入しない」方が安全。→ **ja=0.85 の precision 寄りは注入用途として妥当**。0.85 は
  無関係短句（0.73〜0.77）も無関係シーン（0.82〜0.84）も弾く。代償として弱く関連するシーン
  （0.816〜0.82）も落ちるが、注入では受け入れて良いトレードオフ。
- recall を取りに行くなら **0.80 へ下げる + 上記 2/3（正規化 or top-1 マージン）で団子を捌く**のが、
  reranker 同梱を避けつつの落とし所。
- 将来: 検索目的なら **130m**（310m と retrieval 同値・軽い）。precision 不満時に reranker（v3 は重い）。
  en 不満時は bge-base / multilingual-e5（**閾値は再キャリブレーション必須**）。

## ハイブリッド検索（dense + sparse/BM25, RRF）2026-06-17 実装

Q5 改善策 #4。密ベクトル（256/384 次元）は語彙完全一致を過小評価しがちで、固有名詞
（人名・地名）の recall を落とす。「アイリーン」を含むシーンを引きたいのに cosine が
ゲート（ja 0.85）下（例 0.83）に座って注入されない、という取りこぼしを補う。

- **配置**: フロント JS（`semanticRecall.ts`）。既存の Tauri コマンド `semantic_search`（dense）と
  `fts_search`（scope=`scenes`, trigram tokenizer, `ORDER BY rank` = bm25）を併用するだけで、
  Rust 変更なし。融合は `selectHybridRecallChunks`。
- **融合**: Reciprocal Rank Fusion。`rrf(s) = 1/(k+rank_dense) + 1/(k+rank_sparse)`（k=60）。
- **precision 維持（「迷ったら何も注入しない」を崩さない）**:
  - 土台は dense pool（本文と cosine を持つのは dense 側だけ。`HYBRID_FETCH_LIMIT=30` に拡大）。
  - `eligible(s) = sparseRescue(s) || (densePass && denseConfident(s))`。
    - `densePass` = 明確な勝者（cosine ≥ gate）が居る。
    - `denseConfident` = cosine ≥ 床（minScore）。
    - `sparseRescue` = sparse 上位 N（`SPARSE_LIMIT=10`）に居て cosine ≥ 床 − `RESCUE_MARGIN(0.05)`。
  - 勝者が居ない（densePass=false）時は **救済シーンだけ**注入。床は超えるが勝者でない団子
    （無関係 0.82〜0.84）を巻き込まない。救済も無ければ空（従来どおり）。
  - 救済の二段ガード: ① sparse 上位 N 限定（bm25 IDF が共通語を下げる）+ ② cosine ≥ 床−margin
    （語彙だけ一致する低 cosine の偶発ヒットを弾く）。
- **グレースフル**: sparse が空／失敗、または設定オフなら dense 単独選別（`selectSemanticRecallChunks`）へ退避。
  → FTS 未整備や feature 無効ビルドでも従来挙動と完全一致。
- **MVP 制約**: sparse でだけ一致して dense pool（上位 30）に居ないシーンは、本文・cosine を持たないため
  注入しない。将来は sparse-only シーンの本文 backfill（`semantic_chunk_context` 等）で対応余地あり。
- **設定**: `ai.hybridRecall`（project, 既定 ON, `ai.semanticRecall` が前提）。
- **未検証ゲート**: 実プロジェクト・実 LLM での recall/precision 効果は dev の Run search eval と
  実機ログ（`SemanticRecall mode=hybrid …` 行）で要計測。閾値（RESCUE_MARGIN / SPARSE_LIMIT）は暫定。

## 一次情報源

- ruri-v3-30m モデルカード（サイズ表・JMTEB・cosine 例・pooling 設定）: huggingface.co/cl-nagoya/ruri-v3-30m
- ruri-v3 コレクション（reranker は 310m のみ）: huggingface.co/collections/cl-nagoya/ruri-v3
- E5 公式 FAQ（温度 0.01 で cosine 0.7〜1.0 に分布する既知挙動）: huggingface.co/intfloat/multilingual-e5-base
- arXiv 2403.05440 "Is Cosine-Similarity Really About Similarity?"
- arXiv 2408.04887（relevance filtering / 相対比較）
- 異方性・スコア正規化の実務解説（dev.to "Cosine Similarity Lies…"）

## 関連

- 実装: `src/features/chat/semanticRecall.ts`（閾値・recall パラメータ・`selectHybridRecallChunks` RRF 融合）
- sparse: `src-tauri/src/database/fts.rs`（`search_fts` scope=scenes, trigram bm25）、`src/lib/fts.ts`（sanitizer）
- 計測: `scripts/calibrate-embedding-threshold.py`、`scripts/fixtures/{ja,en}-calibration.jsonl`、
  dev の Run search eval（`src/features/semantic-search/searchEval.ts`）、Dump chunks
  （`semantic_debug_dump`）
- spec: `src-tauri/src/semantic/spec.rs`（SPEC_JA / SPEC_EN）
