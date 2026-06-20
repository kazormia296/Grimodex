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

帰結：既存サニタイザの引用符はそのままでよく、porter `_en` テーブルは index 側・query 側とも自動で stem する。**stemming を効かせるためのサニタイザ変更は不要。**

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

### 5.3 FTS 英語テーブル（`porter unicode61`）

- 5本の base テーブルそれぞれに対し、`tokenize='porter unicode61'` の `_en` FTS5 テーブルを追加。列構成と外部コンテンツ設定は trigram 兄弟と同一：
  `codex_fts_en`・`snippets_fts_en`・`tree_nodes_fts_en`・`post_effect_annotations_fts_en`・`chat_messages_fts_en`。
- **書込ルーティング(トリガ):** 各 base テーブルに言語ガード付きの `*_ai`/`*_ad`/`*_au` トリガを追加。英語行→`_en` テーブル、他→既存 trigram テーブル。`WHEN` ガード：
  - 直接 `project_id` を持つ場合(codex/snippets/tree_nodes/post_effect_annotations)：
    `WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'`
  - `chat_messages`(間接)：
    `WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = new.session_id)) LIKE 'en%'`
  - いずれも PK lookup(安価)だが §7 の性能注記参照。
  - **冪等性:** トリガ変更時に古い無ガードトリガが残らないよう、各 `CREATE TRIGGER` の前に `DROP TRIGGER IF EXISTS`。
- **クエリルーティング:** `search_fts()` は冒頭で project 言語を一度引き、英語なら `_en` テーブルに MATCH。サニタイザ(`to_fts_match`/`toFtsMatchQuery`)は**変更なし**(引用符は stemming と両立・§4)。
- **効果の位置づけ:** trigram に対する主効果は**精度(precision)**(語境界＋stem により `run`→`rune`/`runner` の誤ヒットが消える)＋屈折形 recall(`studies`↔`study`)。stemming は RRF の sparse アームしか動かさないため、検索全体への寄与は計測必須(§8)。

### 5.4 rebuild・backfill・言語変更（共通コード経路）

外部コンテンツの `('rebuild')` は base テーブル全体を読み、トリガの `WHEN` ガードを無視するため、全言語を1つの `_en`/trigram テーブルに index してしまう。よって分割後は**使用不可**。言語フィルタ付きの再投入に置換する。

- 新 Rust 関数 `repopulate_fts_for_project(conn, project_id)`：
  1. project 言語を引く。
  2. 5つの content type それぞれについて、この project の行を trigram と `_en` の**両テーブルから削除**し、言語に応じた**正しいテーブル**へ INSERT。
- この単一関数が3用途を兼ねる：
  - **backfill**：マイグレーション初回実行時に既存英語プロジェクトを投入(英語プロジェクトごとに呼ぶ)。
  - **言語変更**：`projects.language` が変わったときに呼ぶ(下記の project 更新経路から配線)。
  - 手動修復／整合性 rebuild。
- `fts_rebuild()`/`fts_optimize()` を言語対応に書き換え：projects を巡回して各 project の content を正しいテーブルへ振り分ける(あるいは project ごとに `repopulate_fts_for_project` を呼ぶ)。`optimize` は FTS テーブルごとに発行(trigram と `_en` の両方)。
- **言語変更の配線:** `updateProject()`(`src/features/project/api.ts`)は現状 FTS フックなし(検証済)。`language` フィールドが変わったら `repopulate_fts_for_project` を呼ぶ Tauri コマンドを叩く。これが無いと project の言語切替で index が逆テーブルに取り残され、その project の検索が黙って壊れる — **レビューで判明した最重要の修正**。

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
- `src-tauri/src/database/migrate.rs` — `_en` テーブル5本＋言語ガード付きトリガ(DROP-before-CREATE)。
- `src-tauri/src/database/fts.rs` — `search_fts` 言語ルーティング・`fts_rebuild`/`fts_optimize` 言語対応・`repopulate_fts_for_project`。
- `src-tauri/src/commands/*` — repopulate を起動するコマンド(backfill＋言語変更)。
- `src/features/project/api.ts` — `language` 変更時に repopulate を呼ぶ。
- `src/lib/fts.ts` — **変更なし**(引用符は stemming と両立)。

## 10. リスクと未決事項

- 検索の end-to-end 利得は **eval ゲート実行まで未証明**(dense アームが支配する可能性)。校閲の利得は独立かつ明確。eval で検索利得が無視できると出たら、校閲を残しつつ FTS 半分を再検討できる。
- DB サイズ：英語プロジェクトは実質1つの FTS テーブルのみ使用(trigram 兄弟は空)。無視できる。
- マイグレーション backfill コストは既存英語プロジェクトの content 量に比例(一度きり)。

## 11. スコープ外／将来

- lemmatization(不規則)・クエリ拡張・`<3` codepoint 短語フィルタの緩和・汎用 per-language プロファイル抽象・CJK 言語(`zh`/`ko` は trigram テーブルを再利用しつつ独自チャンカー/モデルが必要)・`projects.language` への `CHECK` 制約。
