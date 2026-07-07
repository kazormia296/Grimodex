# Grimodex 自動バックアップ／リストア設計書

> 目的: 自動バックアップの**ディスク肥大**を解消しつつ、バックアップの本来価値
> （DB 破損・全損からの復旧手段）を損なわない。あわせて現状欠けている
> **アプリ内リストア**を提供する。
>
> 状態: 設計フェーズ（未実装）。実装は Phase 1 → 2 → 3 の順で独立出荷する。
> 対応方針は「差分不採用・圧縮＋派生データ除外」（Opus/Fable 双方のレビュー一致）。

---

## 1. 背景と現状の実装

### 1.1 自動バックアップの実態

- **トリガ**: `open_workspace`（アプリ起動時＆ワークスペース切替時）内で
  `maybe_auto_backup(&ws_path, &database)` を呼ぶ。**バックグラウンドタイマーではない**。
  （`src-tauri/src/commands/workspace.rs:81`, 呼び出しは `open_workspace` 本体）
- **間引き**: `data.backupInterval`（既定 60 分）。`backups/` 内の最新バックアップが
  この間隔より**古いときだけ**新規作成する。
  （`workspace.rs:85-98`。判定は `newest_backup_age_secs` = ファイル **mtime** ベース）
  → 1 日 1 回の起動なら実質「毎起動 1 本増える」体感になる。
- **保存内容**: `grimodex.db` **全体**を `VACUUM INTO` で作った**無圧縮の完全コピー .db**。
  ワークスペース丸ごと（＝全プロジェクト）。選択的除外はしていない。
  （`database.rs:62` `backup_to()` → `conn.execute("VACUUM INTO ?1", ...)`）
- **保存先／命名**: `<ws>/backups/grimodex-<UTC:YYYYMMDD-HHMMSS>.db`
  （`workspace.rs:92,103-104`）。ファイル名の辞書順＝時系列順。
- **保持世代**: `data.maxBackups`（既定 10、下限 1）。`rotate_backups` が
  **ファイル名ソート**で古い順に削除。（`workspace.rs:52-74,116`）
- **書き込み前チェック**: `db.quick_check()`。破損検知しても「復旧用に**あえて**」
  バックアップは実行する。（`workspace.rs:105-111`）
- **ベストエフォート**: 失敗は `tracing::warn!` のみでワークスペース open は止めない。
- **現状のリストア**: **アプリ内手段なし**。ユーザーが手動で `grimodex-*.db` を
  `grimodex.db` へコピーして戻す想定（`database.rs:58-61` のコメント）。

### 1.2 設定キー（app_settings、global scope）

| キー | 既定 | UI | 意味 |
|---|---|---|---|
| `data.autoBackup` | `"true"` | トグル | 自動バックアップ ON/OFF |
| `data.backupInterval` | `"60"` | スライダ 15–360 分（step 15） | 間引き間隔 |
| `data.maxBackups` | `"10"` | スライダ 1–50 | 保持世代数 |

（宣言 `src/features/settings/types.ts:198-200,371-373`、UI `DataCategory.tsx:191-216`）

### 1.3 肥大の主因（＝各コピーの中身）

問題は「10 本持つこと」より **1 本あたりの中身**にある。DB サイズの体感で約半分が
**ソース本文から完全に再生成可能な派生データ**。

| データ | 場所 | 特徴 |
|---|---|---|
| 埋め込みベクトル | `scene_chunks` / `codex_chunks` / `event_chunks` / `chat_message_chunks` の `embedding BLOB`（`migrate.rs:1348,1375,1397,1423`） | f32（JA=256dim=1024B, EN=384dim=1536B/chunk）。各行に `text` を**重複保存**。**高エントロピー → gzip がほぼ効かない**（≈1.1x）。再生成可（`content_hash`/`model_id`/`chunker_version` でゲート） |
| FTS5 全文索引 | JA 5 表＋EN 5 表（§4 表）＋その影テーブル群 | 本文の 1–2 倍に膨らむことがある。再生成可 |
| タイムラプス | `change_events`（追記専用ハッシュチェーン、`migrate.rs:3129`、`prune_old_logs` から**意図的に除外**、`database.rs:71-76`） | **無限増加**。反復 JSON で**圧縮がよく効く** |

結論: **無圧縮フル DB × 最大 10 本** がディスクを占有する。
「差分」でも「圧縮のみ」でもなく、**各コピーから派生データを除いて圧縮する**のが正解。

