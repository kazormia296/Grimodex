# Grimodex_AIによる書き込み横断検討

> 横断調査メモ（2026-06-04）。アウトライン・フォルダ構成・本文・Codex/Snippet・Map・Foreshadow・シノプシス・校閲を「AIが書き込む面」として3軸（エントリ点／ポリシーゲート／出自追跡）で棚卸しし、不整合と前進オプションを整理したもの。全主張は file:line で裏取り済み（multi-agent 調査 + 敵対的検証）。案A/B/C の前進オプションはまだ着手していない。

> **更新（2026-06-04 master セキュリティ監査 / commit 69859522・AI-1）**: 本メモが「typo fix adopt は ungated」と記述した点は**超過済み** — `typoFix.ts applyTypoFixAndResolve` 先頭に `blockIfPolicyOff('bodyWrite')` を追加済（決定論ローカル applyFix は非 gate）。一方、**出自の誤計上（AI 本文が authorship mark 無しで `source='human'` 着地）は未解消**で、本メモ §(c)状態3・案A の typoFix/Foreshadow provenance 指摘は依然有効。詳細は [`docs/security/master-audit-2026-06.md`]。

## 0. 検証済みの土台（要点）

- **agent tool protocol は完全 read-only**。`AGENT_TOOLS`(`toolDefinitions.ts:4-264`) の15ツールは全て read か `ask_user` の UI 往復のみ。`EXECUTORS`(`toolExecutors.ts:947-964`) は read-only 14 executor を `Object.freeze`、F-2 security review 契約として「ここに載る executor は全て read-only」とコメント明記。DB/editor/map/codex への書き込みツールは存在しない。
- したがって**全サーフェスの AI 書き込みは bespoke UI（人間が必ずクリックして着地させる）経由**で、agent からは1つも到達不可。
- `bodyWrite` ポリシーは「scene doc に書く」経路（inline-AI / Beat）にしか HARD gate されておらず、他の AI 散文着地点（Codex summary・synopsis 列・Snippet 行・Map sticky・伏線挿入文）は射程外。
- 出自追跡は「記録」と「集計到達」の2軸が独立で、サーフェスごとに4状態が混在（健全／書かれるが読まれない／誤って human と記録／完全 untracked）。

## 1. 現状マトリクス

行=AI-write サーフェス。「出自: 記録」=挿入時に mark/span/行フラグが付くか。「出自: 集計到達」=`provenance.ts`(nodeId join)/`loadBatchAiRatio`/`projectStats` の nodeId スコープ集計がそれを読むか。両者は独立。

