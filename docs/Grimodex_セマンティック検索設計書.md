# Grimodex セマンティック検索設計書

## 概要

作者が**自分の本文（散文）を意味で検索できる**ようにする機能。既存の FTS5
全文検索は 3 文字 n-gram の字句一致なので、「嵐の描写」で `雨が窓を叩いていた` を
引けない。本機能は dense embedding（日本語=ruri-v3 / 英語=bge、§埋め込みモデル）で
本文をチャンク化・インデックス化し、ローカル推論でクエリと比較してトップ-K を返す。
さらに Codex エントリのセマンティック検索と、チャット文脈への自動注入（Layer 4 RAG・
dense+sparse ハイブリッド）まで拡張済み。

実装上流のタスクコンテキスト（作業用メモ `temp/semantic-prose-search-context.md`）は非追跡のため本リポジトリには含まれない。
本書は **実装で確定した最終形** をまとめる正本であり、上流コンテキストとの差分
（実装中に追加された防御層など）も明記する。

### 設計の柱

1. **全ローカル推論**: クエリ・本文ともに端末上で完結。API キーや外部通信を
   要求しない。`ort` クレートで ONNX Runtime を介し、プロジェクト言語に応じて
   日本語=ruri-v3-30m (256 次元) / 英語=bge-small-en-v1.5 (384 次元) を動かす（§埋め込みモデル）。
2. **チャンク単位の検索**: シーン全体ではなく数百文字単位のチャンクを返し、
   結果から本文の該当箇所へジャンプできるようにする。
3. **書き味に干渉しない**: 検索インデックスは保存パイプラインの後段で debounce
   付き fire-and-forget。失敗しても本文保存には影響しない。
4. **モデル変更耐性**: モデル/チャンク化ルールが変わったら自動的に stale と
   判定して再構築できるよう、各チャンクに識別子を残す。

### スコープ外（本機能では扱わない）

* 複数プロジェクト横断検索（§4 「Phase 1 は単一プロジェクト前提」）

> **（2026-06-18 追記）当初スコープ外だった以下は出荷済み**:
> * **Codex のセマンティック検索** — 出荷済み（旧「不採用」記述は誤り）。
>   1 エントリ 1 ベクトルの専用 index (`codex_chunks`) を持ち、Agent Mode の
>   `search_codex` ツールの dense アーム（sparse と RRF 融合）として動く。本文専用 UI
>   ダイアログは持たない。詳細は §「Codex セマンティック検索」。
> * **Layer 4 RAG コンテキスト注入** — 出荷済み。drafting チャットの文脈に意味検索
>   ヒットを自動注入する `features/chat/semanticRecall.ts`。dense + sparse(BM25) の
>   RRF ハイブリッドで実装。詳細は §「Layer 4 RAG（チャット文脈注入）」。
> * **字句一致と意味検索のハイブリッドスコア** — RRF 融合として実装済み。chat 注入
>   経路（semanticRecall）と codex 検索（search_codex）の両方で dense と FTS5 sparse を
>   Reciprocal Rank Fusion する。

---

## FTS 全文検索との境界

`features/search/GlobalSearchDialog.tsx` (FTS5) と本機能 (`features/semantic-search/
SemanticSearchDialog.tsx`) は **同じ Ctrl+Shift+F で開く同じ Dialog** からタブ切替
で行き来できる。両者は責務が異なるため統合しない (UI 設計時にユーザ合意済み)。

| 観点 | FTS5（字句検索） | セマンティック（本機能） |
|---|---|---|
| 検索の性質 | 3 文字 n-gram の確定論的一致 | ニューラル embedding のコサイン |
| 結果単位 | scene / codex / snippet | scene 内の chunk |
| 応答時間 | サブミリ秒 | 50ms〜数百 ms (Embedder 初回は 0.5〜2s) |
| 索引更新 | DB trigger で即時 | シーン保存 → 2.5s debounce → 非同期 |
| 既存実装 | `commands::integrity::fts_search` | `commands::semantic::semantic_search` |

モード切替は `searchModeStore.ts` (Zustand persist) が `"lexical" \| "semantic"` を
localStorage に保持する。`SearchDialog.tsx` ラッパーが store の値を見て出し分け、
両 Dialog 上部のタブから `setMode(...)` で再描画させる。

---

## 全体アーキテクチャ

```
[Editor / Settings / DevTools]
        │
        │ シーン保存 → scheduleSceneIndex(sceneId)  // 2.5s debounce
        │ 検索クエリ → semanticSearch(...)
        │ 状態確認 → semanticIndexStatus(...)
        │ 全再構築 → semanticReindexAll(...)        // progress event
        ▼
[features/semantic-search]  ─────── frontend
        │ invoke('semantic_*', ...) / listen('semantic:reindex_progress')
        ▼
[commands/semantic.rs]      ─────── Rust Tauri commands (feature-gated)
        │
        │ ┌──────────────────────────────────────┐
        │ │ SemanticEmbedderState                 │  ONNX Session (lazy, dir_name 別)
        │ │  Mutex<HashMap<&str, Embedder>>       │   (ja=ruri / en=bge を同居キャッシュ)
        │ └──────────────────────────────────────┘
        │ ┌──────────────────────────────────────┐
        │ │ SearchCache / CodexSearchCache        │  scene_id / entry_id → CacheEntry
        │ │  Mutex<HashMap<id, CacheEntry>>       │   (model/dim/version 付き)
        │ └──────────────────────────────────────┘
        │
        ▼
[semantic::spec]      project language → EmbeddingModelSpec (ja/en)
[semantic::chunker(_en)] ProseMirror JSON → ChunkerConfig → Vec<SceneChunk>
[semantic::embedding] tokenizer + ONNX inference (spec 駆動) → L2 正規化済み Vec<f32>
[semantic::index]     content_hash 検証 + DELETE/INSERT トランザクション
[semantic::search]    cache + コサイン Top-K + dialogue_ratio 減点
        ▼
SQLite (scene_chunks / codex_chunks テーブル)
```

* **Rust 側はすべて `semantic-embedding` Cargo feature の中**。
  `--no-default-features` 環境では `commands/semantic.rs` ごと外れる。
  pure logic (`semantic::index::upsert_*`, `semantic::search::run_search`) は
  Embedder に依存しないので `cargo test --no-default-features` で完全に検証できる。
* **Tauri State の取得は `AppHandle` 経由**。`tauri::async_runtime::spawn_blocking`
  が `Send + 'static` を要求し、`tauri::State<'_, T>` の lifetime を持ち越せないため、
  closure に `AppHandle` を move して内部で `app.state::<T>()` で取り直す。

---

## データモデル

### `scene_chunks` テーブル

Drizzle 定義: `src/db/schema.ts` (`sceneChunks`)、
Rust マイグレーション: `src-tauri/crates/grimodex-db/src/migrate.rs` の trash_items の直後に
同じ `execute_batch` 内で `CREATE TABLE IF NOT EXISTS scene_chunks ...` として追加。

