# Grimodex セマンティック検索設計書

## 概要

作者が**自分の本文（散文）を意味で検索できる**ようにする機能。既存の FTS5
全文検索は 3 文字 n-gram の字句一致なので、「嵐の描写」で `雨が窓を叩いていた` を
引けない。本機能は ruri-v3 ベースの dense embedding で本文をチャンク化・インデックス
化し、ローカル推論でクエリと比較してトップ-K を返す。

実装上流のタスクコンテキストは [`temp/semantic-prose-search-context.md`](../temp/semantic-prose-search-context.md)。
本書は **実装で確定した最終形** をまとめる正本であり、上流コンテキストとの差分
（実装中に追加された防御層など）も明記する。

### 設計の柱

1. **全ローカル推論**: クエリ・本文ともに端末上で完結。API キーや外部通信を
   要求しない。`ort` クレートで ONNX Runtime を介し ruri-v3-30m (256 次元) を動かす。
2. **チャンク単位の検索**: シーン全体ではなく数百文字単位のチャンクを返し、
   結果から本文の該当箇所へジャンプできるようにする。
3. **書き味に干渉しない**: 検索インデックスは保存パイプラインの後段で debounce
   付き fire-and-forget。失敗しても本文保存には影響しない。
4. **モデル変更耐性**: モデル/チャンク化ルールが変わったら自動的に stale と
   判定して再構築できるよう、各チャンクに識別子を残す。

### スコープ外（本機能では扱わない）

* Codex のセマンティック検出（Chat パネル設計書で *不採用* 決定済み）
* Layer 4 RAG コンテキスト注入（SPEC.md で Post-MVP）
* 複数プロジェクト横断検索（§4 「Phase 1 は単一プロジェクト前提」）
* 字句一致と意味検索のハイブリッドスコア（bge-m3 sparse など、将来候補）

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
        │ │ SemanticEmbedderState                 │  ruri-v3 ONNX Session (lazy)
        │ │  Mutex<Option<Embedder>>              │
        │ └──────────────────────────────────────┘
        │ ┌──────────────────────────────────────┐
        │ │ SearchCache                           │  scene_id → CacheEntry
        │ │  Mutex<HashMap<id, CacheEntry>>       │   (model/dim/version 付き)
        │ └──────────────────────────────────────┘
        │
        ▼
[semantic::chunker]   ProseMirror JSON → ChunkerConfig → Vec<SceneChunk>
[semantic::embedding] tokenizer + ONNX inference → L2 正規化済み Vec<f32>
[semantic::index]     content_hash 検証 + DELETE/INSERT トランザクション
[semantic::search]    cache + コサイン Top-K + dialogue_ratio 減点
        ▼
SQLite (scene_chunks テーブル)
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
Rust マイグレーション: `src-tauri/src/database/migrate.rs` の trash_items の直後に
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

実装: `src-tauri/src/semantic/embedding.rs`。

### 採用モデル

* `cl-nagoya/ruri-v3-30m` (Apache 2.0, ModernBERT-Ja ベース、256 次元)
* ONNX: `sirasagi62/ruri-v3-30m-ONNX` の `model_int8.onnx` (36MB)
* 同梱: `src-tauri/resources/semantic/ruri-v3-30m/{model_int8.onnx,tokenizer.json}`
* Tauri 配布物への組み込み: `tauri.conf.json#bundle.resources` に登録済み

定数:
* `MODEL_ID_RURI_V3_30M = "cl-nagoya/ruri-v3-30m"`
* `EMBEDDING_DIM_RURI_V3_30M = 256`
* `QUERY_PREFIX = "検索クエリ: "`
* `DOCUMENT_PREFIX = "検索文書: "`

`scene_chunks.model_id` に書く文字列は
`"{MODEL_ID_RURI_V3_30M}@local/model_int8.onnx/prefix-v1"`。
**revision pin・量子化バリアント・prefix ルール変更を識別できる粒度**にする。

### 推論パイプライン

1. テキストに `検索クエリ: ` / `検索文書: ` prefix を付与
2. HF `tokenizers` で `input_ids`, `attention_mask` に変換
   （ModernBERT 系のため `token_type_ids` は渡さない）
3. ort で `last_hidden_state` を取得（`token_embeddings` 出力名にもフォールバック）
4. attention_mask 重み付き **mean pool**（prefix トークンも含めた `include_prompt: True` 相当）
5. **L2 正規化**

L2 正規化済み出力同士はドット積 = コサイン類似度になるため、検索時のスコアリングは
`semantic::search::dot_product` で済む。

### 検収条件（golden test）

`tests/embedding_golden.rs` 内 `#[cfg(test)] mod golden` で gated 実行。
Python `sentence-transformers` で生成した
`tests/fixtures/ruri_v3_30m_golden.json` と Rust 出力を比較する。

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

---

## 検索パイプライン

実装: `src-tauri/src/semantic/search.rs` (pure logic) +
`commands/semantic.rs::semantic_search`。

### 1. クエリの埋め込み