| サーフェス | AI書き込み機構 (file:line) | エントリ点 | ポリシーゲート (キー) | 出自: 記録 | 出自: 集計到達 |
|---|---|---|---|---|---|
| **本文 (prose)** | inline-AI `useInlineAiDiff.ts:194,213`; Beat streaming `insertBeatStream.ts:126`; `generateBeatOnce.ts:25`; `insertFromChat editorStore.ts:63`; `insertFromSnippet :163`; `insertFromPaste :240` | bespoke UI | **HARD** `bodyWrite` (inline `useInlineAiDiff.ts:75`, Beat `useBeatGeneration.ts:170`) — ただし**穴3つ**: `generateBeatOnce`/chat挿入(SOFTのみ)/snippet・paste挿入は ungated | mark `source='ai'`+model+(inline/Beatは)traceId; chat挿入は+chatMessageId | **到達** (scene doc → `extractDbSpans api.ts:99` → `authorship_spans` nodeId行; traceId→`generation_logs`, chatMsgId→`chat_messages`) |
| **Codex** | チャット抽出 dialog/quick `ChatPanel.tsx:436,449`; AI summary生成 `DetailsTab.tsx:290`→`chatApi.ts:84` | bespoke UI | **無し** (rg 0件) | `sourceChatMessageId` のみ(粗粒度, **ai/human 不可判別** — user抽出でも同列が埋まる; AI summary経由は付かない) | **非到達** (`summary` は plain TEXT列 `schema.ts:156`; `authorship_spans.codexEntryId` 列は在るが永続化呼出ゼロ=dead column) |
| **Snippet** | チャット抽出 quick/detailed `ChatPanel.tsx:485,503`; Beat Alternative `generateBeatAlternative.ts:81-104` | bespoke UI | **無し** (チャット抽出); Beat Alt は `bodyWrite` **presentation のみ** `SceneBeatNodeView.tsx:74` (HARD gate 無し) | 行フラグ `contentSource='ai'` `schema.ts:318`+`sourceChatMessageId` (**Codexより強い行レベル二値**); Beat Alt は model/traceId を破棄 | **非到達** (`authorship_spans.snippetId` 列は在るが永続化呼出ゼロ; per-span 帰属は scene 挿入時に初めて発生) |
| **Map (AI Branch)** | `generateAiBranchCards mapAiApi.ts:209`→`createAiBranch mapApi.ts:904`; `seedAuthorshipMarksJson :989` | bespoke UI (`buildSystemPrompt mapAiApi.ts:48` が contextBuilder/agent ループを bypass) | **無し** (`src/features/map/` に policy 参照 0件) — **意図的判断**[bodywrite-chat-suppression] | mark `source='ai'`+model + **stickyId-keyed `authorship_spans` 行 `mapApi.ts:1065-1079`** (lossy 射影を通らない直書き) | **非到達** (span は stickyId lane に隔離; `provenance.ts:272` は nodeId のみ, `projectStats.ts:23` も nodeId スコープ → **書かれるが読まれない**) |
| **Foreshadow** | `adoptInsertedNewSetup foreshadowStore.ts:855-1017` (本文挿入 `:916`); designated/audit/evaluate はメタのみ | bespoke UI | **無し** (`src/features/foreshadow/` に policy 0件) | **無し** — `foreshadowSetup` mark のみ(source 属性なし), authorship mark/programmaticInsert 不付与 → **`source='human'` で着地** | **誤集計** (human として計上; foreshadow-local `attribution='ai'` 列はパネル表示専用) |
| **tree (アウトライン/フォルダ)** | **構造変更の AI 機構は皆無** (createNode/moveNode/deleteNode/renameScene は人間専用) | — (AI 不可達) | — | — | — |
| **シノプシス** | `generateSynopsisFromContent` (手動/status自動/StorySoFar一括); `generateSynopsisFromBeats.ts:72` — 全て `updateSynopsis treeStore.ts:1119` 単一集約 | bespoke UI | **無し** (4経路すべて 0件) | **無し** (`tree_nodes.synopsis` plain TEXT列; timelapse `recordChangeEvent` は source/model なし=人間編集と同一) | **非到達** (専用列すら無い) |
| **校閲 (kouetsu)** | review/pseudo_comment/typo/consistency/meta_structure run `api.ts:29,37`; **typo fix adopt `typoFix.ts:44-48`** (唯一の本文書込) | bespoke UI | **HARD** `analysis` (各 view `blockIfPolicyOff('analysis')`) — ただし **typo fix adopt は analysis/bodyWrite 両方 ungated** | run は別系統 `post_effect_annotations`(authorRole='ai')+`post_effect_runs`(model); typo fix は **authorship mark 不付与 → `source='human'`** | 注釈は別系統で追跡可だが `authorship_spans`/`projectAuthorship` 非到達; typo fix は **誤集計(human)** |
| **その他 (chat summarization)** | `runSummarization summarization.ts:52`→`addSummary chatApi.ts:865`→`chat_summaries`; 副次=RAG citation `chatStore.ts:2793`, timelapse capture `captureChat.ts:26` | 内部パイプライン (`sendMessage` 内自動) | **SOFT** `chat` (transitive: `sendMessage` 冒頭 `chatStore.ts:2373` blockIfPolicyOff) | **無し** (`chat_summaries schema.ts:439` に source/model/traceId 列なし — 最も provenance-poor) | **非到達** |

## 2. 横断的な不整合