---

## 2. 設計判断（なぜこの方針か）

### 2.1 バックアップ ≠ プロジェクトスナップショット（置換不可）

両者は**別レイヤー**であり、片方でもう片方を代替できない。

| | 自動バックアップ | プロジェクトスナップショット |
|---|---|---|
| 保存先 | **DB の外**（`backups/*.db` ファイル） | **同じ grimodex.db の中**（行として） |
| 守れる障害 | DB 破損・全損・不正マイグレーション | 意図的な内容の巻き戻し |
| 範囲 | ワークスペース全体（全プロジェクト） | プロジェクト単位 |
| 自動化 | あり（既定 ON） | **なし**（手動のみ。復元直前の安全スナップだけ自動） |
| 保存形式 | フル DB（`VACUUM INTO`） | フル内容の DB 行（差分ではない） |

→ スナップショットは**自分が守る対象と同じ DB の中**に居るので、DB が壊れれば一緒に消える。
**災害復旧の代替にはならない。** よって「自動バックアップを自動スナップショットで置き換える」
案は不採用。自動スナップショットが欲しければ**別機能として上乗せ**する（本設計の範囲外）。

### 2.2 差分／incremental を採らない

- バックアップの価値は「**DB の外にある、単体で復元可能なファイル**」であること。
  差分にすると (a) スナップショットと役割が被り、(b) ベース＋差分チェーンのどれか 1 リンクが
  壊れると以降が全滅する。→ **災害復旧バックアップとしては劣化。** 不採用。

### 2.3 圧縮のみ（slim なし）も採らない

- 肥大の主因である埋め込み BLOB は高エントロピーで gzip が効かない（≈1.1x）。
  圧縮のみだと全体で 3 割減程度に留まる。**派生除外と圧縮はセットで初めて意味を持つ。**

### 2.4 リストアを最優先で出す（順序）

- 圧縮を先に出すと「`backups/` にファイルはあるのに戻せない」期間が生まれる。
- 現状の「手動でファイルをコピーして戻す」は UX が悪いだけでなく**危険**
  （§3.1 の -wal 残骸リプレイ破損）。
- よって **Phase 1 =（既存の無圧縮 .db を対象にした）アプリ内リストア＋堅牢化**を先に固め、
  一番リスクの高い「稼働中 DB 置換」ロジックを圧縮より前に完成させる。

---

## 3. Phase 1 — アプリ内リストア＋バックアップ堅牢化

**出荷単位の価値**: 「戻せない/危険な手動コピー」を単体で解消し、以降の全 Phase の土台
（稼働中 DB 置換ロジック）を先に固める。この Phase 内には圧縮・slim を含めない。

### 3.1 稼働中 DB 置換（本 Phase の本丸・最高リスク）

リストアの実体は「開いている `grimodex.db` を選択したバックアップで置き換える」。
`restore_backup_core`（`workspace.rs`）の実装手順と落とし穴（敵対レビューで確定）:

1. **開いているファイルは置換できない（特に Windows）**: `ActiveWorkspace`（`Arc<Database>`）が
   握る `Mutex<Connection>` を落とし、in-flight IPC の完了を待ってからでないと差し替え不可。
   → 既存の `open_lock` / `switching` 直列化契約に乗せる（`switching=true` で新規 `with_db` を
   `WORKSPACE_SWITCHING` 拒否 → `inner.take()` → `wait_for_sole_owner` で `Arc::strong_count==1`
   まで待つ → `drop` で接続クローズ）。メモリ: async-ipc-serialization-compensation 参照。
2. **順序: 静止化してから安全退避**: `switching=true`＋in-flight drain を**先に**行い、その後で
   安全退避を撮る。逆順だと退避スナップショット以降に「保存成功」を返した書き込みが復元で
   失われる窓ができる。
3. **復元前セーフティ退避は best-effort**: quiesce 後の現行 DB を通常バックアップ
   （`grimodex-<ts>.db`）として `backup_to` で退避。ただし**失敗しても中止しない** —
   現行 DB が破損している状況こそ復元が必要な場面であり、そこで `VACUUM INTO` 失敗が復元を
   阻むのは本末転倒（`maybe_auto_backup` も quick_check 破損時に「復旧用に」退避する方針と対称）。
