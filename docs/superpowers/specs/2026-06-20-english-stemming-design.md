# 英語 stemming 設計：校閲(lint) + FTS(sparse検索)

- 日付: 2026-06-20
- ステータス: 設計承認済み（実装前）
- スコープ: 英語の語幹化(stemming)を (1) 校閲エンジン と (2) FTS5 の sparse 検索アームに追加する。密(dense)埋め込みは意図的に変更しない。

## 1. 概要と目的

現在、英語テキストには**形態素的な正規化が一切ない**。lindera/UniDic は日本語専用で、英語は空白トークナイズ＋ヒューリスティックな文境界検出を通る。その結果：

- **校閲**は `run` / `runs` / `running` を別語として扱う（例：`en/word-repetition` は `to_ascii_lowercase()` をキーにしている）。`en/filter-words` は66個の活用形を直書きしている。
- **FTS sparse 検索**は全言語共通の `trigram` トークナイザを使う。前方部分一致は拾えるが、形態素を区別しないため誤ヒットを生む（`run` が `rune`・`runner`・`turner` にマッチ）。

目的：英語に **Snowball stemming** を導入し、屈折形を共通の語根へ正規化することで、校閲の単語一致と FTS sparse 検索の**精度(precision)**（および副次的に屈折形の recall）を改善する。

## 2. 確定事項（ユーザーと合意済み）

1. **密埋め込み(bge-small-en-v1.5)はクリーンのまま据置 — stemmingしない。** bge の BERT/WordPiece トークナイザは未stemmingのテキストで学習され、形態素的類似性を意味空間で既に捉えている。stemmingすると分布外のサブワード(`studies`→`studi`→壊れたWordPiece)を与えて埋め込み品質を下げる。stemming は*語彙的(lexical)*正規化であり、語彙的経路のみに置く。
2. **アルゴリズム：Snowball (Porter2)** を `rust-stemmers` クレートで校閲層に使う。
3. **FTS構成：案A** — FTS5 組み込みの `porter unicode61` トークナイザを使う英語専用テーブルを新設（既存 trigram テーブルへ stem を流し込む案Bは不採用）。これにより英語は trigram の部分一致が語境界一致に置き換わる。
4. **ルーティングは `language LIKE 'en%'` のハードコード**（汎用の言語プロファイル抽象は今は作らない＝YAGNI。3言語目が来たときに抽象化する）。

## 3. 背景（現状・検証済み）

- 校閲クレート: `src-tauri/crates/grimodex-lint`。英語ルールは `src/rules/en/` 配下（14ルール）。`LintContext.block_tokens` はルールが `requires_morphology()=true` を立てたときのみ populate され、lindera(日本語)が走る。**英語stemmingはこの経路を使わない** — 英語ルールは正規表現で単語抽出しており、stemming はその単語に当てる純粋ヘルパとする。
- FTS: 外部コンテンツ(`content=<base>`, `content_rowid=rowid`)の FTS5 テーブルが5本、全て `tokenize='trigram'`、書込は100%SQLトリガ(`*_ai`/`*_ad`/`*_au`)：
  - `codex_fts` ← `codex_entries`（`project_id` あり）
  - `snippets_fts` ← `snippets`（`project_id` あり）
  - `tree_nodes_fts` ← `tree_nodes`（`project_id` あり）
  - `post_effect_annotations_fts` ← `post_effect_annotations`（`project_id` あり）
  - `chat_messages_fts` ← `chat_messages`（`project_id` **なし**。`chat_sessions.project_id` 経由で解決）
- クエリ経路: `src-tauri/src/database/fts.rs::search_fts()` は project スコープ(`project_id` 引数)だが現状**言語非依存**。サニタイザ `to_fts_match()`(Rust)/`toFtsMatchQuery()`(`src/lib/fts.ts`) はトークンを二重引用符で囲み、`<3` codepoint のトークンを落として `LIKE` にフォールバックする。
- 検索は**ハイブリッド**：dense(bge/ruri) + sparse(FTS5 BM25) を RRF で融合(`src/features/chat/semanticRecall.ts`, `chatRecall.ts`)。stemming は **sparse アームのみ**に効く。
- 言語の正本: `projects.language`(`TEXT NOT NULL DEFAULT 'ja'`)。内容からの自動判定はしない。

## 4. 検証済みの事実（レビューの2つの反論を実証で否定）

