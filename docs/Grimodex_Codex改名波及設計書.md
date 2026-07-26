# Grimodex Codex 改名波及 設計書

## 目的

Codex エントリの名前(`codex_entries.name`)を改名したとき、その名前を参照している箇所へ
変更を波及させる。ただし同名別エントリ・部分文字列・別 alias 一致といった**重複ハザード**を
踏まないこと。

ステータス: Item A / B / C すべて実装完了(2026-06-08)。Item C の I/O 統合層は実機検証(pnpm electron:dev)が残課題。

## 実装進捗

- **Item B 完了**: `exportEngine.ts` に `case "mention"`(resolver→焼き込み label→id)。`MentionNameResolver` を
  RenderCtx/options に注入式で追加。publish export(`ExportDialog`/`ExportSettingsPanel`)に
  `currentCodexMentionResolver()`(`codex/mentionNameResolver.ts`)を配線。write-back は hash ドリフト回避で
  label デフォルト維持。テスト: `exportEngine.test.ts`(+5)。
- **Item A 完了**: `CodexMentionExtension.ts` に plain PM NodeView(`RubyNode` パターン)。`data-entry-id`→
  `useCodexStore` 現在名を render 時解決 + store 購読で改名追従。doc 非変更。テスト: `CodexMentionExtension.test.ts`(+3)。
- **Item C 検出層 完了**: `codex/rename/detectOccurrences.ts`(純粋・JS matcher・`matched text===oldName` フィルタで
  同名衝突 silent miss 回避・`ambiguous` フラグ・ruby フラグ)。テスト(+8)。
- **Item C flatten 契約 完了**: `editor/codexDocFlatten.ts`(getDocText パリティ + flatPmPos/flatIsRuby)。
  `CodexHighlightPlugin` を委譲に refactor(契約一本化)。テスト(+5、parity gate 含む)。
- **Item C 置換コア 完了**: `codex/rename/applyReplacementsToDoc.ts`(`applyReplacementsToDoc` =
  PM doc を flat offset で mark 保持置換・ruby skip・mention 不可侵・back-to-front、`applyReplacementsToString` =
  プレーン文字列版)。テスト(+8: mark 継承・ruby skip・mention 残存・長さ変化)。
- **Item C 残(統合層・実アプリ検証必須)**:
  1. `gatherSources`: 全 scene(`loadScenesFull`)+ codex summary/content/notes/detailValue(text)/relation.label を
     収集し、PM doc は `getSchema(getEditorExtensions({setMentionPopup:()=>{}}))` で復元 → `flattenDocForCodex` で
     `RenameSourceText[]` 化。
  2. `applyRename`: §5.3 uniform フロー(flush → `applyReplacementsToDoc/String` で各 statement の新 content/値を作り
     drizzle `.toSQL()` → 単一 `agentWriteBundle` → `setLiveContent` 再同期(双方向)→ `loadEntries`/`reloadTreeOrThrow` →
     `globalHistory.push` → `enqueueRescan`)。charCount/placedBeatPreview を statement に同梱。
  3. プレビュー UI(`LinterPanel` 流の行 + per-row checkbox + ambiguous default-off + 警告バナー)。
  4. 改名 commit(`CodexDetailContent.handleNameBlur`)からの起動配線(old≠new かつ occurrences>0 でモーダル)。

  3 つの純粋コア(検出・flatten・置換)は単体テスト済み。残りは DB/editor/store にまたがる I/O 統合で、
  `pnpm electron:dev` での実機検証を要する(top3 落とし穴: schema stub・派生キャッシュ同梱・双方向再同期+flush race)。

- **Item C 統合層 実装完了(実機検証残)**:
  - `codex/rename/renameEngine.ts` — `gatherRenameSources`(全ノード title/synopsis/scene本文 + codex
    summary/content/notes/detailValue(text)/relation.label を収集・PM doc は schema 復元→flatten) /
    `prepareRenamePropagation`(flush→gather→detect) / `applyRenamePropagation`(uniform: drizzle `.toSQL()`→
    単一 `agentWriteBundle`→双方向 `setLiveContent`(sentinel=-1)再同期→`reloadTreeOrThrow`/`loadEntries`→
    `globalHistory.push`→`enqueueRescan`。scene は charCount+placedBeatPreview 同梱)。
  - `codex/rename/renamePropagationStore.ts`(trigger↔modal 連携 Zustand)。
  - `codex/rename/RenamePropagationDialog.tsx`(LinterPanel 流の行 + checkbox + snippet + ambiguous バナー、
    ruby 行は read-only)。`CodexManagementPanel` にマウント。
  - `CodexDetailContent.handleNameBlur` から起動(old≠new で prepare→occurrences>0 ならモーダル)。
  - tsc 0 / eslint 0 / 既存テスト全パス(codex 436 件)。**未検証 = I/O 実機動作**(undo/redo 双方向の
    エディタ再同期、flush race、派生キャッシュ、agentWriteBundle の実 DB 反映)。

  既知の caveat / フォローアップ:
  - 大規模プロジェクトでは改名 commit ごとに全シーン flatten = 一時的に重い(モーダル前の prepare)。
    必要なら FTS で旧名を含むシーンに事前フィルタ。
  - codex content/notes の開きミニエディタ再同期は `setLiveContent(entryId,…)` 前提。購読 id が異なる場合は
    再オープンで反映(loadEntries 済み)。
  - 改名 commit の `enqueueRescan(新名)` が先に走り、apply 後に再度 `enqueueRescan` する二度打ちは許容。