| カラム | 型 | 説明 |
|---|---|---|
| `id` | TEXT PK | uuid v4 (Rust で採番) |
| `scene_id` | TEXT FK → `tree_nodes(id)` ON DELETE CASCADE | シーンノード id |
| `chunk_index` | INTEGER | シーン内の 0-based 順序 |
| `text` | TEXT | チャンク本文 (取り出した時の plain text) |
| `char_start` | INTEGER | plain text 上の Unicode scalar 開始位置（**byte index でも UTF-16 code unit でもない**） |
| `char_end` | INTEGER | 同上、exclusive |
| `dialogue_ratio` | REAL DEFAULT 0 | チャンクに占める会話文字数比 (0.0〜1.0) |
| `embedding` | BLOB | f32 配列、little-endian flat、L2 正規化済み |
| `embedding_dim` | INTEGER | 256 / 768 等。長さ整合 + モデル変更検出 |
| `model_id` | TEXT | 例: `cl-nagoya/ruri-v3-30m@local/model_int8.onnx/prefix-v1` |
| `content_hash` | TEXT | シーン本文の SHA-256 hex (race condition 検出) |
| `chunker_version` | TEXT | 例: `semantic-prose-chunker-v1` |
| `created_at` | INTEGER | ms-since-epoch（Drizzle `mode: "timestamp"` と一致） |
| `updated_at` | INTEGER | 同上 |

インデックス:
* `idx_scene_chunks_scene` on (scene_id)
* `idx_scene_chunks_model` on (model_id)
* `uq_scene_chunks_scene_index` UNIQUE (scene_id, chunk_index)

**マイグレーションは Drizzle migration スクリプトを生成しない**
(`CLAUDE.md` の「drizzle-kit migration は生成しない」運用に倣う)。
Drizzle 側はスキーマ整合のために定義し、`schema.test.ts` で SQL 生成を確認する。
実 DB に対する CREATE TABLE は Rust 側だけが担う。

### `codex_chunks` テーブル（2026-06-18 追記）

Codex セマンティック検索用（§「Codex セマンティック検索」）。scene と違い
**チャンク分割せず 1 entry = 1 ベクトル**なので PK は `entry_id`（= `codex_entries(id)`
への FK、`ON DELETE CASCADE`）。Rust マイグレーション `migrate.rs` の `scene_chunks`
直後の同じ `execute_batch` で `CREATE TABLE IF NOT EXISTS codex_chunks ...` する。

主なカラム: `entry_id` (TEXT PK/FK) / `entry_name` / `entry_type` / `text`
（埋め込んだ平文 `name。aliases。summary。本文`）/ `embedding` (BLOB, f32 LE flat,
L2 正規化) / `embedding_dim` / `model_id` / `content_hash` (entry の SHA-256) /
`chunker_version` / `created_at` / `updated_at`。インデックスは
`idx_codex_chunks_model` on (model_id) のみ。

> **`codex_chunks` は Drizzle `schema.ts` に定義が無い Rust 専用テーブル**
> （`scene_chunks` と異なり Drizzle 側ミラーを持たない）。CREATE / 読み書きは
> 完全に Rust 側で完結する。DDL の正本は
> [`docs/Grimodex_統合DBスキーマ.md`](./Grimodex_統合DBスキーマ.md) の
> `codex_chunks` 節を参照（本書では再掲しない）。

DB スキーマ詳細（`scene_chunks` / `codex_chunks` の完全な DDL）は
[`docs/Grimodex_統合DBスキーマ.md`](./Grimodex_統合DBスキーマ.md) を正本とする。

---

## チャンク化戦略

実装: `src-tauri/src/semantic/chunker.rs`。
バージョン定数 `CHUNKER_VERSION = "semantic-prose-chunker-v1"`。
**ProseMirror / TipTap JSON 起点で行う**（生 plain_text から再構築しない）。

### 第1段階 — 段落抽出と分類

1. doc を descend して `paragraph` ノードのテキストを順に拾う。
   - `sceneBeat` サブツリーは **本文ではないのでスキップ**。
   - `generatedProseBlock` 等のラッパーは中身に降りる。
2. 各段落を以下で分類:
   - 先頭の非空白文字が `「` または `『` なら **Dialogue**。
   - それ以外 (空段落含む) は **Prose**。

### 第2段階 — Dialogue tag の吸収

直前段落が Dialogue、現在段落が 80 字以下かつ発話・反応動詞を含む場合は、
**直前 Dialogue ビートに同一 unit として吸収**する。発話動詞辞書（控えめ）:

```
言った / 尋ねた / 答えた / 呟いた / つぶやいた / 叫んだ / 笑った / 頷いた / うなずいた / 首を振った
```

誤結合より誤分離を優先（長い地の文段落は吸収しない）。

### 第3段階 — 長い Prose の文分割（括弧深度カウンタ）

`target_max_chars`（500）を超える地の文段落は、`split_sentences_ja` で文単位に
割ってから再パッキングする。

```rust
// 括弧深度を考慮した日本語文分割
// 深度 0 のときだけ 。！？ で区切り、直後の閉じ括弧・連続終端記号を同じ文に飲み込む
```

エッジケース:
* 三点リーダ `……` 単体では区切らない
* 閉じ括弧の不均衡は `.max(0)` で破綻させない（`「やあ」と言った。次の文。` も区切れる）
* `『』` ネストは深度カウンタが正しく扱う

### 第4段階 — パッキング

`ChunkerConfig::default()`:
* `target_min_chars = 200`
* `target_max_chars = 500`
* `overlap_sentences = 1`
* `dialogue_tag_max_chars = 80`

`current_chars >= target_min && current_chars + next > target_max` でチャンクを切り、
末尾の 1 sentence-unit を次チャンク先頭に持ち越す（10〜20% 重なり目安）。
**シーン境界は絶対に跨がない**。

### char_start / char_end の単位

`paragraphs.join("\n")` の **Unicode scalar index**。

* Rust の `char_indices()` が返す byte index ではない。
* JavaScript 文字列の UTF-16 code unit でもない。
* スライス用に内部で byte index を持つのは可。**保存値は scalar index に変換する**。

将来的に UTF-16 起点の範囲指定が必要になったら別カラム
`plain_text_start_utf16` / `_end_utf16` を追加する（現状は不要）。

---

## 埋め込みモデル

実装: `src-tauri/src/semantic/embedding.rs`。モデル/言語固有のパラメータは
`src-tauri/src/semantic/spec.rs` (`EmbeddingModelSpec`) に集約する。

### 採用モデル（言語別 2 モデル体制 / 2026-06-18 追記）

プロジェクトの `language` 列で埋め込みモデルを切り替える
（`spec_for_language(language)`: `"en"` で始まれば英語 spec、それ以外は日本語 spec）。
得られた `model_id` / `embedding_dim` / `chunker_version` を `scene_chunks` /
`codex_chunks` に書くので、プロジェクトの言語（やモデル）を切り替えるとその
チャンクは stale 判定され `semantic_reindex_all` で再構築される。