### (a) エントリ点ムラ — agent は読めるが書けない、書き込みは全て bespoke
**9 サーフェス全ての AI-write が bespoke UI 経由で、agent tool protocol からは 1 つも到達不可。** `EXECUTORS`(`toolExecutors.ts:947-964`)は read-only 14 executor を `Object.freeze` で凍結、F-2 security review 契約として「ここに載る executor は全て read-only」とコメント明記。agent は `search_codex`/`get_scene`/`list_open_foreshadows` 等で**読める**が、tree mutator・editor write・codex write ツールは定義に存在しない。`declaredToolNames` ゲート(`agentLoop.ts:133,222`)が将来の mutating executor の宣言ターン外発火も防ぐ。この read/write 非対称は構造的に一貫した設計判断であり、バグではない。

### (b) ポリシー被覆ムラ — bodyWrite は本文 doc にしか効かない
`bodyWrite` HARD gate の配線先は `useInlineAiDiff.ts:75` / `useBeatGeneration.ts:170` / `inlineAiCommands.ts` のみ。これが効くのは「scene doc に書く」経路だけで、以下を素通りする:

- **意図的 (MEMORY で確認済)**: チャット→本文は SOFT(L0 prompt 抑止文のみ, `insertFromChat editorStore.ts:63` に gate 無し)[bodywrite-chat-suppression]; Map AI Branch は完全 ungated(`src/features/map/` policy 0件)で「AI Branch 対象外」判断と整合。
- **オーバーサイト (memory cover 無し)**:
  - `generateBeatOnce.ts:25`「Place at end and generate」は同じ Beat 散文を本文に着地させるのに HARD/presentation 両方未配線(disabled は `!mainEditor` のみ, `UnplacedBeatItem.tsx:223`)。兄弟 Beat 経路 `useBeatGeneration.ts:170` が HARD gate なのと**非対称**。
  - `insertFromSnippet`/`insertFromPaste`(`editorStore.ts:163,240`)に gate 無し → AI snippet/AI コピー断片が bodyWrite=off でも本文着地。
  - Codex AI summary(`DetailsTab.tsx:290`)・Snippet チャット抽出・Foreshadow `adoptInsertedNewSetup`・シノプシス4経路は全 ungated。assist-off/off プリセットでも走る。

「本文 doc 以外への AI 着地はゲート射程外」が横断パターン — bodyWrite は概念的に「scene 本文」専用キーで、Codex summary・synopsis 列・Snippet 行・Map sticky・伏線挿入文という**他の AI 散文着地点を一切カバーしない**。

### (c) 出自被覆ムラ — 4 つの状態が混在
1. **記録+集計到達**(健全): 本文 inline-AI/Beat/chat挿入。mark+span+(generation_logs/chat_messages)。`generateBeatOnce` も source='ai'+`insertGenerationLog :109` で完全(policy gap ≠ provenance gap)。
2. **記録されるが集計非到達**(消費側の死角): **Map AI Branch** — `mapApi.ts:1065-1079` が `source:'ai'` の `authorship_spans` 行を直書きするが stickyId lane に隔離され、`provenance.ts:272`(nodeId join)・`projectStats.ts:23` が読まない。**書かれるが読まれない**。AI 使用箇所レポート(93b1aa7c)に Map 由来 AI 本文が現れない死角。Snippet `contentSource='ai'`・校閲 `post_effect_annotations` も同型(別系統に在るが横断集計に乗らない)。
3. **誤って human と記録**(最悪 — 人間比率を汚染): **Foreshadow `adoptInsertedNewSetup`**(`foreshadowStore.ts:914-919`)と**校閲 typo fix adopt**(`typoFix.ts:44-48`)は AI 散文を `insertContentAt` するが authorship mark も `programmaticInsert` meta も付けない → `AuthorshipMark` default `source='human'` で着地し、`AiEditedPlugin` も新規挿入は対象外。AI 由来本文が `authorship_spans` 上 human として計上され `loadBatchAiRatio` を歪める。
4. **完全 untracked(中立)**: Codex summary・synopsis 列・chat_summaries。専用列が無く plain TEXT。人間編集と区別不能。

### (d) tree/アウトラインの縦の空白
**章/シーン/フォルダの構造(create/move/delete/rename/reorder)を触る AI 機構が一切無い。** agent tool には mutator が無く(read-only 契約)、bespoke AI ボタンも構造編集を持たない。AI が tree に触れる唯一点は `scene.synopsis` 1 フィールドのみ(それも ungated・untracked)。構造編成は完全に人間専用 — これは安全側の縦の空白で、唯一の「AI が原理的に介入していないサーフェス」。

