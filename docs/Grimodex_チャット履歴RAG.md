# チャット履歴 RAG（エピソード記憶）

## 背景・狙い

記憶には二系統ある:

- **状態（いま何が真実か）** — Grimodex は Codex（事実）とシーンの semantic recall（本文）で既に押さえている。
- **エピソード（いつ何を話し・決め・捨てたか＝過程）** — 唯一の置き場がチャットログで、しかも AI から不活性だった。

本機能は欠けていた後者を補う。過去セッションを含むチャットを **シーンと同じ意味検索経路**で recall し、プロンプトへ注入する。「先週話したことを毎回忘れる相手」を共作者へ近づける。

## 設計原則（最優先）

1. **recall に徹する柔らかい層**。canon 化（恒久的事実への固定）はしない。固定は従来どおり人が確認する Codex（硬い層）に残す。AI がチャットを蒸留して「事実」に固める方向（Penlytics 型の AI 正本化）へは振らない。
2. **順序は Codex（always）> scene RAG > chat RAG**。古い対話が正典を上書きできない。contextBuilder の `volatileTail` / `prompt` 配列の並びと、注入ブロック冒頭の運用説明（`chatRecallIntro`）の両方で担保する。
3. **scope は grimodex.db 単位**。すべてローカル完結（クラウド型への差別化）。
4. **チャットはシーンより雑多**なので「実際に効いた発話」を重み付けする（後述）。

## アーキテクチャ（既存 RAG 経路の延伸。新規“記憶システム”は作らない）

### 1. インデックス（Rust, codex の 1 エントリ 1 ベクトル経路をフォーク）

- 新テーブル `chat_message_chunks`（`src-tauri/crates/grimodex-db/src/migrate.rs`）。`chat_messages` に `project_id` が無いため、検索スコープを効かせるため **`project_id` / `session_id` を index 時に非正規化**して持つ。`inserted_to_editor` / `extracted_count` の効果信号も列に持つ。Rust 専用（Drizzle mirror 不要 = codex_chunks と同じ）。
- `src-tauri/src/semantic/chat_index.rs` — `read_chat_message_for_index` / `upsert_chat_chunk` / `embed_chat_text`。**hash 入力に効果信号を含める**ので、本文不変でも metadata 変更 → hash 変化 → 再 index で signal 列が更新される（stale-weight drift 対策）。user/assistant の非空メッセージのみ対象（system / 空は除外）。
- トリガ: `scheduleChatIndex(messageId)`（`scheduler.ts`、2.5s デバウンス）を `chatApi.addMessage`（確定 1 回）と `updateMessageMetadata`（信号変化）から呼ぶ。
- コマンド: `chat_index_message` / `chat_message_search` / `chat_index_status` / `chat_reindex_all`（`commands/semantic.rs`、`lib.rs` 登録）。`ChatSearchCache` は workspace 切替で clear。

### 2. 検索 + 重み付け + 選別（JS）

- `chat_message_search`（Rust）は **生 cosine + 信号**を返す。重み付け・gate は JS に集約（scene/codex と同じ哲学）。
- `chatRecall.ts`:
  - 重み係数 `weight = roleBase × (1 + α·insertedToEditor + β·min(extractedCount, k))`
    - α=`CHAT_RECALL_INSERTED_BOOST`(0.15) / β=`CHAT_RECALL_EXTRACTED_BOOST`(0.10) / k=3
    - `roleBase`: user・信号付き assistant = 1.0、**素の assistant 散文 = 0.8**（モデル自身の過去の憶測が等倍で「記憶」として戻る self-reference を抑える）
  - **gate/floor/選別は RAW cosine** で scene recall の選別関数（`selectSemanticRecallChunks` / `selectHybridRecallChunks`）を流用し、**重み付けは選別後の並べ替えにのみ使う**。当初は `weight × cosine` を gate score にしていたが、実埋め込み較正で信号付きメッセージ（cos×1.15）が無関連クエリでゲートを突破し precision を壊すと判明（ja 無関連 raw≈0.78→weighted≈0.98）。raw-gate 化で fpRate 1.0→0。詳細は [較正ハーネス](Grimodex_チャット履歴RAG_較正ハーネス.md)。閾値は `chatRecallParamsForLang`（ja=scene 0.85/0.80、**en=chat専用 0.66/0.60**＝scene 0.51 はチャット無関連を弾けず較正で引き上げ）。
  - 現セッションは `excludeSessionIds` で除外（進行中ターンを記憶として引き戻さない）。
- hybrid: sparse 腕は既存の `chat_messages_fts`（FTS5/trigram、トリガ同期済）に `fts_search` の `scope:"chat"` を足して再利用。`ai.hybridRecall` を scene RAG と共有。

### 3. プロンプト注入（contextBuilder）

- 新入力 `chatRecall?: Array<{label; text}>`、新タグ `chat_history`、新レイヤー `EPISODIC`。
- **cacheSegments には絶対に入れない**（クエリ依存で毎ターン変わる → Anthropic prompt cache が壊れる）。`prompt` + `volatileTail` のみ。`l4Volatile → PLOT_THREAD → scene RAG → EPISODIC → L5` の順で配置（`contextBuilder.ts` 1701–1708）。
- trim 順は **EPISODIC → RAG → PLOT_THREAD → CHRONICLE → L5 → …**（最も投機的な層を最初に削る）。

### 4. 「Codex に昇格しますか？」プロンプト（柔→硬の橋渡し）

- `chatRecallPromote.ts` — 同じ過去発言が閾値（3 回）recall されたら、**既存の抽出 UI**（`CodexExtractionDialog`）を促すバナーを composer 直上に出す。per-session・in-memory、dismiss で再提案なし、実送信ターンのみカウント。
- 自動書き込みは一切しない（recall-only）。抽出すると `extractedCodex` 信号が付き、再 index で weight が上がる自己強化ループになる。

## 設定

- `ai.chatRecall`（既定 ON、独立トグル。OFF で scene RAG を残したまま記憶だけ切れる）
- `ai.hybridRecall` を scene RAG と共有。

## 較正（[較正ハーネス](Grimodex_チャット履歴RAG_較正ハーネス.md)）

- 実埋め込み（ローカル ONNX）での sweep で **raw-cosine ゲート化**（precision バグ修正）と
  **en gate 0.66/0.60**（scene 0.51 はチャット無関連を弾けない）を確定・適用。両言語 fpRate=0。
- 未適用: α/β/cap/plain の微調整（raw-gate 化で重みは順位付けのみに効くため影響小）。
  より分離の良いコーパス（強いモデルで生成）で再較正の余地。reranker が precision の最終解。

## 残ゲート

- 実機 GUI QA（バナー表示・昇格フロー・縦書き等は未確認）。
- en の 0.66/0.60 は小コーパス由来の暫定値。`debugLog "ChatRecall"` 行で実データ可観測。