* `embedder.embed_query(query)` で `検索クエリ: ` prefix 込みで埋め込み (256 次元)
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

ruri-v3 出力は L2 正規化済みなので `dot_product(query, chunk) = cosine similarity`。

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
├── chunker.rs        … ProseMirror 段落抽出 + 分類 + 文分割 + パッキング (pure)
├── embedding.rs      … ort + tokenizers の Embedder。golden test 同居
├── index.rs          … upsert_scene_chunks (pure) + index_scene (feature gated)
│                       + collect_index_status / list_scene_ids_in_project (pure)
└── search.rs         … SearchCache / load_scene_chunks_from_db / run_search (pure)

commands/
└── semantic.rs       … 4 つの Tauri command + SemanticEmbedderState
                        + resolve_ruri_dir (resource_dir 経由 + CARGO_MANIFEST_DIR fallback)

database/migrate.rs   … scene_chunks CREATE TABLE
```

### Frontend (`src/features/`)

```
search/
├── searchModeStore.ts         … "lexical" | "semantic" の persist
├── SearchDialog.tsx           … Ctrl+Shift+F の入口ラッパー
└── GlobalSearchDialog.tsx     … 既存 FTS5、上部に SearchModeTabs を追加

semantic-search/
├── api.ts                     … 4 つの invoke ラッパー (型付き)
├── SemanticSearchDialog.tsx   … 検索 UI 本体 (SearchModeTabs export 元)
├── searchResultSelection.ts   … キーボードナビ pure helper
├── semanticNavStore.ts        … chunk jump 要求 store (foreshadow nav と同形)
├── findChunkInDoc.ts          … PM doc 内で chunkText 先頭一致を探す pure
├── scheduler.ts               … シーン保存後の debounce 付き自動再インデックス
├── reindexProgressStore.ts    … 進捗トースト用 store
├── useReindexProgressListener.ts … Tauri event 購読 hook
└── ReindexProgressToast.tsx   … 右下固定の進捗トースト

App.tsx                        … listener 起動 + Toast マウント + SearchDialog 配線
features/editor/EditorPane.tsx … coreSave 末尾で scheduleSceneIndex、
                                  switchScene + subscribe で chunk jump consume
lib/tauri.ts                   … SLOW_COMMANDS に semantic_reindex_all 追加
```

### リソース

```
src-tauri/resources/semantic/ruri-v3-30m/
├── model_int8.onnx       … 36MB、tauri.conf.json#bundle.resources 同梱
├── model.onnx            … 141MB、golden test 専用 (非同梱)
├── tokenizer.json        … 6.5MB、同梱
└── (その他 config 系)
```

dev / prod の両方で `app.path().resource_dir().join("resources/semantic/ruri-v3-30m")`
で解決。`model_int8.onnx` の存在で検証し、見つからなければ `CARGO_MANIFEST_DIR`
にフォールバック (cargo test 経路や非 Tauri ランタイム救済)。

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
* `embedding.rs`: pure logic (mean_pool / l2_normalize / cosine) +
  golden gated test (fp32 ONNX vs Python sentence-transformers)

### Frontend (Vitest)

* `api.test.ts`: invoke ペイロード形状と返値の型
* `searchResultSelection.test.ts`: キーボードナビ境界
* `semanticNavStore.test.ts`: requestJump / consumeJump / scene 不一致の保持
* `findChunkInDoc.test.ts`: 単一 text node / mark 分割 / `\n` 含み / 不在 / 短すぎる /
  空 doc / max chars 境界 / 複数出現の先頭 / heading 混在
* `scheduler.test.ts`: debounce / 連続 schedule のマージ / scene_id 独立 / cancel /
  空 id / pending count / reject 伝播抑止
* `reindexProgressStore.test.ts`: 初期 inactive / setProgress / auto clear /
  新 progress で timer cancel / clear

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
  (`semantic_index_status`) はあるが、自動再構築 UI はまだ無い。
* **`semantic_reindex_all` トリガー UI 未実装**: 現状 DevTools console から
  invoke するしかない。Settings パネルにボタンを追加する余地あり。
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
* **bge-m3 sparse によるハイブリッド**: dense (ruri-v3) と sparse (bge-m3) の
  ハイブリッド検索で固有名詞検索の精度が上がる可能性がある。
* **`ruri-v3-310m` (768 次元) への差し替え**: 同梱サイズが大きい (~500MB) ため
  optional model pack / 初回ダウンロード方式での提供を検討。
  `embedding_dim` カラムが既にあるので DB は変更不要。
* **Layer 4 RAG コンテキスト注入**: 本機能の cache とインフラを流用して、
  AI チャットへのコンテキスト注入に応用できる。SPEC.md で Post-MVP に位置付け済み。
* **chunk scroll の精度向上**: char_start/char_end を ProseMirror position に
  正確にマッピングするためのオフセットマップ層が必要。
  `Grimodex_Linter設計書.md` の「位置オフセットの取り扱い」と同じ問題系。

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