| | 日本語 (`SPEC_JA`) | 英語 (`SPEC_EN`) |
|---|---|---|
| モデル | `cl-nagoya/ruri-v3-30m` (Apache 2.0, ModernBERT-Ja) | `BAAI/bge-small-en-v1.5` (MIT, plain BERT) |
| 次元 | 256 | 384 |
| pooling | `MeanWithMask` (attention-mask 重み付き mean) | `Cls` (先頭トークン) |
| prefix | query `検索クエリ: ` / doc `検索文書: ` | 無し（prefix-free） |
| `token_type_ids` | 不要 (ModernBERT) | 必要（zeroed を渡す） |
| `max_seq_len` | 8192 | 512 |
| dir | `resources/semantic/ruri-v3-30m/` | `resources/semantic/bge-small-en-v15/` |
| `model_id` suffix | `@local/model_int8.onnx/prefix-v1` | `@local/model_int8.onnx/en-v1` |
| `chunker_version` | `semantic-prose-chunker-v1` | `semantic-prose-chunker-en-v1` |
| golden fixture | `ruri_v3_30m_golden.json` | `bge_small_en_v15_golden.json` |

`scene_chunks.model_id` / `codex_chunks.model_id` に書く文字列は spec の
`full_model_id()`（= `model_id + model_id_suffix`）で言語ごとに変わる。
例: 日本語 `cl-nagoya/ruri-v3-30m@local/model_int8.onnx/prefix-v1`。
**revision pin・量子化バリアント・prefix ルール変更・モデル種別を識別できる粒度**にする。

* ONNX: 日本語は `model_int8.onnx` (36MB)、英語 bge も int8 (~34MB)
* Tauri 配布物への組み込み: `tauri.conf.json#bundle.resources` に両 dir 登録済み

#### 英語モデルの `max_seq_len=512` 罠

bge は plain BERT で position embedding が 512 固定。英語プロジェクトに日本語本文が
混ざると CJK 1 文字 ≈ 1 bge トークンで 512 を超え、`/embeddings/Add_1`
(word+position broadcast) が実行時クラッシュする。そのため tokenizer 側で
`max_seq_len` まで truncate する。一方 ruri (ModernBERT) は 8192 まで扱えるので
日本語チャンク（~760 トークン）は決して truncate されず、既存 ja 埋め込みは
バイト同値を保つ（`spec.rs` の ja-invariant ユニットテストで固定）。

#### 言語別チャンカー

`spec.chunker_config()` が言語別の `ChunkerConfig` を返す。英語は文字あたりの
情報量が低いのでチャンク目標を約 2 倍にする（`target_min=400 / max=1000 /
dialogue_tag_max=120`）。`index::embed_scene_payloads` が日本語=`chunk_scene`、
英語=`chunk_scene_en`（`chunker_en.rs`、`grimodex_lint::textscan::en` の文/引用
スキャンを使い、1 段落内に narration と引用が混在する英語に合わせて
`dialogue_chars` を引用スパンから数える）に振り分ける。

### 推論パイプライン

spec に従って分岐する（以下は日本語 ruri の例。英語 bge は prefix 無し・
`token_type_ids` 必要・CLS pooling）:

1. spec の prefix を付与（ja: `検索クエリ: ` / `検索文書: `、en: 無し）
2. HF `tokenizers` で `input_ids`, `attention_mask`（+ `spec.needs_token_type_ids`
   なら zeroed `token_type_ids`）に変換。`spec.max_seq_len` で truncate（§512 罠）
3. ort で `last_hidden_state` を取得（`token_embeddings` 出力名にもフォールバック）
4. `spec.pooling` で 1 ベクトルに集約 — ja は attention_mask 重み付き **mean pool**
   （prefix トークンも含めた `include_prompt: True` 相当）、en は **CLS**（先頭トークン）
5. **L2 正規化**

L2 正規化済み出力同士はドット積 = コサイン類似度になるため、検索時のスコアリングは
`semantic::search::dot_product` で済む。

### 検収条件（golden test）

`tests/embedding_golden.rs` 内 `#[cfg(test)] mod golden` で gated 実行。
Python `sentence-transformers` で生成した各 spec の golden fixture
（`tests/fixtures/{ruri_v3_30m,bge_small_en_v15}_golden.json`、`spec.golden_fixture`）
と Rust 出力を比較する。

* **fp32 ONNX**: cosine >= 0.9999 (パイプライン正当性)
* **量子化 ONNX**: fp32 比 cosine >= 0.99 (量子化誤差は許容)

fixture や ONNX が不在なら silent skip（CI / サンドボックス対応）。
golden が落ちたまま検索 UI へ進むことは禁止 (§2.2)。

---

## インデックス更新

実装: `src-tauri/src/semantic/index.rs` (pure logic) +
`commands/semantic.rs::semantic_index_scene` (Tauri command)。

### フロー

```
[scheduleSceneIndex(sceneId)]      // フロント (scheduler.ts)
  └─ 2.5s debounce
     └─ invoke('semantic_index_scene', { sceneId })
        └─ spawn_blocking:
           ├─ load_embedder (lazy, first invoke only)
           ├─ with_db (1): SELECT content WHERE id=? AND node_type='scene'
           │  → initial_hash = sha256(content)
           ├─ chunker::chunk_scene(doc) → Vec<SceneChunk>
           ├─ embedder.embed_document(chunk.text) × N → Vec<Vec<f32>>
           └─ with_db (2): upsert_scene_chunks
              ├─ unchecked_transaction()
              ├─ SELECT content (再読込)、hash 再計算
              ├─ initial_hash != current_hash → SkippedHashMismatch (Drop で rollback)
              ├─ DELETE FROM scene_chunks WHERE scene_id = ?
              ├─ INSERT × N (各 chunk)
              └─ commit
        └─ Indexed(n) なら cache.invalidate(sceneId)
```

### content_hash race detection

並行する scene 保存と embedding 実行のレースを防ぐ:

```
t0: ユーザがシーン編集 → 保存 A → schedule(sceneId)
t1: 2.5s 経過 → embed 開始 (initial_hash = h_A)
t2: ユーザがさらに編集 → 保存 B → schedule(sceneId) (timer リセット)
                          ↑ scene.content は h_B に
t3: t1 の embed が完了、upsert へ
    upsert TX 内で content 再読込、現在 hash = h_B
    h_A != h_B → SkippedHashMismatch → 何も書かずに drop で rollback
t4: t2 の embed が新たに開始
    embed 完了、upsert で h_B 一致 → 確定
```

**TX 内で必ず再 SELECT して再 hash 計算する**ことで、`with_db` を 2 回に分けた
ぶんの隙間 (workspace mutex を解放している間) を塞ぐ。`tree_nodes` への書き込みは
`commands::db::db_execute` が同じ workspace mutex 経由で行うので直列化されている。

### stale 判定

`UpsertOutcome`:
* `Indexed(usize)` — 確定 (チャンク数を返す)
* `SkippedHashMismatch` — content_hash 不一致で破棄
* `SkippedNotScene` — `node_type != 'scene'` または存在しない id

`semantic_index_status` で集計する `stale_chunk_count` は、現行
`model_id` / `embedding_dim` / `chunker_version` のいずれかが DB 行と異なる
チャンク数。`semantic_reindex_all` がそれを解消する。