複数観点の advisor レビューが2つの「致命的ブロッカー」を指摘したが、いずれも SQLite(FTS5 3.40.1) の直接テストで**否定**された：

1. **`tokenize='porter unicode61'` は有効。** `porter` は下位トークナイザを引数に取る*ラッパ*トークナイザ。`CREATE VIRTUAL TABLE ... USING fts5(content, tokenize='porter unicode61')` は成功する。
2. **二重引用符は stemming を無効化しない。** `porter unicode61` で `MATCH '"studies"'` は `studying` を含む行にマッチする（両者とも `studi` に stem される）。引用符内にもトークナイザ(porter stemmer 含む)が適用される。傍証：*既存の* trigram 検索は全トークンを引用符で囲んで動作している＝FTS5は引用符内もトークナイズする証拠（無効化されるなら現状のtrigram検索は一切ヒットしない）。
3. **外部コンテンツ(`content=`)FTSでは `count(*)` がインデックス行数ではなくコンテンツ表の行数を返す**（実測：英語1行のみ索引でも `count(*)`→2）。よって外部コンテンツFTSは「空かどうか」の backfill ゲートに使えない。`_en` を**非外部(通常)FTS5**にすると `count(*)` が正確になり、通常の `DELETE FROM` も使えて 'delete' sentinel が不要になる（実測確認済み）。

帰結：(a) 既存サニタイザの引用符はそのままでよく、porter `_en` テーブルは index 側・query 側とも自動で stem する＝**サニタイザ変更は不要**。(b) `_en` は**非外部 FTS5** とし、自前で英語テキストの写しを保持する（後述の §5.3/§5.4 の単純化はこれに依存）。

## 5. 設計

### 5.1 言語ルーティング（ハードコード）

書込時(トリガ)とクエリ時(`search_fts`)で同一の単一述語を使う：

> 英語 ⇔ `projects.language LIKE 'en%'`。それ以外(`ja`・`de`・空・NULL・不明)は既定/trigram 経路。

これは既存 `spec_for_language()` の慣習(`en*`→英語、他→日本語)に一致し、書込/クエリのルーティングを常に一致させる。

### 5.2 校閲 stemming（Snowball / `rust-stemmers`）

- `grimodex-lint/Cargo.toml` に `rust-stemmers` を追加。
- 純粋ヘルパ `stem_en(word: &str) -> String`（例：`src/stem.rs`）を新設し `Stemmer::create(Language::English)` をラップ。**`requires_morphology()` は立てない**・**lindera に触れない**。
- retrofit:
  - **`rules/en/word_repetition.rs`(主):** 重複判定キー `to_ascii_lowercase()` → `stem_en(&lower)`。`run`/`runs`/`running` を同一視。
  - **`rules/en/filter_words.rs`(次):** 66個の活用形リストを ~14個の語根に置換し、`stem_en(候補)` を語根集合と照合。
  - **`rules/en/dialogue_punctuation.rs`(三・任意):** said系動詞照合の前に先頭語を stem。
- 不規則変化(`ran`→`run`)は Snowball では正規化されない。許容(lemmatization はバイナリ肥大/複雑性のため却下済)。
- 校閲の利得は**検索とは独立**：RRF/dense の事情に関係なく改善する。

### 5.3 FTS 英語テーブル（`porter unicode61`・非外部・LEAN ルーティング）

- 5本の base テーブルそれぞれに対し、`tokenize='porter unicode61'` の **非外部(通常)** `_en` FTS5 テーブルを追加(列構成は trigram 兄弟と同じだが `content=`/`content_rowid=` は付けない＝自前で写しを保持)：
  `codex_fts_en`・`snippets_fts_en`・`tree_nodes_fts_en`・`post_effect_annotations_fts_en`・`chat_messages_fts_en`。