4. **検証してから破壊**: 選択ファイルは `basename` 検証（traversal 拒否）＋ read-only
   `PRAGMA quick_check` に通し、合格した時のみ置換に進む（壊れたバックアップで現行を壊さない）。
5. **置換は原子的（rename）**: 候補を `grimodex.db.restore-tmp` へコピー → `rename` で
   `grimodex.db` に上書き。**旧 `remove`＋`copy` は不可** — copy 途中失敗で `grimodex.db` が
   消失/切詰めされ、次回起動で空 DB を新規作成して「全損に見える」データ損失になる。`rename` は
   両 OS で既存を原子置換するので、copy/rename のどの失敗でも `grimodex.db` は元のまま残る。
6. **-wal/-shm 残骸のリプレイ破損**: 置換前に旧 `grimodex.db-wal` / `-shm` を削除
   （接続クローズ時に checkpoint 済みなので主 DB データは無事）。残すと復元 DB に無関係な
   旧 WAL がリプレイされ即破損する。
7. **失敗時のセッション復帰**: 置換前（copy/rename）失敗時は `grimodex.db` が元のままなので
   元 DB を開き直して `inner` を復帰（workspace-less で固まらせない）。置換後の再オープン失敗
   （例: 新アプリ製の前方非互換バックアップ）だけは `inner=None` になるため、エラー文字列に安定
   マーカー **`RESTORE_SESSION_LOST`** を載せ、FE に `window.location.reload()`（bootstrap の
   `open_workspace` が開き直す）を促す。
8. **UI 反映**: 復元成功後は `window.location.reload()` で全フロント状態を作り直す
   （プロジェクトスナップショット復元の終端と同様）。復元前に FE 側で保留中の保存を flush
   （`flushAllAutoSaves`/`awaitAllPendingSceneWrites`/`flushTimelapseRecorder`）し、未確定
   inline-AI diff は `guardInlineAiPending()` でブロックする（安全退避に直前の状態を確実に含める）。

### 3.2 バックアップ書き込みの原子性（既存バグ修正）

- 現状 `backup_to` は dest へ**直書き**。途中 kill されると**切株 .db** が生成され、
  `newest_backup_age_secs`（mtime 最新）と `rotate_backups`（名前ソート）を汚す
  （切株が「最新」扱い → 本物の古い世代が先に消える）。
- 修正: **`<name>.db.tmp` へ書き → 成功後 `rename`**（同一ディレクトリ内 rename でアトミック確定）。

### 3.3 コマンド境界（Tauri）

- `list_backups(ws) -> Vec<BackupInfo{ file_name, created_at, size_bytes, format }>`
  — `backups/` を列挙。`format` は将来 `.db` / `.db.gz` を区別（Phase 2 で使用）。
- `restore_backup(ws, file_name)` — §3.1 の手順を直列化契約下で実行。
- 既存 `backup_to` / `maybe_auto_backup` は §3.2 の原子性修正のみ。
- フロント: 設定 > データ（`DataCategory.tsx`）にバックアップ一覧＋「復元」導線を追加。

### 3.4 Phase 1 テスト

- Rust ラウンドトリップ: `backup_to` → 別ファイル → `restore`（= 置換）→ `quick_check` 合格。
- 切株耐性: `.tmp` 途中終了を模して、切株が age/rotation を汚さないこと。
- 混在ローテーション回帰の**素地**（Phase 2 で `.db.gz` を足すので、フィルタは 1 箇所に集約しておく）。
- Windows 実機での「開いているファイル置換」は手動チェックリストに追加（sandbox では再現不可）。

---

## 4. Phase 2 — gzip 圧縮

**出荷単位の価値**: ファイルサイズを即 3–6 倍削減（本文/JSON 主体のため）。

### 4.1 圧縮方式: gzip（flate2）

- `flate2` は `Cargo.lock` に**推移的に既存**（ort/tauri bundler 経由でコンパイル済み。
  直接依存への昇格はほぼ無料）。`GzEncoder`/`GzDecoder` で**両方向ストリーミング・一定メモリ**・CRC 内蔵。
  level 4–6 で十分。
- **zip 不採用**: 単一ファイルに容器フォーマット（central directory 等）の複雑さを足すだけ。
  唯一の利点「OS で開ける」は slim DB が手動コピー復元不可なので無意味。
- **brotli / zstd 不採用**: brotli は高品質が遅すぎ起動パスに乗らず、低品質は gzip と大差なし。
  zstd は新規依存（`Cargo.lock` 未収録）で ROI が悪い。