### スケジューラ (frontend)

`features/semantic-search/scheduler.ts`:

* `scheduleSceneIndex(sceneId)` — scene_id 別タイマーマップ。既存タイマーをクリアして 2.5s
  後に発火。連続入力中はマージされる。
* 失敗は `debugLog.warn` にだけ流す（model 不在の dev で console を汚さない）。
* `EditorPane::coreSave` の scene 分岐末尾で呼ばれる。

正しさは Rust 側の content_hash 検証で担保されるので、フロントの debounce は
パフォーマンス最適化（無駄な embed を抑える）でしかない。

### プロジェクト open 時の自動 back-index（2026-06-18 追記）

逐次更新は「編集された scene / codex entry」しか index しないので、機能追加前から
在る・未編集のシーン/エントリは未 index のまま（dense 検索に乗らず sparse 退避）。
`features/semantic-search/autoIndex.ts` がプロジェクト open 時
（`App.tsx` の `ensureSemanticIndexesOnOpen(currentProjectId)`）に
**codex と scene の両方**を言語別に一括 back-index する。

* `ensureCodexIndexed` — まず軽量 `codex_index_status` で
  `indexedEntryCount < totalEntryCount` を判定し、不足時だけ `codex_reindex_all`。
* `ensureSceneIndexed` — `semantic_index_status` + scene 総数 count で
  「未 index または stale あり」を判定し、不足時だけ `semantic_reindex_all`
  （手動 reindex と `reindexProgressStore.running` で相互排他、進捗は既存トースト）。
* 充足済みなら embedder をロードせず即 return。失敗（feature 無効 / モデル不在）は
  無音でガードを外し、開き直しで再試行できる。1 セッション 1 プロジェクト 1 回。
* Rust 側は `codex_index_split_lock` / `index_scene_split_lock`（embed 中に
  workspace lock を持たない）で autosave 等を妨げない。

---

## 検索パイプライン

実装: `src-tauri/src/semantic/search.rs` (pure logic) +
`commands/semantic.rs::semantic_search`。

### 1. クエリの埋め込み

* `embedder.embed_query(query)` で spec の query prefix 込みで埋め込み
  （ja は `検索クエリ: ` 込み 256 次元、en は prefix 無し 384 次元）
* embedder Mutex は埋め込みが終わったら `drop(guard)` で release し、
  後段のスコアリング中に並行 invoke が embed できるようにする

### 2. 検索対象 scene の決定

`scene_scope: Option<&str>`:
* `Some(scene_id)` → 単一シーン (シーン内検索)
* `None` → `tn.project_id = ? AND sc.model_id = ? AND sc.embedding_dim = ? AND
  sc.chunker_version = ?` の distinct scene_id 全部

stale (識別子不一致) のチャンクは検索対象から除外される。

### 3. チャンクの読み出し（キャッシュ）

`SearchCache` (scene_id → `CacheEntry { model_id, embedding_dim, chunker_version, chunks: Arc<Vec<CachedChunk>> }`):

* `get(scene_id, model_id, dim, chunker_version)` — 識別子 3 軸を比較し、
  **すべて一致したときだけ hit**。一致しない stale エントリは取り出さずに削除する
  (`SearchCache` の防御層。`scene_chunks` 行のフィルタとは独立に効く)。
* `Arc<Vec<...>>` を返すことでロック保持時間を短くする (clone は arc bump のみ)。
* miss → `load_scene_chunks_from_db` で BLOB を decode → `put`
* `invalidate(scene_id)` — `semantic_index_scene` 成功時に呼ぶ
* `clear()` — `open_workspace` で呼び、別 workspace の cache poisoning を防ぐ

### 4. スコアリング

埋め込み出力は ja/en とも L2 正規化済みなので `dot_product(query, chunk) = cosine similarity`。

```rust
pub fn apply_dialogue_penalty(score: f32, dialogue_ratio: f32, description_mode: bool) -> f32 {
    if description_mode && dialogue_ratio > 0.6 {
        score * 0.85
    } else { score }
}
```

* `description_mode = true` で会話文中心 (ratio > 0.6) のチャンクを 0.85 倍に減点
* 順位差が 15% 以内のときに観察可能 (大差では順位が変わらない)

### 5. Top-K

全 chunks を `(score, &CachedChunk)` に変換 → 降順 sort → `truncate(limit)` →
`SearchHit { sceneId, sceneTitle, chunkText, charStart, charEnd, score, dialogueRatio }`
に clone して返す。

近似近傍探索や `sqlite-vec` は導入しない (単一作品の数千〜数万チャンクなら総当たりで十分)。

---

## Codex セマンティック検索（2026-06-18 追記）

実装: `src-tauri/src/semantic/codex_index.rs` (index) +
`src-tauri/src/semantic/codex_search.rs` (検索) +
`commands/semantic.rs` の codex コマンド群。

scene の index/search を「**チャンク不要・1 エントリ 1 ベクトル**」にフォークした版。
codex 本文は短い (80〜300字) ので段落チャンカーを通さず、entry 全体
（`build_codex_embed_text` = `name。aliases。summary。本文(平文)`）を 1 ベクトルで
埋める。eval (`scripts/eval-codex-recall.py`) で descriptive recall が出ることを確認済み。

* **テーブル**: `codex_chunks`（PK=`entry_id`、§データモデル）。
* **race detection**: scene と同型。`read_codex_for_index` で embed 前に hash 算出
  → embed 中は DB lock を放す → `upsert_codex_chunk` が TX 内で entry を再 SELECT・
  再 hash し `expected_hash` 不一致なら破棄（`CodexUpsertOutcome::{Indexed(1),
  SkippedHashMismatch, SkippedMissing}`）。
* **キャッシュ**: `CodexSearchCache`（`entry_id` 単位）。scene の `SearchCache` と
  同じ stale ガード（model_id / embedding_dim / chunker_version 一致時だけ hit）。
* **検索**: `run_codex_search` が project 配下の codex_chunks に総当たりコサイン →
  Top-K。project スコープは `list_indexed_codex_entry_ids` 側で効かせる（XPROJ 防御）。
  dialogue_ratio が無いので減点は無い。
* **逐次更新**: codex entry 保存後に `scheduler.ts::scheduleCodexIndex` が debounce
  付きで `codex_index_entry` を呼ぶ（scene の `scheduleSceneIndex` と同形）。
  `codex_index_split_lock` が embed 中に workspace lock を持たない（autosave 等を妨げない）。

### 消費側（専用 UI は無い）

codex セマンティック検索は **専用ダイアログを持たない**。Chat Agent Mode の
`search_codex` ツールの **dense アーム**として使い、JS 側
(`features/chat/agent/codexHybridSearch.ts::fuseCodexHybrid`) が `codex_semantic_search`
の dense 結果と sparse(FTS/LIKE) を Reciprocal Rank Fusion で融合する。融合は検索
ツール用の単純 RRF で、注入用の閾値較正は不要。

---

## Layer 4 RAG（チャット文脈注入）（2026-06-18 追記）