- **書込ルーティング(LEAN):** **既存の trigram トリガ・テーブルは一切変更しない。** 新たに言語ガード付きの `*_en_ai`/`*_en_ad`/`*_en_au` トリガを追加するのみ。英語行のみ `_en` に同期する。
  - `_en_ai`: `WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'` で `INSERT INTO X_en(rowid, cols) VALUES(...)`。
  - `_en_ad`: 同ガードで `DELETE FROM X_en WHERE rowid = old.rowid`（非外部なので通常 DELETE・sentinel 不要）。
  - `_en_au`: 既存の列変更条件 AND 言語ガードで `DELETE`→`INSERT`。
  - `chat_messages` は `project_id` 間接：`WHERE id = (SELECT project_id FROM chat_sessions WHERE id = new.session_id)`。
  - いずれも PK lookup(安価)・§7 性能注記参照。新規 `IF NOT EXISTS` トリガなので既存への `DROP` 不要。
  - **帰結(許容):** 英語コンテンツは trigram にも(既存トリガ経由で)索引されるが、英語プロジェクトのクエリは `_en` のみを引くため trigram 側の英語コピーは決して参照されない(無害な重複)。これにより既存 trigram の `('rebuild')`/`('optimize')` がそのまま有効に保てる(§5.4)。
- **クエリルーティング:** `search_fts()` は冒頭で `SELECT language LIKE 'en%' FROM projects WHERE id=?` を一度引き、英語なら各 scope の MATCH を `_en` テーブルへ向ける(table 名を `&str` 変数で切替し `format!` で組む)。LIKE フォールバック枝は不変。サニタイザ(`to_fts_match`/`toFtsMatchQuery`)は**変更なし**(引用符は stemming と両立・§4)。
- **効果の位置づけ:** trigram に対する主効果は**精度(precision)**(語境界＋stem により `run`→`rune`/`runner` の誤ヒットが消える)＋屈折形 recall(`studies`↔`study`)。stemming は RRF の sparse アームしか動かさないため、検索全体への寄与は計測必須(§8)。

### 5.4 rebuild・backfill・言語変更

`_en` は非外部 FTS5 なので、通常の `DELETE FROM` + 言語フィルタ `INSERT ... SELECT` で確実に再構築できる(`('rebuild')` の外部コンテンツ問題は回避)。

- 新 Rust メソッド `rebuild_en_fts()`：各 `_en` テーブルを `DELETE FROM X_en;` してから `INSERT INTO X_en(rowid, cols) SELECT rowid, cols FROM <base> WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%')`(chat は `chat_sessions` 経由)。SQL 本体は `&Connection` を取る自由関数に切り出し、`migrate()` の backfill と `rebuild_en_fts()` の双方から呼ぶ(ロック二重取得の回避)。
- **backfill:** `migrate()` 末尾で `SELECT count(*) = 0 FROM codex_fts_en`(非外部なので正確)が真なら上記 rebuild SQL を実行。アップグレード直後の既存英語プロジェクトを一度だけ投入。新規/空 DB では no-op、以降は `_en` 非空ゲートでスキップ。
- **既存 trigram の `fts_rebuild()`/`fts_optimize()` はそのまま温存**(trigram は全言語の catch-all で正しい)。`fts_rebuild()` に `rebuild_en_fts()` 呼び出しを**追記**し、`fts_optimize()` に `_en` テーブルの `('optimize')` を**追記**するのみ。
- **言語変更の配線:** `updateProject()`(`src/features/project/api.ts`)は現状 FTS フックなし(検証済)。新コマンド `fts_rebuild_en`(= `db.rebuild_en_fts()`)を追加し、`updateProject` の patch に `language` が含まれるとき更新後に `invoke("fts_rebuild_en")` を呼ぶ。これが無いと project の言語切替で `_en` に逆言語の行が残り検索が壊れる — **レビューで判明した最重要の修正**。`_en` 全再構築は稀な操作なので全件で可。

## 6. エッジケースと決定

- **未対応の言語値**(`'de'`・`'EN'`・空・NULL)：既定/trigram 経路に落ちる(今日の `spec_for_language` と同じ)。ルーティング述語 `LIKE 'en%'` は大小文字を区別する。DB は既定で小文字 `'en'` を格納。`CHECK(language IN ('ja','en'))` 制約は**スコープ外**(既存データに対し侵襲的すぎる)。代わりに言語集合が開いていることを文書化する。
- **2つの stemmer**(校閲=Snowball/Porter2、FTS=FTS5 classic Porter)：両サブシステムは状態を共有せず、各々が内部で対称(query と document に同一 stemmer)。機能的に無害。コードコメントで明記。(統一には Rust での FTS5 カスタムトークナイザが必要で、脆さに見合わず却下。)
- **固有名詞**は FTS で stem される(`Running`→`run`)。散文検索では許容(unicode61 はそもそも大小無視)。
- **短語(`<3` codepoint):** サニタイザが MATCH 前に落とすため、unicode61 が `go`/`AI` を index できてもクエリ時には活きない。これは **stemming と直交**するので現状維持。将来の任意拡張として `_en` 専用のクエリ経路で2文字トークンを許可する案。
- **ストップワード:** FTS は全語を index(フィルタなし・現状維持)。校閲は `word-repetition` 用の `STOP_WORDS` 集合を自前で保持。