---

## 1. 前提となる現状(調査で確定)

### 1.1 改名 commit パス

`CodexEntryHeader.tsx`(input `onBlur`) → `CodexDetailContent.tsx:handleNameBlur`
→ `codexStore.update(id,{name})` → `api.ts:updateCodexEntry` → `enqueueRescan(id)`。

確定的に波及するもの / しないもの:

- `enqueueRescan(id)` は発火するが**部分再スキャン**。対象は「現在その entry を body mention
  している scene」のみ(`mentionRescanQueue.ts:88-110`)。新名を地の文に新規に書いたシーンは
  既存 mention が無ければ漏れる。逃げ道は全 Rebuild(Matrix/Settings)。設計上既知
  (`docs/Grimodex_Settingsパネル設計書.md`)。
- 焼き込み @mention ノードの `label` 更新処理は**無い** → 改名後も旧名表示(`data-entry-id` は正)。
- 旧名を alias へ自動追加する処理は**無い** → 地の文の旧名はマッチ喪失。
- FTS は trigger で自動追従(`migrate.rs` codex_fts triggers)。

### 1.2 「参照元」の分類

**大半は id 参照で自動追従する**: relations / pins(scene・quick・chat) / detail の
`codex_reference` / AI 文脈注入 / map ノード / crossReference(整合性) / foreshadow / FTS。
**改名でズレるのは name(文字列)保持の箇所のみ**:

| サイト | 保持形式 | 改名で自動追従 | 症状 |
|---|---|---|---|
| 焼き込み @mention `label` | name 焼き込み | ❌ | 旧名トークンが残る(id は正) |
| 地の文プレーンテキスト | ユーザー入力 | ❌ | rescan で body mention 行が剥がれる |
| 他エントリの `summary`(text) | プレーン text | ❌ | 旧名のまま |
| 他エントリの `content`/`notes`(PM JSON) | PM JSON | ❌ | 旧名のまま |
| `codexDetailValues.value`(fieldType=text) | プレーン text | ❌ | 旧名のまま |
| `codexRelations.label` | プレーン text | ❌ | 旧名のまま |

### 1.3 重複(duplicate)ハザードの所在

本番マッチャは Rust Aho-Corasick(`src-tauri/src/codex_matching.rs`)。`name` に unique 制約なし。

1. **同名別エントリ**: overlap 解決で先に挿入された entry だけが勝つ(決定的だがユーザー意図とは無関係)。
2. **部分文字列**: 最長一致で長い方が勝つ(「太郎」⊂「山田太郎」)。
3. **別 entry の alias と一致**: alias も name と同列に pattern 化されるため #1 と同型。

→ **素朴な `String.replaceAll(oldName, newName)` は全部踏む。禁止。**

---

## 2. スコープと製品判断(ユーザー確定)

3 つの作業に分解。ユーザー選択:

- **Item A — @mention label を現在名へ追従**: 採用。id 参照なので重複リスク無し。
- **Item B — export/file-backed 保存の @mention 消失バグ修正**: 併せて修正。
- **Item C — 地の文+他エントリ自由記述の旧名をプレビュー付きで新名へ一括置換**: 採用(最大・高リスク)。

---

## 3. Item B — @mention 消失バグ(前提・独立)

`exportEngine.ts:renderNode`(181-324)に `case "mention"` が無く、mention atom が `default`(321)で
空配列 recurse → `""` に落ちる。file-backed シーンの write-back(`renderPmDocToMarkdown`,
`markdownBridge.ts`)・zip export・publish export で @mention が消失。

**修正**: `renderNode` に `case "mention"` を追加し `@{現在名}`(`data-entry-id`→codex store で解決、
fallback: 焼き込み `label`、最後に id)を出力。archive serializer(`sceneSerializer.ts`)も同様。
DB-backed シーンは write-back を通らないので無傷だが、Item C で本文 doc を触ると file-backed の
disk sync を経由しうるため**Item C の前提**。

---

## 4. Item A — @mention label の live 解決(安全・即効)

