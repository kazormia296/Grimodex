# チャットプロンプトビルダー統合 設計書

- 日付: 2026-06-15
- 対象: `src/features/chat/`(chatStore / ContextBar / ChatInput / PromptPreviewModal)
- 関連調査メモリ: `grimodex-prompt-3path-divergence`
- 関連: 過去スナップショット機構 / Layer4 RAG 注入設計 / スコープ別プロンプト

## 1. 背景と問題

ユーザー報告: 「プロンプトプレビューと実送信と送信ボタン右クリックコピーが違う(特に関連シーン、あと入力メッセージが入ってない)」。

調査の結果、チャットのプロンプト組み立て経路が **別実装で並立**しており、渡す引数が食い違うことが原因と確定(直感は全て実バグ)。共有ビルダー `buildSceneContextPrompt` 自体は3経路とも呼ぶが、**呼び出し時の引数**が経路ごとに異なる。

| 経路 | 入口 | RAG クエリ seed | 入力メッセージ | eco(`includeBodies`) |
|---|---|---|---|---|
| プレビュー | `ContextBar.openPreview`→`chatStore.buildPreviewPrompt` | 履歴の直近 user 発話 / 無ければ本文末尾 | systemのみ(非表示) | 本文ブランクする |
| 実送信 | `sendMessage`(agent / 非agent) | 今送る本文 `content` | outgoing user msg を含む | 本文ブランクする |
| 右クリックコピー | `ChatInput.handleSendContextMenu`→`chatStore.buildPromptForCopy` | **未指定(RAG走らない)** | `[user]` 行を末尾に付ける | **ブランクしない(全本文注入)** |
| 過去スナップショット | `ChatPanel.getMessagePrompt`(PromptPreviewModal の本来用途) | 送信時 `saveMessagePrompt` 保存値 | systemのみ | 送信時の値 |

### 確定した食い違い

- **① コピーに関連シーンが無い**: `buildPromptForCopy` の scene 経路が `buildSceneContextPrompt` を `semanticRecallSeedMessage` 無しで呼ぶ → `<related_scenes>` 丸ごと欠落。
- **② プレビューと送信で RAG クエリが違う**: プレビュー seed=履歴直近 user 発話/本文末尾、送信 seed=今打った本文。入力中テキストが履歴と違えば別シーンが出る。**初回送信(履歴空)は完全別物**。
- **③ プレビューに入力メッセージが無い**: `PromptPreviewModal` は systemPrompt のみ描画。入力中テキストは表示にも RAG seed にも使われない。
- **④ コピーが eco モードを無視**(調査メモリ列挙外・本設計で確定): send/preview は `!includeBodies` で `sceneCtx.content = ""` するが、`buildPromptForCopy` の scene 経路はブランクしないため eco モードでも全本文を注入する。
- (副次・スコープ外) スナップショットの `layers/totalTokens` はライブ `contextLayers` 保存だが `systemPrompt` は RAG 指示追記後の最終文字列 → 本文と内訳表に微ズレ余地。

### 根因

「これから送るメッセージ」を seed/会話に反映する処理が send にしか実装されておらず、preview と copy はそれぞれ別の近似でお茶を濁している。preview のボタンを持つ `ContextBar` は入力中テキスト(ChatInput の TipTap エディタ内)に到達できないため、構造的に send と揃えられなかった。

## 2. 方針(ユーザー承認済み: 完全統合)

**「これから送るメッセージ(`inputText` + `mentionedSceneIds`)」を3経路共通の seed にする。** send は既に `content` で実現済みなので、preview と copy を同形に寄せる。①②③④をすべて解消する。

過去スナップショット経路(`getMessagePrompt`)は「**送信時点で保存された履歴プロンプト**」が設計意図なので統合対象外。副次のスナップショット微ズレは別件として defer。

## 3. アーキテクチャ

### 3.1 入力ドラフト DI(機構 A)

入力中テキストを `ContextBar`(プレビューボタン)/`chatStore.buildPreviewPrompt` へ届ける。chatStore の既存モジュールレベル DI イディオム(`_resolveUserQuestion` / `_streamCleanup` 等, chatStore.ts:1429-1440)に倣う。

- モジュールレベル: `let _inputDraftProvider: (() => { markdown: string; mentionedSceneIds: string[] }) | null = null;`
- ストアアクション: `registerInputDraftProvider(provider | null)` を公開。
- `ChatInput` が mount 時(`useEffect`)に provider を登録し、unmount で `null` 解除。provider は `editor` から `getMarkdown()`(handleSendContextMenu と同じ取得法)と `collectMentionedSceneIds()` を返す。

**不採用の代替**:
- B(chatStore `inputDraft` state を onChange で都度書込): 打鍵経路にストア書込が乗る = 本プロジェクトのタイピング規律(perf メモリ)に反する。プレビューは開いた瞬間だけ値が要るので on-demand で十分。
- C(props 配線): `ContextBar` と `ChatInput` は直接の親子でなく、共通親(ChatPanel)からの getter 配線が増える。DI の方が薄い。

### 3.2 共通ヘルパ抽出

scene スコープの「outgoing プロンプト組み立て」を1関数に集約し、preview と copy が同一経路を通るようにする。

```
buildOutgoingScenePrompt(opts: {
  inputText: string;
  mentionedSceneIds?: string[];
}): Promise<{ systemPrompt: string; layers; totalTokens; loaded: boolean }>
```