実装: `src/features/chat/semanticRecall.ts`（取得・選別）+ `chatStore.ts`（配線）+
`contextBuilder.ts`（プロンプト組み立て）。

drafting チャットの文脈に、意味検索で見つけた過去シーンの抜粋を自動注入する。
当初「Post-MVP」だったが出荷済み。

* **クエリ seed** = 直近ユーザー発話 + 現在シーン本文の末尾（DB 保存値、最大
  `SEMANTIC_RECALL_SEED_BODY_TAIL_CHARS=500` 文字）。`buildSemanticRecallQuery`。
* **配線**: `chatStore` が設定 `ai.semanticRecall`（既定 true）を見て `fetchSemanticRecall`
  を呼び、結果を `contextBuilder` の `semanticRecall` 入力へ渡す。注入先はクエリ毎に
  変わるため cacheSegments（prompt cache 安定領域）ではなく prompt + volatileTail。
* **グレースフル**: `semantic_search` は feature gate 内なので、無効ビルドや未 index
  プロジェクトでは静かに空配列へフォールバックする。

### dense + sparse ハイブリッド (RRF)

dense 単独は固有名詞 (人名・地名) の recall を落としやすいので、既存 FTS5 (trigram,
scene 本文 index) を sparse ランカーとして併用し RRF で順位融合する。設定
`ai.hybridRecall`（既定 true、`semanticRecall` が前提）で切替。

* `RRF_K = 60`（順位 r の寄与 1/(k+r)）
* `SEMANTIC_RECALL_RESCUE_MARGIN = 0.05`: sparse top-N に居れば cosine が床を
  `floor - margin` まで割っても注入を許す救済。語彙一致だが意味無関係な偶発ヒットは
  bm25 IDF と二段で弾く。
* 選別: `selectSemanticRecallChunks`（dense 単独）/ `selectHybridRecallChunks`（融合）。

### 言語別の閾値（`recallParamsForLang`）

| | 日本語 (ruri) | 英語 (bge) |
|---|---|---|
| 注入床 `MIN_SCORE` | 0.80 | 0.51 |
| top-1 ゲート | 0.85 | = 床 (0.51) |
| 1 チャンク注入文字数上限 | 600 | 900 |

ruri は無関係な散文どうしでも cosine が ~0.79 に座る高ベースラインなので、
「明確な勝者 (ゲート 0.85) がいる時だけ床 0.80 まで二番手を拾う」top-1 ゲート +
runner-up 床方式にする。bge は related↔unrelated の分離マージンが広いので
ゲート = 床（単一閾値）。詳細は `docs/Grimodex_セマンティック検索の閾値とモデル特性.md`。

### dev 評価ハーネス（`searchEval.ts`）

クエリ → 期待シーン集を **実機の `semantic_search`**（int8-ONNX 経路）に流し、
Recall@1/@3・MRR・閾値跨ぎ・閾値 sweep・miss/junk を集計する dev 専用ツール。
`recallParamsForLang` を共有する。

### 「関連する過去シーン」パネル（人間向け recall）（2026-06-18 追記 / 2026-06-29 Scene Context へ統合 PR#215）

実装: `src/features/related-scenes/`（`fetchRelatedScenes.ts` 取得 +
`selectRelatedScenes.ts` 選別純関数 + `RelatedScenesSection.tsx` UI）。Scene Context
パネル内のセクション（パネル設計書 `docs/Grimodex_関連する過去シーンパネル設計書.md`）。

Layer 4 RAG が「AI のための recall（チャット文脈へ自動注入）」なのに対し、本パネルは
**同じ scene semantic search を人間向け UI に転用**したもの。現在編集中シーンに意味的に
関連する「読書順で前の（既読）シーン」を一覧し、クリックで該当箇所へジャンプする
（TALK→EXTRACT→**RECALL** ループの RECALL を初めて人間向けに出す read-only パネル）。

* **クエリ seed** = 現在シーン本文の末尾のみ（`loadSceneContent` → `prosemirrorToText`
  → `buildSemanticRecallQuery({ userMessage: "", sceneBody })`）。チャット発話は無い。
* **取得（hybrid, 2026-06-19 PR#126）**: dense（`semanticSearch`, `limit=30`）と sparse
  （`fetchSparseSceneIds` = FTS5/bm25）を**並列取得**。sparse クエリは `buildSparseQuery` で
  本文全体の固有名詞 seed を足して拡張する（③）。失敗・未 index は空配列／dense 単独へ
  グレースフルに退避（チャット recall と同契約）。
* **選別**（`selectRelatedPastScenes` 純関数）:
  - 「前のシーン」の時間軸は**プロジェクトの `phase_resolution_mode` に従う**
    （`computeSceneTimeIndex(nodes, resolutionMode)`、Codex フェーズ解決と統一、2026-06-20）。
    reading（既定）= 読書順（既読＝原稿で手前、`computeGlobalSceneOrder` と同義）、story/auto =
    作中時系列（`storyTimeOrder` 順、未設定は読書順末尾）。いずれも現在シーンより**前**だけを残し、
    現在シーン自身・現在以降・順序外（folder/削除済）は除外。パネルは `resolutionMode` を購読し
    切替で再取得する（パネル独自トグルは作らず設定を 1 本化）。
  - 床 = **言語別 gate 値**（`recallParamsForLang().gateScore`、ja 0.85 / en 0.51）を
    **per-scene floor** として使う。チャット注入の top-1 ゲート（「明確な勝者が無ければ
    全部隠す」）は使わない — 人間が関連性を判断できるパネルなので all-or-nothing は不要。
    代わりに各シーンが単独で「明確に関連」のバーを越えるものだけ出し、ruri の団子混入を防ぐ。
  - **救済**: sparse 上位の語彙一致シーンを `rescueMargin=0.05` で床ぎりぎり下まで救済（固有名詞
    補強）＋ browse 向けに二段ガード相対救済（②, `relativeRescue.gap=0.05`）。
  - **ランキング**: dense と sparse 順位を **RRF 融合**（`RRF_K=60`）。ただし pool 最大 cosine の
    シーンが confident（床以上）なら**その 1 件だけ rank1 に固定する dense 勝者アンカー**
    （2026-06-19 PR#129）。RRF が語彙一致の弱関連を意味的最近傍の上へ押す browse トレードオフを
    先頭だけ打ち消し（`hybrid R@1 ≥ dense R@1` を構造保証）、2 位以降は RRF のまま recall 補強を
    維持。チャット注入はこのアンカーを**意図的に持ち込まない**（precision 優先）。
  - 1 シーン 1 行に集約（最良チャンクを代表に）、最大 `RELATED_SCENES_MAX=8` 件。
  - 計測: `liveEval/relatedScenesLive.eval.test.ts`（実 ONNX 埋め込みの bilingual eval、
    `embeddings.generated.json` は gitignore＝再生成可）。
* **ジャンプ**: 行クリックで `requestJump → setActiveScene → showPanel("editor")`（順序は
  不変条件。`semanticNavStore` 経由で EditorPane がシーンロード後にチャンク位置へスクロール+
  選択。意味検索ダイアログと同一機構）。