`CodexMentionExtension.ts:renderHTML` は静的 HTML を吐く(`node.attrs.label ?? node.attrs.id`)ので、
改名時に再描画されない。**NodeView 化**し `data-entry-id`→`useCodexStore` の現在名を
リアクティブに解決する。fallback: 焼き込み `label` → id(削除済み entry 対策)。
本文 doc は一切変更しない(重複リスク無し)。

---

## 5. Item C — 旧名プレーンテキストの一括置換(本命)

### 5.1 トリガと検出

改名 commit 時(old≠new、旧名長 ≥ 閾値)に:

1. 全 target セットを作り、**対象 entry の name だけ旧名に差し替え**て `matchText` を呼ぶ。
   旧名単独 target にしない(最長一致/overlap が壊れ #2,#3 を誤爆)。返った match を
   **対象 entry の id でフィルタ**。
2. 走査対象:
   - 全シーン本文(`loadScenesFull`、PM JSON)
   - 他エントリの `summary`(plain text)
   - 他エントリの `content`/`notes`(PM JSON)
   - `codexDetailValues.value`(fieldType=`text` のみ。`dropdown`/`codex_reference` は除外)
   - `codexRelations.label`(plain text)
3. plain text フィールドは `matchText(value, …)` の `{from,to}` で `String.slice` 置換(1 次元なので
   offset→PM pos 変換不要)。PM JSON は §5.3 の doc 走査。

### 5.2 プレビュー UI

`lint/LinterPanel.tsx` project-mode の行 UI が最良の流用元(match 一覧+context snippet+per-row 適用)。
snippet ヘルパは `lint/lintIgnoreStore.ts:extractContext` / `LinterPanel.tsx:extractExcerpt` を流用。
モーダル。シーン/エントリでグルーピング、per-row チェックボックス。

**重複の表出**: 旧名を現在共有する別エントリがある場合、その行は**デフォルト off**で表示(警告のみに
留めない)。matcher が曖昧で帰属できない箇所をユーザーに委ねる。

モーダルである間は対象 doc が静止 → 検出時オフセットが適用時も有効(再マッチ不要)。

### 5.3 適用方式 — uniform(確定。hybrid は不可)

調査で確定: **DB 直書きは live editor を再同期しない**(`sceneContentStore` の in-memory チャネルは
`setLiveContent` 経由のみ発火し、`saveSceneContent` の drizzle UPDATE とは完全分離)。かつ
**per-scene の editor instance レジストリが無い**(`editorSaveRegistry` は nodeId→saveFn のみ、
`useEditorStore` は単一 focused)。さらに **1undo 要件**(全 UPDATE を単一 `agentWriteBundle` →
`globalHistoryStore` 1 push)が、native editor transaction(= ProseMirror per-editor history、別スタック)
と正面衝突する。よって hybrid は破綻し、**uniform** に確定。

正準パターン = `tree/aiScaffold/applyPlan.ts`。フロー:
1. **flush**: 開いている対象シーンを `saveScene(nodeId)`(`editorSaveRegistry.ts:18`)で確定。
   ※ debounce cancel を含まないため flush race に注意(§5.6)。
2. **置換計算**: 各 content JSON / codex フィールドをオフセット編集(§5.3a)。
3. **原子適用**: drizzle query builder `.toSQL()` → `toStatement`(`applyPlan.ts:45-50`)で statements[] を組み、
   `agentWriteBundle({projectId, statements, undoJournal, changeEvent})`(`agent-writes/bundle.ts:47`)で
   単一 BEGIN IMMEDIATE tx に。**生 SQL 規約に抵触しない**(query builder 経由)。
4. **display 再同期**: 開きシーン/開き Codex に `setLiveContent(id, jsonObj, sentinel)` を push
   (既存購読が `isApplyingExternalUpdate` 窓内で `setContent(emitUpdate:false)`、`EditorPane.tsx:1291`)。
   sentinel は全 groupIndex の外側の値を使う(`sceneContentStore.ts:117` の self-skip 回避)。
5. **store 再同期**: `treeStore.reloadTreeOrThrow`(`applyPlan.ts:212`)+ `codexStore.loadEntries`
   (`codexStore.ts:149`)。
6. **undo push**: `globalHistoryStore.push({kind:"scenes", label, undo, redo})`(`applyPlan.ts:287`)。
   undo/redo の inverse でも §4/§5 の再同期(setLiveContent + reload)を**両方向**で実行。
7. **後処理**: `enqueueRescan(entryId)`(改名 commit が新名で剥がした body-mention 行を、本文書換後に再確立)。

#### 5.3a schema 再構成と派生キャッシュ(落とし穴)

- **schema 取得**: `getSchema(getEditorExtensions({ setMentionPopup: () => {} }))`。**mention stub 必須** —
  省略すると mention 拡張が外れ(`extensions.ts:202-204`)、本文 `@mention` を含む doc の
  `Node.fromJSON` が "Unknown node type: mention" で **throw する**(severe)。前例:
  `compositeTimelapse.ts:237`, `replayStart.ts:19`。
- **派生キャッシュ同梱**: bundle は通常 save 経路を迂回するため、各 `tree_nodes.content` UPDATE statement に
  `charCount`(`countSceneBodyCharsFromJson` — editor 不要)と `placedBeatPreview`(`derivePlacedPreview`)を
  **明示同梱**(改名で名前長/preview がズレる)。codex 側は apply 後 `codexStore.loadEntries()` で再ロード。

### 5.6 フィールド更新 API と追加スコープ

| フィールド | 更新手段 |
|---|---|
| `codex_entries.summary/content/notes` | drizzle `.toSQL()` で bundle に同梱(個別 API は別 tx=別 undo になるため使わない) |
| `codex_detail_values.value`(fieldType=text のみ) | 同上。fieldType 判別は `definition.fieldType`(`detailApi.ts:40`) |
| `codex_relations.label` | **update API 不在** → raw drizzle UPDATE を bundle に同梱 |

**追加スコープ判断**: 当初スコープは content/summary/content/notes/detailValue(text)/relation.label であったが、
実装時(2026-06-08)に node の **title / synopsis** が scope に追加された(`renameEngine.ts:130-144` で
`node-title`/`node-synopsis` kind として gather し、`:332-343` で `tree_nodes` の title/synopsis カラムを UPDATE)。
**unplacedBeatsDoc** は引き続き対象外。codex の **aliases / tagsCache** も対象外のまま。excerpt は
`LinterPanel.extractExcerpt` / `lintIgnoreStore.extractContext` が
`{range:{start,end}}` を取るので matcher の `{from,to}`(同じ char offset 座標系)を wrap して流用可。

### 5.4 帰属(attribution)

置換は新規生成でなく**既存テキストの一部差し替え**。**既存スパンの authorship を保持**する
(出自を捏造しない)。`tr.replaceWith` 前に置換範囲の authorship mark を読み、置換後に同じ mark を
再適用(`useInlineAiDiff.ts:185-203` パターン)。人間の地の文は human のまま、AI 生成箇所なら ai のまま。
新 source 種別や `manualOverride` は触らない。

### 5.5 offset→PM pos 契約(ブロッキング gate・検証済)

match の `{from,to}` は **`getDocText`/`CodexHighlightPlugin.flatPmPos` のフラット化**に対する
オフセット。書き戻しも**同じフラット化**で逆算する。`lint/offsetMap.ts` は別契約(codeBlock/image を
skip)なので**流用禁止**(サイレント破損)。`CodexHighlightPlugin.ts:34-61` の `flatPmPos` 構築を
共通化して再利用。

**検証済(2026-06-08)**: `getDocText`(`RubyNode.ts:15-32`)/`flatPmPos` は ruby base・text node・
block 境界(`\n`)のみ収集。@mention atom は `isText`/`isBlock`/ruby のいずれでもないため
**フラット化に一切寄与しない** → matcher は mention 内の旧名を拾えず、Item C が mention atom を
破壊することは構造的に不可能。Item A(mention)と Item C(地の文)は完全に別基質。

**ruby 注意**: ruby の base テキストは matcher 対象になり得る(`getDocText:20`)。ruby 内一致は
text node でなく `base` attr の書き換えが必要なので個別扱い(または初版では skip して別行で警告)。

---

## 6. フェーズ計画

- **Phase 0(前提)**: Item B。小・独立。file-backed シーンを Phase 2 で触る前提。
- **Phase 1(安全・即効)**: Item A。NodeView 化。改名直後に @mention が旧名のまま残る主症状を解消。
- **Phase 2(本命)**: Item C。§5.5 gate は検証済。5.1→5.2→5.3 の順で実装。

---

## 7. 最危険箇所(実装時の注意 top3)

1. **2 つの undo 系統の衝突** → §5.3 ハイブリッド(`addToHistory:false`+単一 globalHistory)で解消。
2. **開きシーンへの DB 直書きステール上書き** → 開きシーンは必ずエディタ tr 経由。
3. **offset→PM pos のフラット化契約ミス** → §5.5。`flatPmPos` 共通化、lint の `offsetMap` 流用禁止。

---

## 8. 既存テスト/設計メモ

- 改名/rescan を直接 gate するテストは無い(`codexStore.test.ts` は汎用 CRUD のみ)。同名別エントリの
  勝者も未 gate。
- マッチャ重複・境界テストは充実(`codex_matching.rs` 内、CJK 境界・最長一致・excludedAliases・150k perf)。
- Phase 2 では「同名別エントリ」「部分文字列」「ruby 内一致」「mention atom を触らない」の各ケースを
  新規 gate する。