### 4.2 出力とローテーション

- `backup_to` の出力を `GzEncoder` に通し `<ws>/backups/grimodex-<ts>.db.gz` として保存
  （§3.2 の `.tmp`→`rename` を維持）。
- **`.db.gz` を `newest_backup_age_secs` と `rotate_backups` の両方のフィルタに追加**する。
  片方でも漏らすと (a) 間引き判定が新形式を見ず**毎回バックアップが走る**、
  (b) 旧 `.db` がローテ対象外で永遠に残る。**新旧混在を 1 つの集合としてローテーション**する。
  → §3.4 の方針どおり、フィルタ述語（`is_backup_file`）を 1 関数に集約し両所から使う。

### 4.3 リストアの拡張子分岐

- `restore_backup` を拡張子で分岐: `.db.gz` は `GzDecoder` でストリーム解凍 → 一時 `.db` を得て
  `quick_check` 合格後に §3.1 で置換。`.db`（旧形式）は従来どおり。**後方互換**を保証。

### 4.4 Phase 2 テスト

- gzip ラウンドトリップ（圧縮 → 解凍 → `quick_check`）。
- 破損 `.gz` / 切れた CRC の復元**拒否**。
- **`.db`/`.db.gz` 混在ローテーション**（世代数どおりに古い順で消え、形式で偏らない）。
- 混在時の間引き（`.db.gz` が最新なら age 判定に反映され毎回走らない）。

---

## 5. Phase 3 — slim 化（派生データ除外）＋復元時再構築

**出荷単位の価値**: 圧縮前で約半減 → gzip と合わせて**合計 1/6〜1/10**を狙う。

### 5.1 バックアップ生成側（slim）

`VACUUM INTO` は全テーブルをコピーするので、**コピー側だけを開いて派生を削る**。

1. `db.backup_to(&tmp)` でフルコピー（既存）。
2. `Connection::open(&tmp)` で**コピー側のみ**開く（`foreign_keys` は **OFF** のまま。cascade 事故回避）。
3. **チャンク 4 表を素の `DELETE`**:
   `DELETE FROM scene_chunks; DELETE FROM codex_chunks; DELETE FROM event_chunks; DELETE FROM chat_message_chunks;`
   （トリガ・被参照 FK なし＝`migrate.rs:1348-1444` で確認済。重複 `text` も同時に消える）
4. **FTS5 索引を空にする（JA / EN で方法が違う ← 最重要の取り違えポイント）**:
   - **JA（external content, `content=...`）**: `INSERT INTO <fts>(<fts>) VALUES('delete-all');`
     （**DROP TABLE は有害** — `*_fts_ai/ad/au` トリガが復元後の書き込みで即エラーになる。
     `delete-all` ならスキーマ・トリガを完全温存して索引だけ空にできる）
   - **EN（`*_fts_en`, 非 external）**: `DELETE FROM <fts_en>;`
     （`delete-all` は external/contentless 専用なので使えない。fts.rs:324-326 コメント参照）
5. **`VACUUM` を 1 回打つ**（必須）: DELETE だけだと解放ページが freelist に残り、
   (a) ファイルが縮まない、(b) 解放ページ上に埋め込み BLOB のバイトが**物理的に残って圧縮率を殺す**
   （`secure_delete` は既定 OFF）。
6. gzip ストリームで最終 `<ts>.db.gz` へ（`.tmp`→`rename`）。

**対象 FTS 表（JA 5＋EN 5）**:

| JA（external content） | EN twin（非 external） |
|---|---|
| `codex_fts` (`migrate.rs:540`) | `codex_fts_en` (`:2090`) |
| `snippets_fts` (`:546`) | `snippets_fts_en` (`:2094`) |
| `chat_messages_fts` (`:552`) | `chat_messages_fts_en` (`:2098`) |
| `tree_nodes_fts` (`:558`) | `tree_nodes_fts_en` (`:2102`) |
| `post_effect_annotations_fts` (`:1222`) | `post_effect_annotations_fts_en` (`:2106`) |

**除外対象は 1 定数に集約**し、`fts.rs` の `fts_rebuild`/`fts_optimize` が列挙する表と
**突き合わせる parity テスト**を必須にする（前例: `post_effect_annotations_fts` が後から追加。
この repo には `seed_schema_parity`（`database.rs:123`）の「二重定義ドリフトを CI で殺す」流儀が既にある）。