* **トリガー**: アクティブシーン変更で auto（400ms debounce）。非表示時（`isActive=false`）は
  検索しない（keepalive）。DB 書き込み・schema 変更なし。

---

## Tauri Command インタフェース

すべて `commands/semantic.rs` に実装、`semantic-embedding` feature gate 内。
serde は camelCase。

```rust
#[tauri::command]
async fn semantic_index_scene(app: AppHandle, scene_id: String) -> Result<usize>
// 戻り値: 挿入チャンク数 (0 = hash mismatch / 非 scene / 空 doc)

#[tauri::command]
async fn semantic_search(
    app: AppHandle,
    project_id: String,
    query: String,
    limit: usize,
    scene_scope: Option<String>,
    description_mode: Option<bool>,
) -> Result<Vec<SearchHit>>

#[tauri::command]
async fn semantic_index_status(app: AppHandle, project_id: String) -> Result<IndexStatusReport>
// Embedder 不要 (軽量)

#[tauri::command]
async fn semantic_reindex_all(app: AppHandle, project_id: String) -> Result<usize>
// 戻り値: 投入チャンク総数
// 1 scene 完了ごとに `semantic:reindex_progress` event を emit
```

#### Codex セマンティック / 補助コマンド（2026-06-18 追記）

scene 系の 4 コマンドに加え、以下 6 コマンドを実装している（同じく
`commands/semantic.rs`・`semantic-embedding` feature gate 内・camelCase）。

```rust
#[tauri::command]
async fn codex_index_entry(app: AppHandle, entry_id: String) -> Result<usize>
// codex entry 1 件を index/更新。戻り値: 投入ベクトル数 (1)、破棄時 0

#[tauri::command]
async fn codex_semantic_search(
    app: AppHandle, project_id: String, query: String, limit: usize,
) -> Result<Vec<CodexSearchHit>>
// codex の dense 検索。JS 側 search_codex が sparse と RRF 融合する dense アーム

#[tauri::command]
async fn codex_reindex_all(app: AppHandle, project_id: String) -> Result<usize>
// project 配下の全 codex entry を bulk back-index。progress event は出さない

#[tauri::command]
async fn codex_index_status(app: AppHandle, project_id: String) -> Result<CodexIndexStatus>
// Embedder 不要。{ indexedEntryCount, totalEntryCount }

#[tauri::command]
async fn semantic_chunk_context(
    app: AppHandle, scene_id: String, char_start: usize, char_end: usize, padding: usize,
) -> Result<PreviewContext>
// hit の前後文脈プレビュー (preview.rs::slice_context)。{ before, chunk, after, sceneTitle }

#[tauri::command]
async fn semantic_debug_dump(
    app: AppHandle, project_id: String, scene_id: Option<String>, limit: Option<usize>,
) -> Result<DebugDumpReport>
// 開発者向け: scene_chunks の検査用ダンプ (本文/範囲/model/dim/chunker/hash/
// 埋め込み L2 ノルム/stale 判定)。Embedder 不要。limit 既定 200・上限 2000
```

* `CodexSearchHit`: `{ entryId, entryName, entryType, summary, score }`
* `CodexIndexStatus`: `{ indexedEntryCount, totalEntryCount }`
  （`indexedEntryCount < totalEntryCount` で未 index の既存エントリがある）
* `PreviewContext`: `{ before, chunk, after, sceneTitle }`
* `DebugDumpReport`: `{ projectId, language, currentModelId, currentEmbeddingDim,
  currentChunkerVersion, totalChunks, returnedChunks, chunks: DebugChunkRow[] }`

`IndexStatusReport`:
```ts
{ indexedChunkCount, staleChunkCount, indexedSceneCount,
  currentModelId, currentEmbeddingDim, currentChunkerVersion }
```

### Progress event

`semantic_reindex_all` 中に `app.emit("semantic:reindex_progress", payload)`:

```ts
interface ReindexProgressPayload {
  sceneIndex: number;       // 完了累積 (0..=totalScenes)
  sceneId: string;          // 直近完了 scene id (情報用)
  totalScenes: number;
  chunksIndexed: number;    // 累積 chunk 数
  done: boolean;            // 全完了で true
}
```

`total_scenes = 0` のケースでも完了 event を必ず流す（フロントの「完了
トースト」を最後まで出すため）。emit 失敗は reindex 自体に影響しないので
`let _ =` で握りつぶす。

### Slow command 登録

`src/lib/tauri.ts::SLOW_COMMANDS` に `semantic_reindex_all` を含める。
medium scale (~32 scenes) は 10s デフォルトを超え得るため、AI 系コマンドと同じ
5 分タイムアウトに昇格する。

---

## フロント UI

### 検索 Dialog (`features/semantic-search/SemanticSearchDialog.tsx`)

Ctrl+Shift+F で開く `SearchDialog.tsx` ラッパーが、`searchModeStore.mode` を見て
`GlobalSearchDialog` (FTS5) と本 Dialog を出し分ける。両 Dialog の上部に
**`SearchModeTabs` (字句 / 意味)** を配置し、クリックで即座に切り替わる。

主な要素:
* 検索入力 (300ms debounce、FTS5 の 200ms より長めに)
* 「地の文を優先」トグル (`description_mode`)
* Top-K 結果リスト：scene_title / chunk_text プレビュー / score バッジ (0.00〜1.00) /
  dialogue タグ (「会話」橙 / 「地」緑)
* キーボードナビ: ↑↓ で選択、Enter で開く、Esc で閉じる

#### Stale request 抑止

連続入力で複数の `semanticSearch` が in-flight になり、古い応答が新しい
結果を上書きするのを防ぐため、**世代カウンタ `requestGenRef`** で各リクエストに
番号を振り、応答時点で `myGen !== requestGenRef.current` なら setState を
スキップする。effect の cleanup でも `++requestGenRef.current` して、
unmount 後の setState を確実に防ぐ。

#### キーボードナビゲーション

`searchResultSelection.ts::nextSearchResultIndex(current, direction, count)` で
pure 関数として境界処理を切り出し、`searchResultSelection.test.ts` で確認。
結果 0 件のとき `null` を返してキー無視できる仕様。

### モード切替の永続化 (`features/search/searchModeStore.ts`)

```ts
const useSearchModeStore = create<SearchModeState>()(
  persist(
    (set) => ({ mode: "lexical", setMode: (mode) => set({ mode }) }),
    { name: "search-mode-store" },
  ),
);
```

`zustand/middleware` の `persist` で localStorage に保持 (`kouetsuStore` と同パターン)。

### 結果クリック後のジャンプ (`semanticNavStore.ts` + `findChunkInDoc.ts`)

`SemanticSearchDialog::openHit`:
1. `useSemanticNavStore.requestJump({ sceneId, chunkText })` を**先に**書く
2. `setActiveScene(sceneId)` → `showPanel("editor")`

`EditorPane.tsx` 内で 2 経路に consume:
* **同シーン subscribe**: 既にそのシーンを開いているとき、subscribe 経由で即時 consume
* **switchScene 経路**: 別シーンを開いた直後の `requestAnimationFrame` で consume
  (foreshadow nav と同じ箇所、固定順 foreshadow > semantic)