## 3. 設計上の論点

**(a) 単一 AI-write 経路 vs N 個の bespoke。** 現状は 9 サーフェス × 7+ 機構の bespoke が並立し、policy/provenance の配線が機構ごとにバラバラ(上記 (b)(c) のムラの根本原因)。「単一経路」候補は 2 つ — agent tool protocol(§(c))か、または「AI 散文を本文/メタに着地させる共通 sink 関数」。前者は F-2 read-only 契約を破る必要があり security boundary を動かす。後者(`insertFromChat`/`updateSynopsis` 等を 1 つの attributed-write helper に集約)は blast radius が大きいが概念的に正しい。

**(b) チョークポイント横断的関心事。** policy gate と provenance tagging は本来 cross-cutting concern。現状はサーフェスごとに手配線で、追加するたび 1 つ忘れる(`generateBeatOnce`・typoFix・Foreshadow が実証)。`saveAuthorshipSpans`(`api.ts:42`)は既に scene doc の choke だが**呼出元が scene エディタに限定**(EditorPane/LinearSceneBlock + map sticky)で、これが codexEntryId/snippetId 列を dead column にしている。理想は「AI が永続テキストを書く全経路が必ず通る 1 関数 + そこで policy 確認 & source タグ強制」。ただし plain TEXT 列(summary/synopsis)は span 化できない構造的制約があり、完全統一には schema 変更が要る。

**(c) アウトライン/フォルダ・フロンティア。** AI に tree 構造の scaffold/再編を解禁するかは最大の未踏点。リスクが質的に違う: 破壊的 move/delete(現状 `treeStore` mutation は全て `recordChangeEvent`+globalHistory undo を持つので undo 基盤は在る)、構造変更の帰属(synopsis ですら追跡が無い現状で structural op の source をどう残すか未設計)、agent への mutator 解禁は F-2 契約の明示的変更。

## 4. 前進オプション

### 案A — 横の統一: 既存 AI-write に policy+source を揃える
**Scope:** ungated 経路に `blockIfPolicyOff` を足し、誤 human 着地に authorship mark を付ける。
**最小・最高 ROI の着手点(チョークが既に単一)**:
- シノプシス: `updateSynopsis`(`treeStore.ts:1119`)に `source` 引数追加 + 4 呼出元前に gate。**1 store action + 4 callers** で全 synopsis AI-write をカバー(最安の勝ち)。
- Foreshadow `adoptInsertedNewSetup`(`foreshadowStore.ts:916`)と typo fix(`typoFix.ts:44`)に `insertFromChat` 流儀(source='ai'+programmaticInsert)の mark を被せる → 誤 human 計上を解消。1 関数ずつ、blast radius 極小。
- `generateBeatOnce.ts:25` に `useBeatGeneration.ts:170` と同じ `blockIfPolicyOff('bodyWrite')` を 1 行追加。
- Map: span は既に書かれているので、`provenance.ts`/`projectStats` の集計を nodeId に加えて **stickyId span も読む**よう拡張(消費側修正のみ、生成側は触らない)。

**Blast radius:** 小〜中。各々独立した局所修正で、機械的分割でも一括リファクタでもない。master 直 commit と blast-radius-min 方針に最も適合。
**ROI:** 高。「ユーザーが AI を off にしたのに動く」「AI 本文が human と数えられる」という実害を直接潰す。**推奨の中核。**

### 案B — 縦の拡張: tree/アウトラインへの AI 書き込み解禁
**Scope:** AI が章/シーンを scaffold・再編。新フロンティア機能。
**Blast radius:** 大。構造 mutation の帰属モデルが未設計(synopsis ですら untracked)、破壊的 op の安全設計、agent 解禁なら F-2 契約変更。
**ROI:** 機能価値は高い(「コア体験: AI から知識を抽出し構造化」と方向一致)が、案A の負債を残したまま縦に伸ばすと不整合が増殖。**案A 完了後に独立フェーズとして検討すべき。** 単独で先行するのは非推奨。