## 7. 性能

- 直接 project_id を持つ4テーブル＋間接1テーブルへの insert/update で、トリガの `WHEN` 句が `projects`/`chat_sessions` のサブクエリを評価するようになる。これらは PK lookup(安価)だが、本リポは DB ロック感度の既知問題(ONNX mutex / `db_execute` タイムアウト)を持つ。**書込レイテンシのチェックを追加**して退行が無いことを確認。必要なら子テーブルへの言語キャッシュや小さなルックアップテーブルで緩和。

## 8. テストと eval ゲート

- **校閲ユニットテスト:** `word_repetition` が `run`/`running` を同一視・`filter_words` が語根＋stem で照合。
- **FTS 統合テスト:** 英語プロジェクトで `studies` を index → `study` クエリでヒット。insert/update/delete と言語切替(`en→ja→en`)を跨いで、content が**ちょうど1テーブル**(両方でも0でもない)に入ることを検証。日本語は無影響(trigram)を回帰テスト。
- **eval ゲート(検索側の価値を検証):** 英語 sparse アームの precision/recall(trigram vs `porter unicode61`)を、英語サンプルから作った held-out クエリ集合で計測。ハイブリッド end-to-end(RRF) の before/after も計測。ベースラインを記録し将来の退行検知に。本リポの既存 eval-harness 文化に合致。
- **クロスプロジェクト分離テスト:** 多言語プロジェクト混在 DB で結果が正しく分離される。
- 既存ガード遵守：`noControlBytes`・branch-first(master 直 commit 禁止)・`.github` 編集禁止。

## 9. 影響範囲／変更ファイル

- `src-tauri/crates/grimodex-lint/Cargo.toml` — `rust-stemmers` 追加。
- `src-tauri/crates/grimodex-lint/src/stem.rs`(新規) — `stem_en`。
- `src-tauri/crates/grimodex-lint/src/rules/en/{word_repetition,filter_words,dialogue_punctuation}.rs` — retrofit。
- `src-tauri/src/database/migrate.rs` — 非外部 `_en` テーブル5本＋言語ガード付き `*_en_*` トリガ(新規`IF NOT EXISTS`・既存トリガは不変)＋ backfill ゲート(`count(*)=0`)。
- `src-tauri/src/database/fts.rs` — `search_fts` 言語ルーティング・`rebuild_en_fts()`＋自由関数化した rebuild SQL・`fts_rebuild`/`fts_optimize` に `_en` 追記。
- `src-tauri/src/commands/integrity.rs` — `fts_rebuild_en` コマンド(= `db.rebuild_en_fts()`)。
- `src-tauri/src/lib.rs` — `fts_rebuild_en` を `invoke_handler` に登録。
- `src/features/project/api.ts` — `language` を含む更新時に `invoke("fts_rebuild_en")`。
- `src/lib/fts.ts` — **変更なし**(引用符は stemming と両立)。

## 10. リスクと未決事項

- 検索の end-to-end 利得は **eval ゲート実行まで未証明**(dense アームが支配する可能性)。校閲の利得は独立かつ明確。eval で検索利得が無視できると出たら、校閲を残しつつ FTS 半分を再検討できる。
- DB サイズ：`_en` は非外部のため英語テキストの写しを保持し、かつ英語コンテンツは trigram にも(無害に)索引される。よって英語プロジェクトはテキストを実質2重に保持(base＋`_en`)。小説規模で数MB増程度・デスクトップ単一ユーザーでは許容。日本語プロジェクトは無影響。
- マイグレーション backfill コストは既存英語プロジェクトの content 量に比例(一度きり)。

## 11. スコープ外／将来

- lemmatization(不規則)・クエリ拡張・`<3` codepoint 短語フィルタの緩和・汎用 per-language プロファイル抽象・CJK 言語(`zh`/`ko` は trigram テーブルを再利用しつつ独自チャンカー/モデルが必要)・`projects.language` への `CHECK` 制約。