内部処理(send の正準形に合わせる):
1. `fetchSceneContext` / `fetchProjectContext`。
2. **eco 一元化**: `!get().includeBodies` なら `sceneCtx.content = ""`(④の修正をここに集約)。
3. `conversationMessages = [...messages(非summarized), outgoing user msg(content=inputText)]`(inputText 非空時)。
4. `buildSceneContextPrompt` を `semanticRecallSeedMessage = inputText.trim() || 本文末尾フォールバック`、`mentionedSceneIds`、`excludedAutoEntryIds` 付きで呼ぶ。
5. `{ systemPrompt, layers, totalTokens, loaded:true }` を返す。

send(`sendMessage`)は streaming / 永続化 / 要約 / agent ループを内包し構造が大きく異なるため**この関数には畳み込まない**。ただし同一 `buildSceneContextPrompt` 呼び出し(seed=content + outgoing 含む conversationMessages + eco ブランク)を**正準**として維持し、preview/copy をそれに一致させる。

### 3.3 各経路の改修

- **`buildPreviewPrompt`**:
  - `_inputDraftProvider` から `{ markdown, mentionedSceneIds }` を取得(未登録なら `markdown=""`/`mentionedSceneIds=[]`)。
  - scene スコープ: `buildOutgoingScenePrompt({ inputText: markdown, mentionedSceneIds })` を使用。
  - 非 scene スコープ: 従来通りライブ `lastSystemPrompt` を返す(RAG 非対象)。
  - 戻り値に `userMessage: markdown` を追加し、モーダルが `[user]` 行を描画できるようにする(全スコープ)。
- **`buildPromptForCopy`**:
  - scene 経路を `buildOutgoingScenePrompt({ inputText: userInput, mentionedSceneIds })` 経由に置換 → ①④を同時修正。
  - `[system]` + 履歴 + `[user]\n${userInput}` のテキスト連結は従来通り(コピーはプレーンテキスト出力のため)。
  - 非 scene 経路(`refreshContextLayers` 流用 + mention cleanup)は現状維持。
- **`PromptPreviewModal`**:
  - `userMessage?: string` prop を追加。非空時に「送信メッセージ」セクション(`[user]` 相当)を全文プレビューの直後/直前に描画。
  - i18n キー追加(例: `chat.context.outgoingMessage`)。`ContextBar` の `previewData.userMessage` を渡す。
- **stale JSDoc 是正**: `semanticRecallSeedMessage` のコメント(chatStore.ts:1567-1570)「未指定(プレビュー/コピー経路)なら検索走らない」を実態に合わせて更新。

## 4. データフロー(完成形)

```
ChatInput (mount) ──registerInputDraftProvider──▶ chatStore._inputDraftProvider
                                                        │
ContextBar.openPreview ─▶ buildPreviewPrompt ───────────┤  (provider 読取)
                                                        ▼
ChatInput.handleSendContextMenu ─▶ buildPromptForCopy ─▶ buildOutgoingScenePrompt
sendMessage(content) ─────────────────────────────────▶ buildSceneContextPrompt
                                                        (seed = 今送る本文 / 入力中テキスト)
```

preview / copy / send は同一 seed・同一 conversationMessages・同一 eco 規則で `buildSceneContextPrompt` に到達 → system プロンプト部分が一致する。

## 5. エラー処理・エッジケース

- **プレビューを空入力で開く**: `markdown=""` → seed は本文末尾フォールバック、outgoing user msg は積まない、モーダルの `[user]` セクションは非表示。
- **provider 未登録**(ChatInput 未マウント等): `buildPreviewPrompt` はフォールバックで従来挙動(本文末尾 seed)に縮退、`userMessage=""`。
- **非 scene スコープ**: RAG 非対象。preview/copy/send とも `lastSystemPrompt` 共有(既存)。preview は `userMessage` のみ追加表示。
- **eco モード**: `buildOutgoingScenePrompt` 内で一元ブランク。preview/copy が send と一致。
- **取得失敗(`buildOutgoingScenePrompt` 例外)**: preview はライブ値へ縮退(既存 try/catch 方針踏襲)、copy は `lastSystemPrompt` フォールバック(既存)。

## 6. テスト方針

happy-dom 単体(`chatStore.test`)中心。レイアウト幾何は無関係なので browser test 不要。

- **不変条件**: 同一(scene, 履歴, 入力, mentions)で `buildPreviewPrompt().prompt` と `buildPromptForCopy()` の `[system]` 部分がバイト一致。
- **① 回帰**: semantic recall をモックして copy 出力に `<related_scenes>` が含まれること。
- **② 回帰**: 入力中テキストが履歴直近 user と異なるとき、preview の seed が入力中テキストであること(モック `userMessage` 引数検証)。
- **③**: `buildPreviewPrompt` が `userMessage` を返し、`PromptPreviewModal` が入力行を描画すること。
- **④ 回帰**: `includeBodies=false` で copy の system に本文が含まれないこと。
- **mock 更新**: `chatStore.test` の store mock に `registerInputDraftProvider` を追加(過去 `saveMessagePrompt` 追加と同型の必須対応)。

## 7. スコープ外(明示)

- 過去スナップショット経路(`getMessagePrompt` / `saveMessagePrompt`)の統合 — 設計意図(送信時保存)を保つ。
- スナップショットの `layers/totalTokens` vs `systemPrompt` 微ズレ — 別件として defer。
- 非 scene スコープの RAG 化 — 対象外(RAG は scene 限定が現行仕様)。

## 8. 検証コマンド

- `pnpm test --run src/features/chat`
- `npx tsc --noEmit`
- `pnpm lint:fix`