`findChunkInDoc(doc, chunkText)`:
* `chunkText` の **先頭 line** (最初の `\n` までで切る) を search prefix に使う。
  チャンクには段落跨ぎの `\n` が含まれうるが PM doc 内に `\n` は無いため。
* PM doc を descend して全 text node を flat 連結し、各 char index → PM position の
  写像を作る (mark で割れた text node にも対応)。
* `flatText.indexOf(prefix)` で見つかれば PM range を返し、`setTextSelection +
  scrollIntoView` で該当箇所へ。
* 4 文字未満の prefix や見つからないケースは null を返し、呼び出し側は scroll なしで
  シーンを開くだけのフォールバック。

### 再インデックス進行表示

`features/semantic-search/`:
* `useReindexProgressListener.ts` — `App.tsx` で 1 度だけ呼び、Tauri event を購読
* `reindexProgressStore.ts` — Zustand store。`done=true` 受信から 4s で自動消滅。
  途中で別の reindex が走った場合は古いタイマーを破棄して新進捗に切替
* `ReindexProgressToast.tsx` — 画面右下に固定表示。`pointerEvents: none` で他要素を
  阻害しない。進行中は紫バー、完了で緑バーに切替

---

## ファイル構成

### Rust (`src-tauri/src/`)

```
semantic/
├── mod.rs            … モジュール宣言。embedding のみ feature gate
├── spec.rs           … EmbeddingModelSpec / SPEC_JA / SPEC_EN / spec_for_language (pure)
├── chunker.rs        … 日本語: 段落抽出 + 分類 + 文分割 + パッキング (pure)
├── chunker_en.rs     … 英語: 引用スパン基準の dialogue 計数 + 共有パッキング (pure)
├── embedding.rs      … ort + tokenizers の Embedder (spec 駆動)。golden test 同居
├── index.rs          … upsert_scene_chunks (pure) + index_scene (feature gated)
│                       + collect_index_status / list_scene_ids_in_project (pure)
├── search.rs         … SearchCache / load_scene_chunks_from_db / run_search (pure)
├── codex_index.rs    … codex_chunks の upsert / 1 entry 1 ベクトル / status (pure + embed)
├── codex_search.rs   … CodexSearchCache / run_codex_search (pure)
└── preview.rs        … semantic_chunk_context 用の前後文脈切り出し (pure)

commands/
└── semantic.rs       … 10 個の Tauri command + SemanticEmbedderState
                        + SearchCache / CodexSearchCache + *_split_lock
                        + resolve dir (resource_dir 経由 + CARGO_MANIFEST_DIR fallback)

database/migrate.rs   … scene_chunks + codex_chunks CREATE TABLE
```

### Frontend (`src/features/`)

```
search/
├── searchModeStore.ts         … "lexical" | "semantic" の persist
├── SearchDialog.tsx           … Ctrl+Shift+F の入口ラッパー
└── GlobalSearchDialog.tsx     … 既存 FTS5、上部に SearchModeTabs を追加

semantic-search/
├── api.ts                     … 10 個の invoke ラッパー (型付き、scene + codex + 補助)
├── SemanticSearchDialog.tsx   … 検索 UI 本体 (SearchModeTabs export 元)
├── searchResultSelection.ts   … キーボードナビ pure helper
├── semanticNavStore.ts        … chunk jump 要求 store (foreshadow nav と同形)
├── findChunkInDoc.ts          … PM doc 内で chunkText 先頭一致を探す pure
├── scheduler.ts               … シーン保存後の debounce 付き自動再インデックス
├── autoIndex.ts               … open 時の codex/scene 自動 back-index (ensureSemanticIndexesOnOpen)
├── searchEval.ts / searchEvalSets.ts … dev 評価ハーネス (Recall/MRR/閾値 sweep)
├── reindexProgressStore.ts    … 進捗トースト用 store
├── useReindexProgressListener.ts … Tauri event 購読 hook
└── ReindexProgressToast.tsx   … 右下固定の進捗トースト

chat/semanticRecall.ts         … Layer 4 RAG。dense+sparse RRF 取得・選別・言語別閾値
chat/agent/codexHybridSearch.ts … codex dense(codex_semantic_search)+sparse の RRF 融合

related-scenes/                … 「関連する過去シーン」パネル (人間向け recall)
├── selectRelatedScenes.ts     … 既読フィルタ+1シーン集約+件数 cap の選別 pure
├── fetchRelatedScenes.ts      … loadSceneContent→semanticSearch→selectRelatedPastScenes
└── RelatedScenesSection.tsx   … Scene Context 内セクション UI (debounce fetch + クリックで chunk jump)
App.tsx                        … listener 起動 + Toast マウント + SearchDialog 配線
                                  + open 時 ensureSemanticIndexesOnOpen
features/editor/EditorPane.tsx … coreSave 末尾で scheduleSceneIndex、
                                  switchScene + subscribe で chunk jump consume
lib/tauri.ts                   … SLOW_COMMANDS に semantic_reindex_all 追加
```

### リソース

```
src-tauri/resources/semantic/
├── ruri-v3-30m/          … 日本語 (SPEC_JA.dir_name)
│   ├── model_int8.onnx       … 36MB、tauri.conf.json#bundle.resources 同梱
│   ├── model.onnx            … 141MB、golden test 専用 (非同梱)
│   ├── tokenizer.json        … 6.5MB、同梱
│   └── (その他 config 系)
└── bge-small-en-v15/     … 英語 (SPEC_EN.dir_name)、同様に int8 ONNX + tokenizer を同梱
```

dev / prod の両方で `resolve_model_dir(app, spec)` =
`app.path().resource_dir().join("resources/semantic/{spec.dir_name}")` で解決。
`model_int8.onnx` の存在で検証し、見つからなければ `CARGO_MANIFEST_DIR`
にフォールバック (cargo test 経路や非 Tauri ランタイム救済)。Embedder は
`SemanticEmbedderState` が `dir_name` 別にキャッシュし、ja/en プロジェクトの
切替で取り直す。

---

## テスト戦略

### Rust (`--no-default-features` で完全実行可能)

* `chunker.rs`: 段落抽出 / 分類 / 文分割 / パッキング / overlap / dialogue ratio / chunk_index
* `index.rs`: `upsert_scene_chunks` の挿入・置換・空・hash mismatch・short embedding
  拒否・非 scene 拒否・FK CASCADE / `compute_content_hash` 決定性 /
  `collect_index_status` の 4 軸 stale 判定 / `list_scene_ids_in_project`
* `search.rs`: `dot_product` / `apply_dialogue_penalty` / `SearchCache` の identity
  キャッシュヒット・stale 削除 / `load_scene_chunks_from_db` decode / `run_search`
  ranking / scope / limit / cache hit / description_mode / dim mismatch
* `embedding.rs`: pure logic (mean_pool / cls_pool / l2_normalize / cosine) +
  golden gated test (ja/en の fp32 ONNX vs Python sentence-transformers)