**I/O コスト**: フル書き 1 回＋slim 読み書き 1 回＋gzip で元サイズの約 2.5 倍の I/O。
破損リスクは低い（本体 DB には一切書かない。コピー上の失敗は tmp 削除で終わり）。

### 5.2 復元側（再構築）

slim バックアップは埋め込み・FTS 索引が空なので、復元後に再生成する。

1. **FTS 再構築 = 既存の `db.fts_rebuild()`（`fts.rs:284`）を無条件で呼ぶ**。
   この関数は既に **JA（external content の `'rebuild'`）と EN（`rebuild_en_fts_sql` の
   手動 `DELETE`→`INSERT`, `fts.rs:327`）の両方を正しく処理**する。
   → **復元側で JA/EN の手書き分岐は不要**（生成側だけが §5.1-4 の分岐を持つ）。
   - **無音故障の防止（最重要）**: external content FTS は索引が空でもエラーを出さず、
     検索が「0 件ヒット」で**静かに壊れる**（`integrity.rs` に FTS 空検知はない）。
     slim マーカー判定に頼らず**無条件 rebuild**（冪等・安価）にするのが単純で安全。
2. **埋め込み再 index**: 追加実装はほぼ不要。open 時の back-index（`autoIndex.ts`、PR#251）が
   「充足していないチャンク」を自動で埋める。ただし
   **同一セッション内で復元した場合は `resetIndexGuards(projectId)`（`autoIndex.ts:205`）を
   必ず呼ぶ**（`sceneAttempted` 等「1 セッション 1 プロジェクト 1 回」ガードを解除しないと
   back-index が走らない、`autoIndex.ts:29-32`）。
   - モデル未 DL 時: on-demand DL（`download.rs`）が走る。オフラインなら既存契約どおり
     dense 検索が一時 degrade するだけで執筆機能は無傷（災害復旧は稀という前提で妥当）。

### 5.3 （任意・推奨）open 時 FTS 乖離検知＋自動 rebuild

- open 時に「FTS 行数 vs コンテンツ行数」の軽量比較を足すと、slim 復元だけでなく
  **手動コピー復元や部分破損からも自動回復**でき、§5.2-1 の無音故障クラスを構造的に潰せる。
  小さい追加で守備範囲が広い。Phase 3 に含めるか follow-up にするかは実装時判断。

### 5.4 Phase 3 テスト

- **slim → gzip → restore → `fts_rebuild` → FTS ヒット確認**のラウンドトリップ（seed_schema ベース）。
- 復元後、埋め込みの充足判定（`semanticIndexStatus`）が incomplete を検知し、back-index が
  `resetIndexGuards` 経由で走ること。
- **除外テーブル定数 ↔ `fts_rebuild`/`fts_optimize` 対象**の parity テスト。
- JA/EN で消し方が違うことの回帰（EN に `delete-all` を使うと失敗する契約を明示的に固定）。

---

## 6. リスクと未解決事項（別チケット）

- **起動レイテンシ**: `maybe_auto_backup` は `open_workspace` の `spawn_blocking` 内で**同期実行**。
  Phase 3 で 2 回目の VACUUM＋gzip が乗ると大 DB で数秒級の上乗せ。
  中期対処: **別スレッド＋別の read-only コネクション**で実行（WAL は並行リーダを許し、
  `VACUUM INTO` は read-only DB でも動く。現行 `Mutex<Connection>` を掴まないのでバックアップ中の
  ユーザー操作ブロックも解消）。Phase 3 以降の最適化として。
- **`change_events` の無限増加**: 残す判断は正しい（ハッシュチェーン＝ソースデータ、
  `prune_old_logs` が意図的に除外）。ただし本設計では**縮まない**（gzip はよく効くが根本ではない）。
  compaction は**別チケット**。`state_snapshots` は forward-only 設計に絡むので今回は触らない。
- **後方互換**: 既存の無圧縮 `.db` が `backups/` に残る前提で、リストアは常に `.db`/`.db.gz`
  両対応（§4.3）。混在ローテーションは 1 集合（§4.2）。

---

## 7. 実装順序（サマリ）

**全 Phase 実装済み**（branch `feat/backup-restore-phase1`）。各 Phase は独立コミット。