### 案C — 構造の統一: agent tool protocol を mutating tool で全サーフェス化
**Scope:** `EXECUTORS` に write tool を追加し、agent が全サーフェスに書ける単一経路を作る。
**Blast radius:** 最大。F-2「全 executor は read-only」security 契約の明示的破棄、`declaredToolNames` ゲート(`agentLoop.ts:133`)の役割を「将来防御」から「現役 mutation guard」へ転換、各 write に policy+attribution を tool 層で強制する再設計。
**ROI:** 概念的には最もクリーン(N bespoke → 1 protocol)だが、現状の bespoke UI は「人間が必ずクリックして着地させる」明示的同意モデルでもある。これを agent autonomy に置き換えるのは UX とセキュリティの根本転換。**今は時期尚早。案A で横を揃えてからでないと、統一すべき契約自体が定まらない。**

## 5. 次の判断

**横の統一(案A)を先に閉じるか、それとも縦/構造の拡張(案B/C)に進むか。**

推奨は案A 先行 — 既存 AI-write の policy 穴(`generateBeatOnce`/Foreshadow/synopsis)と誤 human 計上(`foreshadowStore.ts:916`/`typoFix.ts:44`)と Map 集計死角は、いずれも単一チョークまたは局所修正で blast-radius 最小、かつ実害が確定済み。これらを揃えるまで「AI が何を書いてよく、どう追跡されるか」の契約が確定しないため、案B(tree 解禁)・案C(tool protocol 統一)は土台が固まってから着手すべき。

判断いただきたいのは: **(1) 案A の負債解消を次フェーズに切るか、(2) tree への AI 書き込み(案B)を新フロンティアとして優先するか、(3) 当面は現状の bespoke 並立を許容し個別対応に留めるか。**

## 付録: 横断検証の結論（敵対的チェック済み）

| 仮説 | 判定 | 補正 |
|---|---|---|
| agent tool protocol は tree を mutate できない（AI はアウトライン/フォルダを scaffold/再編できない） | **confirmed** | `src/features/chat/` に createNode/moveNode/deleteNode 参照ゼロ |
| bodyWrite=off は Map AI Branch を gate しない | **confirmed** | より強く、Map は chat/analysis 含む**全 ai-policy を bypass**（send_chat_message 直叩き）。かつ「untracked」は誤り — span は書くが nodeId 集計から不可視 |
| inline-AI/Beat 生成は chat_msg_id 出自を持たない | **confirmed** | untracked ではない — traceId→`generation_logs` で追跡される |
| Codex/Snippet の AI 抽出は本文 prose と異なる出自記録 | **partial** | Codex と Snippet は別機構。Snippet は行レベル `contentSource='ai'` 二値を持ち Codex より強い。Codex summary は ai/human 不可判別 |
| synopsisSuggestion の AI 書き込みは ungated かつ untracked | **confirmed** | — |
| kouetsu Editorial/疑似コメントは gate/track されているか | **confirmed** | review/pseudo は analysis HARD gate + post_effect_annotations 追跡。ただし**隣接の typo fix adopt は ungated かつ source='human' 誤着地** |

### 主要関連ファイル
- `src/features/editor/editorStore.ts`（insertFromChat / insertFromSnippet / insertFromPaste）
- `src/features/editor/beat/generateBeatOnce.ts`（ungated Beat 経路）
- `src/features/foreshadow/foreshadowStore.ts`（adoptInsertedNewSetup — human 誤着地）
- `src/features/post-effect/typoFix.ts`（typo fix adopt — human 誤着地・ungated）
- `src/features/tree/treeStore.ts`（updateSynopsis — synopsis 単一チョーク）
- `src/features/map/mapApi.ts`（createAiBranch + stickyId span 書込）
- `src/features/attribution/provenance.ts` / `projectStats.ts`（nodeId スコープ集計 — Map span を読まない）
- `src/features/chat/agent/toolExecutors.ts`（EXECUTORS freeze / F-2 read-only 契約）
- `src/features/ai-policy/{types,policyGuard,preset}.ts`（capability キー = chat / bodyWrite / analysis）