* `spec.rs`: ja 識別子バイト固定 (ja-invariant) / 言語選択 / en の CLS+token_type_ids
* `codex_index.rs`: `build_codex_embed_text` / `upsert_codex_chunk` の insert・置換・
  hash mismatch・missing / `collect_codex_index_status`
* `codex_search.rs`: `CodexSearchCache` identity / `run_codex_search` ranking・scope・limit
* `chunker_en.rs`: 英語の文/引用スキャンと dialogue 計数
* `preview.rs`: `slice_context` の前後切り出し境界

### Frontend (Vitest)

* `api.test.ts`: invoke ペイロード形状と返値の型 (scene + codex + 補助)
* `searchResultSelection.test.ts` / `semanticNavStore.test.ts` / `findChunkInDoc.test.ts`:
  キーボードナビ・jump 要求・PM doc 先頭一致 (従来どおり)
* `scheduler.test.ts` / `reindexProgressStore.test.ts`: debounce / 進捗トースト
* `autoIndex.test.ts`: open 時の codex/scene 自動 back-index と充足判定・無音フォールバック
* `searchEval.test.ts`: dev 評価ハーネスの集計
* `chat/semanticRecall.test.ts` / `contextBuilder.semanticRecall.test.ts`:
  Layer 4 RAG の取得・選別・言語別閾値・注入組み立て
* `chat/agent/codexHybridSearch.test.ts`: codex dense+sparse の RRF 融合

### CI 上の注意

* `semantic-embedding` feature の cargo check / test は `ort-sys` の prebuilt
  バイナリ download を要求するので、ネット制限環境では `--no-default-features`
  でしか走らない。pure logic はそちらで全件 green を維持する。
* `lindera-unidic` も同様に dictionary asset を download するため、テスト時は
  `LINDERA_CACHE=/workspace/lindera-cache` を渡す。

---

## 既知の制約と後続課題

### 現状の制約

* **chunker 改訂 = 全 stale**: `CHUNKER_VERSION` を上げると全プロジェクトで
  `semantic_reindex_all` を要求する。ユーザに状態が見える仕組み
  (`semantic_index_status`) と、プロジェクト open 時の自動 back-index
  (`autoIndex.ts`、§インデックス更新) はあるが、明示的な「再構築」設定 UI は無い。
* **`semantic_reindex_all` 手動トリガー UI 未実装**: open 時の自動 back-index は
  あるが、ユーザが任意に再構築する Settings ボタンは未実装（DevTools console から
  invoke で代用）。
* **abort 未対応**: 大規模プロジェクトの reindex 中に止める手段が無い
  (アプリ終了のみ)。`AbortFlag` パターンで追加可能だが MVP では入れていない。
* **chunk highlight は先頭 line のみ**: `findChunkInDoc` は prefix (最大 60 chars)
  しか選択しない。チャンク全体をハイライトしたい場合は範囲拡張ロジックが必要。
* **複数プロジェクト横断検索なし**: `tree_nodes.project_id` で絞っているため、
  ワークスペース内の他プロジェクトのチャンクは無視される。
* **description_mode の効きが視覚的に分かりにくい**: 同じクエリでスコア差が 15%
  以上開いていると順位が変わらない。「減点中のチャンクが何件あるか」表示は未実装。

### 将来検討

* **Late Chunking**: 現状の「分割してから各チャンクを埋め込む」は参照表現
  (「彼」「その街」) の文脈情報が落ちる。ModernBERT-Ja は長文コンテキストを
  持つので、シーン全体をトークンレベルで埋め込んでから区間 mean pooling する
  方式に切替可能。チャンク区間定義は両方式で共通なので、移行コストは
  embedding 生成部に限定される。
* **bge-m3 など learned-sparse によるハイブリッド**: dense + sparse のハイブリッド
  自体は FTS5 (trigram/bm25) を sparse ランカーにした RRF 融合で**出荷済み**
  （§Layer 4 RAG / §Codex セマンティック検索）。bge-m3 のような learned sparse に
  差し替えればさらに精度が上がる可能性は残る。
* **`ruri-v3-310m` (768 次元) への差し替え**: 同梱サイズが大きい (~500MB) ため
  optional model pack / 初回ダウンロード方式での提供を検討。
  `embedding_dim` カラムが既にあるので DB は変更不要。
* **chunk scroll の精度向上**: char_start/char_end を ProseMirror position に
  正確にマッピングするためのオフセットマップ層が必要。
  `Grimodex_Linter設計書.md` の「位置オフセットの取り扱い」と同じ問題系。

> **（2026-06-18 追記）旧「将来検討」から出荷済みに昇格**:
> * **Layer 4 RAG コンテキスト注入** — 出荷済み（§Layer 4 RAG）。本機能の
>   インフラを流用し、dense+sparse RRF で chat 文脈へ自動注入する。
> * **言語別 2 モデル体制** — ja=ruri / en=bge-small-en-v1.5 を出荷済み（§埋め込みモデル）。
> * **Codex セマンティック検索** — 出荷済み（§Codex セマンティック検索）。

---

## 設計判断ログ（軽量）

実装中に確定／変更した重要判断のみ。詳細な背景は上流コンテキスト
`temp/semantic-prose-search-context.md` を参照。

| 判断 | 確定状態 |
|---|---|
| ruri-v3-30m (256d) を採用、ONNX int8 量子化を同梱 | 上流で確定 |
| L2 正規化済み出力 → ドット積でコサイン計算 | 上流で確定 |
| `sqlite-vec` / LanceDB は採用しない (総当たりで十分) | 上流で確定 |
| Transformers.js は採用しない (Rust 側で統一) | 上流で確定 |
| char_start/end は Unicode scalar index (byte でも UTF-16 でもない) | 上流で確定 |
| `SearchCache` に identity (model/dim/version) を持たせ、scene_chunks 行フィルタと二重防御 | **実装中追加** |
| 検索 Dialog で世代カウンタによる stale 応答抑止 | **実装中追加** |
| `findChunkInDoc` は先頭 line を prefix にした単純検索 (MVP) | 実装で確定 |
| `bundle.resources` にモデルを同梱 (production 配布で必須) | 後続で確定 |
| reindex_all に progress event、abort は後回し | 実装で確定 |
| 言語別 2 モデル体制 (ja=ruri-256d / en=bge-small-en-v1.5-384d)、`spec.rs` に集約 | **2026-06-18 出荷** |
| ja 識別子をバイト固定 (`spec.rs` ja-invariant test) し既存 index を無効化しない | **2026-06-18 出荷** |
| Codex は 1 entry 1 ベクトル (チャンク無し) で `codex_chunks` に index | **2026-06-18 出荷** |
| dense + FTS5 sparse を RRF 融合 (chat 注入 / codex 検索)。閾値は言語別 | **2026-06-18 出荷** |
| Layer 4 RAG を chat 文脈へ自動注入 (`semanticRecall.ts`、cacheSegments 外) | **2026-06-18 出荷** |
| open 時に codex/scene を言語別に自動 back-index (`autoIndex.ts`) | **2026-06-18 出荷** |