| Phase | 状態 | 内容 | 主な変更点 |
|---|---|---|---|
| **1** | ✅ 実装済 | アプリ内リストア＋堅牢化 | `restore_backup`/`list_backups` コマンド、稼働中 DB 置換（直列化契約・wal 削除・安全退避・原子 rename）、`backup_to` の `.tmp`→`rename` |
| **2** | ✅ 実装済 | gzip 圧縮 | `flate2` 直接依存、`GzEncoder`/`GzDecoder`（`.db.gz`）、`is_backup_file` 集約＋両フィルタ更新、restore は解凍→verify→原子 rename |
| **3** | ✅ 実装済 | slim 化＋復元時再構築 | コピー側 slim（chunk `DELETE`＋JA `delete-all`/EN `DELETE`＋`VACUUM`）、`SLIM_*` 除外定数＋parity テスト、復元時 `fts_rebuild()`（埋め込みは reload 後 autoIndex が再構築＝`resetIndexGuards` 不要） |

補足（実装＋敵対レビューで確定）:
- 復元時の再オープン失敗は安定マーカー `RESTORE_SESSION_LOST` で FE に reload を促し、
  置換前失敗は元 DB を開き直してセッションを復帰（`reactivate_workspace`）。
- 安全退避は best-effort（破損 DB でも復元を諦めさせない）＋ quiesce 後に取得。
- **slim で `event_chunks` は除外**する。scene/codex/chat の埋め込みは reload 後の
  `ensureSemanticIndexesOnOpen`（autoIndex）が自己修復するが、**events の open 時
  back-index は存在しない**（`events_reindex_all` に FE 呼び出し元なし・events 検索は
  dense-only）ため、slim で消すと Chronicle イベント意味検索が無音全滅し復旧手段が無い。
  events 埋め込みは短く容量影響も小さいのでバックアップに残す（events back-index 実装は
  follow-up）。
- **open 時 FTS 自己修復（実装済）**: `slim_backup_copy` が `app_settings['fts.slim_backup']='1'`
  マーカーをバックアップに書き、`rebuild_fts_if_stale`（`open_workspace` と `restore` の
  happy path に配線）がそれを見て `fts_rebuild` ＋ マーカー消去する。復元の happy path 以外
  （`RESTORE_SESSION_LOST` 経由の reload / 手動でのバックアップ昇格）でも検索が無音故障
  しない。**external content FTS は索引を空にしても `SELECT`/`count(*)` が content 表を読む
  ため索引の空判定ができず、マーカーが唯一の確実な検知手段**（敵対レビューで判明）。
  通常 DB はマーカーが無いので単一 scalar query で no-op。rebuild 失敗時はマーカーを残して
  次回 open で再試行（eventually-consistent）。
- バックアップ名にミリ秒（`%3f`）を付与し同一秒衝突での世代喪失を防ぐ。
- 残: 実機 E2E（Windows 稼働中ファイル置換 / newer-schema 復元 / 大 DB の slim+gzip 時間・
  復元後の再 index 挙動）／ events の open 時 back-index（events を slim 対象化するなら前提）。

---

## 8. 参照ファイル

- `src-tauri/src/commands/workspace.rs` — `maybe_auto_backup` / `newest_backup_age_secs` /
  `rotate_backups` / `open_workspace`（:16-117）
- `src-tauri/src/database.rs` — `backup_to`(:62) / `quick_check`(:93) / `prune_old_logs`(:76) /
  WAL PRAGMA(:26-42) / `seed_schema_parity`(:123)
- `src-tauri/src/database/migrate.rs` — チャンク 4 表(:1348-1444) / JA FTS(:540-644) /
  EN FTS(:2053-2210) / `change_events`(:3129)
- `src-tauri/src/database/fts.rs` — `fts_rebuild`(:284) / `rebuild_en_fts_sql`(:327) /
  `fts_optimize`(:7)
- `src-tauri/src/database/integrity.rs` — FTS 空検知が無いことの確認
- `src/features/semantic-search/autoIndex.ts` — open 時 back-index / `resetIndexGuards`(:205) /
  セッションガード(:29-32)
- `src/features/settings/types.ts`(:198-200,371-373) / `src/features/settings/categories/DataCategory.tsx`(:191-216) — 設定キーと UI
- 関連設計書: `docs/Grimodex_Workspace設計書.md` / `docs/Grimodex_リビジョン履歴設計書.md`
  （プロジェクトスナップショット） / `docs/Grimodex_セマンティック検索設計書.md`
