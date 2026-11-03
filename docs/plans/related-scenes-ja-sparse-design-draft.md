# 関連場面：日本語の sparse 腕を直す最小の一手（設計草稿）

- 状態：**改訂 2（実装済み）**。改訂 1 は独立レビュー〔判定 (b) 修正してから受入れ可〕の指摘を反映した草稿。2026-11-03 にユーザーが §8.2 の残りを決め、実装した（§9）。本文の §2〜§8 は改訂 1 の記述のまま残し、実装で変えた点は §9 に書く。
- 日付：2026-11-01
- 基点：origin/master `2ad1e536`。製品のコードはこの worktree と `claude-cp4-s5cand`（`86427ee5`）で読んだ。
  両者で `src/features/related-scenes`、`src/features/codex`、`src/lib`、`semanticRecall.ts`、`fts.rs`、
  `evals/nir1-retrieval` に差が無いことを `git diff --stat 86427ee5 2ad1e536` で確かめた。
- 範囲：renderer の関連場面パネルの sparse 用 query の組み立てだけ。Rust の `search_fts`、IPC 契約、
  chat の recall、閾値は変えない。
- 改訂 1 で変えたこと：(1)「語が残らなければ sparse を呼ばない」をやめ、「今の query に戻す」にした（§2.2、§5）。
  L0 の Raw runner が `fts_search` をちょうど 1 回と assert するため。(2) ルビの名前を拾う（§2.2）。
  (3) 1 項目あたりの語数に上限を置いた（§2.2）。(4) CP-4 の harness、取り直し、短い別名、既存の試験の扱いを
  書いた（§2.3、§2.5、§6.2）。(5) 測り直し（§3）と表現の訂正。

## 1. 要点

1. 壊れていること：日本語の関連場面の sparse（FTS5 の bm25）がほぼ働いていない。合成データ（300 場面）で
   上位 10 件の capR@10 は 0.17、P@10 は 0.38（偶然なら 0.25）。tail が段落ごとの長い句になって他の場面に
   一致しない、Rust が 3 字未満の語を捨てる、漢字の名前を seed にしていない、の 3 つが原因。
2. 最小の一手：日本語の分岐だけで、本文で言及された Codex 項目の名前・別名（ルビの名前も含む）と既存の
   カタカナ seed から 3 字以上の語を集め、それを sparse の query にする（tail は入れない）。3 字以上の語が
   1 つも無ければ、今の `buildSparseQuery` の query にそのまま戻す。英語は今と同じ文字列。Rust と閾値は変えない。
3. 期待（合成データの傾向。製品と同じ上位 10 件）：capR@10 0.17→0.31、無関係な過去の場面 2.6→1.4 件。
   P@10 は 0.38→0.67（変種ごとの分母）、共通の 171 query では 0.48→0.89。30 場面のデータでは 0.43→0.55／0.43→0.56。
4. 限界：1〜2 字の名前（蓮・リオ・港町など）と未登録の名前には効かない。上位 10 件の約半分は現在か未来の
   場面のまま。正解は名前の共有から作ったので、名前で探す方式に有利な測り方である。作り物のデータで、
   実際の小説での効果は保証しない。dense と合わせた最終の一覧は測っていない。
5. 確認が要る点：凍結済みの NIR-1 L0 評価が Raw の sparse を `buildSparseQuery(tail, fullBody)` と名指しし、
   日本語の query を 12 件含む。CP-4 の harness も同じ関数を bytes の pin つきで使う。入れる時期と、
   短い別名・取り直しの扱いを決めてもらう（§8.2）。

## 2. 最小の一手の仕様

### 2.1 今の挙動（根拠）

- `buildSparseQuery(tailQuery, body)` は、seed があれば `tail + "\n" + seed`、無ければ tail を返す
  （`src/features/related-scenes/seedTerms.ts:47-50`）。言語の引数は無い。
- seed はカタカナ 2 字以上の連続と、大文字始まりの Latin 語だけ。頻度順で最大 8 件
  （`seedTerms.ts:16-18`、`:24-41`）。漢字の名前は意図的に対象外（`seedTerms.ts:9-11`）。
- tail は本文の末尾 500 字（`src/features/chat/semanticRecall.ts:157-160`）。本文は
  `prosemirrorToText` で段落ごとに `\n` が付く（`src/lib/prosemirror.ts:36-38`）。tail が空なら一覧を
  組む前に終わる（`fetchRelatedScenes.ts:82`、`fetchNir1RelatedScenes.ts:179`）ので、sparse に届く tail は空でない。
- `buildSparseQuery` の呼出しは、製品に 2 か所（`fetchRelatedScenes.ts:86`、`fetchNir1RelatedScenes.ts:201`）、
  評価の harness に 2 か所（`scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts:619` の `productRawR`、
  `cp4-diagnostic-probe.ts:67` の SP-P4）、liveEval に 2 か所（`relatedScenesLive.eval.test.ts:183`、`:300`）。
  harness の 2 か所はどちらも「製品と同じ query」をうたう（`cp4-harness.ts:597`、`:607-608`、`cp4-diagnostic-probe.ts:61`）。
- sparse の取得は `fetchSparseSceneIds`（`semanticRecall.ts:315-328`。`fts_search`、scope は scenes、上限 10）。
- Rust は空白で分け、3 codepoint 未満の語を捨て、残りを `"…" OR "…"` にする
  （`src-tauri/crates/grimodex-db/src/fts.rs:398-404`）。query 全体が 3 字未満か、語が 1 つも
  残らないときは、query 全体での `LIKE '%…%'` に切り替える（`fts.rs:44-45`、`:64-70`）。
  この LIKE には `ORDER BY` が無い。
- 日本語の FTS 表は `tokenize='trigram'`（`src-tauri/crates/grimodex-db/src/migrate.rs:1101-1123`）。
  索引の中身は `tree_nodes.content`（ProseMirror の JSON 文字列）そのもの（`migrate.rs:1183-1186`）。

### 2.2 新しい関数

`seedTerms.ts` に新しい純関数を足し、既存の `buildSparseQuery` は**変えずに残す**（英語、harness、liveEval が使う）。
（実装では新しい file `relatedScenesSparseQuery.ts` に置き、`seedTerms.ts` は 1 byte も変えていない。§9）

```ts
export function buildRelatedScenesSparseQuery(args: {
  tailQuery: string;
  body: string;            // prosemirrorToText の結果（今と同じ値。戻すときに使う）
  docJson: string;         // loadSceneContent の結果（ルビを拾うために使う）
  language: string;        // getCurrentProjectLanguage() の値
  codexTargets: readonly CodexMatchTarget[];
}): string;                // 常に空でない文字列（必ず sparse を 1 回呼ぶ）
```

- **言語の分岐**：`language.startsWith("en")` なら `buildSparseQuery(tailQuery, body)` をそのまま返す
  （英語は今と同じ文字列。`codexTargets` と `docJson` は使わない）。それ以外は日本語の分岐。
  `recallParamsForLang`（`semanticRecall.ts:119`）と同じ述語で、Rust が英語の FTS 表を選ぶ
  `language LIKE 'en%'`（`fts.rs:55-62`）とも述語は同じ形。ただし値の出所が違い（renderer は
  `projectStore.ts:896-907` の fallback の連鎖で既定 `"ja"`、Rust は DB の `projects.language`）、
  SQL の `LIKE` は ASCII の大小を区別せず `startsWith` は区別する。どちらも今の `recallParamsForLang` と同じ性質で、
  この変更で新しく生まれるものではない。en 以外の言語は日本語と同じ扱いになる。
- **日本語の分岐**：
  1. 照合用の本文を作る。`docJson` を歩き、text node の文字と、ルビ（`ruby` の atom）の `attrs.base` を順に連結し、
     段落と見出しの終わりに `\n` を付ける（`prosemirrorToText` と同じ規則に、ルビの base を足したもの）。
     ルビの atom は `text` も `content` も持たない（`src/features/editor/RubyNode.ts:44-57`）ので、
     `prosemirrorToText` では消える（`{type:"ruby",attrs:{base:"長谷部",…}}`＋「は振り返った。」が
     `"は振り返った。\n"` になることを node で実行して確かめた）。editor 側の `flattenDocForCodex`
     （`src/features/editor/codexDocFlatten.ts:3-25`）は同じ考え方（ルビは base を数える、mention の atom は入れない）だが、
     ProseMirror の node を受け取るので、JSON から使うには新しい小さな関数が要る。mention の atom も同じく入れない。
  2. `createCodexMatcher(codexTargets)(照合用の本文)` で言及を取る（`src/features/codex/codexMatcher.ts:62-187`）。
     名前と別名が一致の対象（`:69-80`）、除外の別名で消し（`:132-148`）、境界の規則を当て（`:150-153`）、
     重なりは長い方を残す（`:155-181`）。
  3. 言及された項目を、一致の回数の多い順、同数なら最初の位置が早い順に並べる。
  4. 項目ごとに `[名前, ...別名]` を出す。本文に無い表記（別名）も入れる（他の場面が別の表記で書いていても当たるように）。
     除外の別名は入れない。**1 項目あたり 3 語まで**（名前を先に、別名は登録順）。別名の多い項目 1 つで 8 件の枠が
     埋まらないようにするため。合成データの項目は表記が 2 つ以下なので、この上限は測定値を変えない（データで確かめた）。
  5. 続けて既存の `extractProperNounSeeds` の語（カタカナ・Latin、頻度順）を出す。このとき**上限なしで取る**
     （試作は `extractProperNounSeeds(body, 1_000)`）。既定の `maxTerms=8` のまま呼ぶと、後で落とす 2 字の語が
     先に枠を使い、3 字以上の語が押し出される。入力は照合用の本文（ルビを含む）。
  6. 各語を空白で分け（`src/lib/fts.ts:21-26` の `tokenizeFtsQuery`）、3 codepoint 未満を落とし
     （`src/lib/fts.ts:29-31` の `codepointLength`）、重複を除き、**落とした後で**先頭から 8 件。
  7. 1 件以上残れば空白で連結して返す。**1 件も残らなければ `buildSparseQuery(tailQuery, body)` を返す**（今と同じ query）。
- **3 字未満を renderer で落とす理由**：Rust が MATCH で捨てる語なので、落としても MATCH の結果は変わらない。
  落とさないと、2 字の語だけの query が Rust の LIKE に落ちる（「リオ」1 語なら `LIKE '%リオ%'` で部分一致・順位なし、
  「ミナ 澪」なら空白を含む句の LIKE で 0 件。§3.4 で実行して確かめた）。
- **語が残らないとき今の query に戻す理由**（改訂 1 で変更。旧案は「呼ばない」）：
  - 空の query を Rust に渡すと `LIKE '%%'` になり、全場面が一致して走査順の先頭 10 件が返る（§3.4）。だから空は渡さない。
  - 「呼ばない」は L0 の Raw runner と比較の runner の契約に衝突する。`validateRawIpcTrace` は `db_execute`・
    `semantic_search`・`fts_search` がそれぞれちょうど 1 回であることを assert し
    （`scripts/quality/nir1-retrieval/contract.mjs:285-297`、試験 `contract.test.mjs:78-88`）、Raw の runner は
    落ちた sample を `failed`（tag `ipc-observer`）にする（`scripts/quality/run-nir1-retrieval.mjs:450-465`）。
    hybrid の腕も `fts_search` 1 回を要求する（`scripts/quality/nir1-retrieval/paired.mjs:169-180`）。
    これらは品質資産に載っている（`evals/quality-manifest.yaml:718-724`）。
  - 戻せば `fts_search` は必ず 1 回で、L0 の日本語の 12 query のうち 10 件は query の文字列まで今と同じになる（§5.2）。
  - 失うのは、語が残らない場面（合成データの 5〜7%）で tail のノイズを減らす効果だけ（§3.2）。
- 同じ理由で、Codex の取り方は IPC も DB 読みも増やさない案にする（§2.3）。DB を読む案は `db_execute` の 1 回の
  assert にも触れる。
- chat の recall は `fetchSemanticRecall` が message＋tail をそのまま渡す（`semanticRecall.ts:379-391`）。
  ここは変えない。dev の search eval（`src/features/semantic-search/searchEval.ts:244-251`）も変えない。

### 2.3 Codex の登録名の取り方、取り直し、harness

候補は 3 つあり、読んだ結果から 1 を推奨する。

| 案 | 中身 | 同期か | 根拠と懸念 |
| --- | --- | --- | --- |
| 1（推奨） | `useCodexStore.getState().completionTargets` ＋ JS の `createCodexMatcher` | 同期。IPC も DB 読みも無い | `completionTargets` は検索・絞り込みに関係なくプロジェクト全体の軽い行（`src/features/codex/codexStore.ts:151-157`。`type` も持つ）。開封時の任意の hydrate `codex-load` で読む（`src/application/project/defaultProjectLifecycle.ts:171-175`、`codexStore.ts:366-373`）。切替えで空に戻す（`codexStore.ts:1030-1036`）。lint も同じ値を使っている（`src/features/lint/codexLintInputCache.ts:56-60`） |
| 2 | `listCodexMatchTargets` ＋ `findMentionedEntriesAsync`（Electron では Rust の matcher） | 非同期（DB 読み＋IPC） | 保存の言及と同じ matcher（`src/features/codex/rustMatcher.ts:131-154`）。共有の状態を持つ（`rustMatcher.ts:33-74`）。IPC が増え、L0 runner の IPC の assert（§2.2）に触れる |
| 3 | `scene_codex_mentions` を読む（`nir1GraphSeedCandidates.ts:78-103` と同じ読み方） | 非同期（DB 読み） | 保存の後の scan（`src/features/editor/persistSceneBody.ts:214-240`）が予約で走るので遅れることがある。DB 読みが増え、`db_execute` の 1 回の assert に触れる |

案 1 の懸念と扱い：

- hydrate が終わる前、または失敗したときは空で、Codex 由来の語が無くなる（カタカナの seed だけ、それも無ければ今の query）。
  1 回ごとの比較では今より悪くはならない。
- **取り直しの契機（判断）**：一覧の取り直しの依存は `enabled, sceneId, nodes, mode, projectId, workspace,
  openRevision, listening, refresh, dropCarried`（`src/features/related-scenes/useNir1RelatedScenes.ts:369-380`）で、
  `completionTargets` は入っていない。`isCurrent()`（`fetchNir1RelatedScenes.ts:98-109`）も Codex を見ない。
  このため、開封直後に hydrate より先に一覧が組まれると、Codex 由来の語が無い Raw が場面を切り替えるまで残る。
  Codex を編集しても一覧は変わらない。同じ保存済みの本文から、Codex の状態によって違う Raw R が出る
  （Native の query binding は tail だけを束ねる。`fetchNir1RelatedScenes.ts:237-245`）。
  この草稿の案は**取り直さない**（依存を変えない）。依存を増やすと、Codex の編集のたびに Raw＋IR の query と session を
  作り直すことになり、NIR-1 の lifecycle の変更になるため。代わりに、Raw-ready の timing を hydrate の前後で分けて測る。
  取り直すかどうか、Raw R の入力が binding の外に増えることを受け入れるかは、確認が要る（§8.2 の (d)）。
- 保存された言及（`scene_codex_mentions`）は Electron では Rust の matcher で作る
  （`src/features/editor/beat/bodyMentionApi.ts:21-33` → `rustMatcher.ts:131-154`）。JS の matcher は同じ規則を
  移したもの（`src/features/codex/charClassBoundary.ts:24-65` と `src-tauri/crates/grimodex-core/src/codex_matching.rs:55-160`）
  だが、長さの数え方が違う（JS は UTF-16、Rust は char）。BMP の外の漢字で結果が分かれうる（未検証）。
  保存の scan の平文化（`extractPlainText`。text node の間に空白を入れ、ルビを持たない。
  `src/features/codex/prosemirrorTextExtractor.ts:22-36`）とも違う。
- 所要時間の目安：項目 500 件（1 割の項目に除外の別名あり）、本文 1 万字の合成で、matcher の構築と照合が
  1 回あたり 1.2 ms（node、20 回の平均、`bench_matcher.mjs`）。除外の別名の照合は、生の一致ごとに本文全体へ
  正規表現を走らせる（`codexMatcher.ts:133-148`）ので、除外の多い項目が多く一致すると、この見積もりを超えうる。
  hybrid の経路ではこの計算が `beginRelatedScenes` の前（`fetchNir1RelatedScenes.ts:199-201` は `:237` より前）に入る。
  IR 待ちの上限 D は 10.84 ms（`src/features/related-scenes/relatedScenesConfig.ts:6-7`）。実装で Raw-ready の増分を測り、
  必要なら `completionTargets` の参照ごとに matcher を使い回すか、begin を出してから組み立てる（測ってから決める）。
- related-scenes の 2 つの fetch は今は `codexStore` を import していない（grep で確認）。editor の hook は既に
  import しているので起動時の graph の増分は小さい見込み（レビューの指摘。測ってはいない）。`seedTerms.ts` は純関数の
  ままにし、store は呼出し元で読む。
- **CP-4 の harness（判断と確認）**：harness の 2 か所（§2.1）は `buildSparseQuery` を直接呼び続ける。
  英語では新しい関数が `buildSparseQuery` と同じ文字列を返すので、英語の G-case（すべて `language: "en"`）では
  「製品と同じ」は保たれる。日本語では崩れる。harness の file は CP-4 の観測準備で bytes の pin の対象で
  （`evals/nir1-graph/observation-prep.v1.json:507`、`:997-1001`、`:1363`）、品質資産でもある
  （`evals/quality-manifest.yaml:1696`、`:1731`）。測定中に触ると pin が崩れる。この草稿の案は、製品と同時には揃えず、
  CP-4 が終わってから新しい関数に揃える（または日本語の G-case を作る前に揃える）。どちらにするかは確認が要る（§8.2 の (b)）。

### 2.4 どの種類の Codex を使うか

- 選択肢（推奨なし）：**全種類**（組込みは character／location／item／lore。`src/features/codex/api.ts:90-95`。
  ユーザーが足した種類も含む）か、**人物と場所だけ**（`CodexMatchRow.type` で絞れる。`codexMatchTargets.ts:15-19`）。
- 合成データには人物と地名しか無いので、両案の差は測れていない。item・lore の名前がよくある名詞（例：魔法）だと、
  短い別名の誤言及（§2.5）と普通名詞の枠の消費が強まる。改訂前は全種類を推奨したが、レビューの指摘を受けて推奨を外した。

### 2.5 誤りの扱い

- 1 字の漢字の名前：境界の規則で、漢字に挟まれた 1 字は一致しない（`charClassBoundary.ts:38-47`、`:52-61`）。
  合成データでは「睡蓮」の蓮、「澪標」の澪は誤言及の集計に出なかった。「悠々」の悠は誤言及になった。
  「々」（U+3005）は漢字の範囲 0x4E00〜0x9FFF の外で "other" になり（`charClassBoundary.ts:13`）、
  右の境界の検査を通るため。ただし 1 字の名前は 3 字未満で query から落ちるので、query は変わらない。
- **短い別名の誤言及**：matcher は名前と別名を長さに関係なく全部パターンにし（`codexMatcher.ts:69-80`）、
  漢字 2 字以上のパターンは漢字と隣り合っていても境界の検査を通る（`charClassBoundary.ts:45`、`:59`）。
  手順 4 は言及された項目の正式名も出すので、2 字の別名がよくある語だと、その語のたびに長い正式名が query に入る。
  名前「山田大地」・別名「大地」の項目で、「大地が揺れた」「北の大地に立つ」がどちらも 1 件の言及になることを
  node で実行して確かめた。合成データの衝突は意図して入れた「千尋の谷」1 種だけ（`gen.py` の `COLLISION`）で、
  実際の小説での率は測れていない。選択肢：
  - (i) 今のとおり数える（除外の別名を登録すれば消える〔`codexMatcher.ts:132-148`〕が、登録が前提）。
  - (ii) 一致した表記が 3 字以上の言及だけを数える（短い別名だけの言及を捨てる。「千尋」→「藤原千尋」の展開も無くなる）。
  - (iii) 項目ごとの語数の上限（手順 4 で 3 語に置いた。誤言及そのものは減らさない）。
  (i) と (ii) は両方測った（§3.2）。どちらにするかは確認が要る（§8.2 の (c)）。この草稿は (i) を基準の仕様として書いている。
- 除外の別名は「現在の場面がその項目に言及しているか」の判定にしか効かない。他の場面の側では、
  名前の文字列を含めば当たる（query は `"…"` の句で、否定を書けない。`fts.rs:398-404`）。
- **Latin の語と JSON の索引**：索引は JSON の文字列そのものなので、`type`・`text`・`content`・`paragraph`・
  `marks`・`attrs`・`annotation` などのキーの部分文字列になる 3 字以上の Latin の seed や Codex 名（例：「Ann」「Ten」）は、
  キーに当たって多くの場面に一致する（Python の SQLite 3.54.0 の trigram で `"Ten"`・`"Typ"` が `{"type":"text","content":1}` に一致することを確かめた。製品の SQLite の版では確かめていない）。今もある問題だが、tail が無くなる分、
  これらの語の比重が上がる。この一手では扱わない（§8.1）。

## 3. 効果の測り直し

### 3.1 方法

- データ：調査で作った合成の日本語場面 v2-300（300 場面、query 290）と v2-30（30 場面、query 20）。
  生成は `gen.py`（結果を見て調整しない、と冒頭に記録がある）。実体は 13 個（人物 11、地名 2）。ルビと mark は無い。
- query：`queries2.mjs`（初版）と `queries3.mjs`（改訂 1。(ii) の変種を足しただけ）が、製品の `seedTerms.ts`・
  `prosemirror.ts` と、製品の `codexMatcher.ts`・`charClassBoundary.ts` の写し（`vendor/`。import の拡張子の 1 行だけが
  違い、中身は同じ）を import して、§2.2 の日本語の分岐を試作する。仕様は測る前にファイル冒頭に記録した。
  試作は空白の分割に Rust の `char::is_whitespace` と同じ集合を使った。実装案の `tokenizeFtsQuery`（JS の `\s`）とは
  U+0085 と U+FEFF で違う（§8.1）。合成データの名前に空白は無いので、結果は同じ。試作に 1 項目 3 語の上限は無いが、
  データの項目は表記が 2 つ以下なので結果は同じ。ルビの扱いも、データにルビが無いので結果は同じ。
- 検索：`ftsport.py`（`fts.rs` の `search_fts` の scenes 部分と `to_fts_match`、`migrate.rs` の表と trigger の移植）に
  上限 10 で渡す（`SEMANTIC_RECALL_SPARSE_LIMIT`、`semanticRecall.ts:105`）。集計は `eval2.py`（初版）と
  `eval3.py`（改訂 1）。既存の `eval.py` を再実行し、調査時の出力と一致することを確かめた。
- 正解：過去の場面のうち、現在の場面と実体を共有するもの（R）。
  - capR@10＝上位 10 件の中の正解の過去の場面の数 ÷ min(|R|, 10)
  - P@10＝上位 10 件の中の過去の場面のうち正解の割合。上位に過去の場面が 1 件も無い query は分母から除く
    （`eval2.py`・`eval3.py` の集計）。呼ばない query が多い変種ほど分母が小さくなるので、改訂 1 では各変種の
    分母 n と、比べる全変種で過去の場面が 1 件以上ある共通の query での値を併記する。
  - noise＝上位 10 件の中の、正解でない過去の場面の数（呼ばない query は 0 として平均に入る）
  - 種類別（K1＝1 字漢字、K2＝2 字漢字〔別名つき 1 人を含む〕、C2＝2 字カタカナ、C3＝3 字カタカナ、
    K3＝3 字以上の漢字、PL＝地名）は実体ごとの capR@10
- **測り方の循環**：正解の「実体の共有」は、`gen.py` が名前の表記として本文に書いたものから作っている。提案はその名前の
  表記を query に入れる。名前で探す方式が名前の共有を正解とするデータで伸びるのは作りの上で当然で、意味で付けた
  等級（L0 の等級、`evals/nir1-retrieval/manifest.json:105` の `relevanceGrades`）とは違う。「名前の一致を探す腕が、名前の一致を正解とする
  データで伸びた」以上のことは言えない。
- 主指標は「過去に絞らない上位 10 件」。renderer だけの変更では過去に絞れないため。
- 測ったのは **sparse 腕の上位 10 件だけ**。dense と合わせた最終の一覧（§4）は測っていない。
- 変種は測る前に決めた。改訂 1 の 2 変種（「今の query に戻す」と (ii)）は、レビューの指摘を受けて、初版の結果を
  見た後に足した。どちらもレビューが名指しした案で、値を見て仕様を選び直したものではない。

### 3.2 結果（生の値、過去に絞らない上位 10 件）

v2-300（query 290）：

| 変種 | 呼ばない | 今の query に戻す | 過去 0 件 | 過去でない枠 | capR@10 | P@10（n） | noise | K1 | K2 | C2 | C3 | K3 | PL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 現状（tail＋seed） | 0.00 | 0.00 | 0.11 | 5.2 | 0.17 | 0.38（258） | 2.6 | 0.05 | 0.05 | 0.06 | 0.36 | 0.07 | 0.05 |
| 初版の提案（語が無ければ呼ばない） | 0.06 | 0.00 | 0.12 | 5.1 | 0.31 | 0.69（256） | 1.3 | 0.05 | 0.19 | 0.06 | 0.39 | 0.38 | 0.21 |
| **改訂 1 の提案（語が無ければ今の query）** | 0.00 | 0.06 | 0.08 | 5.3 | **0.31** | **0.67（267）** | **1.4** | 0.06 | 0.19 | 0.06 | 0.39 | 0.38 | 0.21 |
| (ii) 3 字以上の一致だけ数える＋今の query に戻す | 0.00 | 0.07 | 0.07 | 5.2 | 0.31 | 0.66（269） | 1.6 | 0.06 | 0.13 | 0.06 | 0.40 | 0.41 | 0.22 |
| 参考：Codex の名前だけ・呼ばない | 0.31 | 0.00 | 0.36 | 3.8 | 0.30 | 0.96（186） | 0.1 | 0.01 | 0.20 | 0.02 | 0.42 | 0.40 | 0.24 |

共通の分母（5 変種すべてで上位に過去の場面がある 171 query）の P@10：現状 0.48、初版 0.89、改訂 1 0.89、(ii) 0.87、Codex だけ 0.96。

初版で測った他の変種（`eval2.py`）：2 字を残す 0.34／0.70／1.4、3 字未満を落とし空の query をそのまま渡す 0.32／0.67／1.7
（capR@10／P@10／noise）。

v2-30（query 20。件数が少ない）：

| 変種 | 呼ばない | 今の query に戻す | 過去 0 件 | capR@10 | P@10（n） | noise | K1 | K2 | C2 | C3 | K3 | PL |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 現状（tail＋seed） | 0.00 | 0.00 | 0.00 | 0.43 | 0.43（20） | 3.1 | 0.31 | 0.35 | 0.39 | 1.00 | 0.35 | 0.40 |
| 初版の提案 | 0.05 | 0.00 | 0.05 | 0.55 | 0.59（19） | 2.0 | 0.29 | 0.40 | 0.21 | 1.00 | 1.00 | 0.40 |
| **改訂 1 の提案** | 0.00 | 0.05 | 0.00 | **0.55** | **0.56（20）** | 2.4 | 0.29 | 0.40 | 0.21 | 1.00 | 1.00 | 0.40 |
| (ii) | 0.00 | 0.05 | 0.00 | 0.53 | 0.57（20） | 2.4 | 0.29 | 0.32 | 0.21 | 1.00 | 1.00 | 0.40 |
| 参考：Codex の名前だけ | 0.20 | 0.00 | 0.25 | 0.46 | 0.97（15） | 0.1 | 0.03 | 0.36 | 0.05 | 1.00 | 1.00 | 0.40 |

共通の分母（15 query）の P@10：現状 0.52、初版 0.69、改訂 1 0.69、(ii) 0.70、Codex だけ 0.97。

参考（renderer だけではできない「過去に絞った場合」、v2-300、`eval2.py`）：初版の提案は capR@10 0.62／P@10 0.70。
調査時の F4+F1+F2（2 字の LIKE と過去限定を含む）は 0.88／0.85、現状は 0.37／0.42。ただし 0.88／0.85 は
`eval.py` の `idf_rank`（`eval.py:34-42`。語ごとの命中に idf を足す offline の近似で、`search_fts` を通していない）の値で、
0.62／0.70 は `search_fts` の移植に 50 件で渡して過去に絞った値。別の近似どうしの参考の比較として読む。

### 3.3 解釈（値とは分けて読む）

- 改善は 3 字以上の名前に集中した（K3 0.07→0.38、PL 0.05→0.21、K2 0.05→0.19）。K2 と PL の伸びは「藤原千尋」と
  「渡し場」の分で、2 字の「千尋」「朱音」「港町」は落ちている。1〜2 字の K1・C2 は偶然並みのまま。この合成データの
  13 実体のうち、3 字以上の表記を 1 つでも持つのは 6 実体（藤原千尋・ブレン・アリア・柊一郎・長谷部・渡し場）、
  持たないのは 7 実体（蓮・澪・悠・朱音・リオ・ミナ・港町）。実際の小説での名前の長さの分布は主張しない。
- 初版と改訂 1 の差は、語が残らない 16 場面（5.5%）の扱いだけ。改訂 1 では tail のノイズがその分戻る
  （noise 1.3→1.4、P@10 0.69→0.67）。共通の分母では同じ 0.89。
- (ii) は「千尋の谷」の誤言及を消す代わりに、「千尋」だけで書かれた正しい言及も捨てるので K2 が 0.19→0.13 に下がる。
  このデータの衝突は意図して入れた 1 種だけなので、(i) と (ii) の優劣はこの値では決められない。
- 上位 10 件のうち約 5 件は現在の場面か未来の場面（「過去でない枠」5.2〜5.3）。過去に限ると上がるので、
  過去限定（§7）が次に効く。
- 「2 字を残す」が少し良く見えるのは、2 字の語だけの 9 場面で Rust が LIKE に落ち、走査順の先頭 10 件を返し、
  このデータでは走査順が読書順と同じで過去の場面に偏るため。作り物の性質と読む。
- カタカナの seed は「ランプ」（193 場面）や「コート」（83 場面）のような普通名詞も拾う。Codex の名前だけにすると
  P@10 は 0.96 だが 31% の場面で語が無くなる。埋め草の文がこれらの語を含むためで、比率は作り物。既存の seed は残す
  （ユーザーの指示の「seed に足す」に沿う）。

### 3.4 Codex の言及の誤りと、短い query の Rust での扱い（実行結果）

- 誤言及（JS matcher、本文は `prosemirrorToText`）：悠 6 場面、藤原千尋 13 場面。取りこぼしは 0
  （合成データはすべての表記を登録しているため）。誤言及のある query は 290 件中 18 件。
  誤言及が提案の query に入れた 3 字以上の語は「藤原千尋」の 13 場面だけ。
- 提案の語（全 300 場面）：語が残るのが 284 場面、残らない（今の query に戻す）のが 16 場面。(ii) では残らないのが 20 場面。
  (ii) で query が (i) と変わるのは 37 場面。
- 2 字を残す場合：MATCH 284、query 全体が 3 字未満で LIKE が 9、3 字以上の語が無く空白入りの句の LIKE が 7。
- Rust の移植の挙動：空の query → `scene-000`〜`scene-009`。`"ミナ 澪"` → 0 件。`"リオ"` → 部分一致の 10 件（走査順）。

### 3.5 この測定で言えないこと

- 作り物のデータで、文の型・名前の分布・登録の率は実際の小説と違う。正解が名前の共有から作られている（§3.1）。
  傾向であって、効果の保証ではない。
- dense の点数が無いので、最終の一覧（救済・RRF・先頭の固定の後）の変化は分からない。
- 合成データにはルビも mark も無い。現在の場面の側のルビは §2.2 で拾うが、索引の側（JSON の文字列）で名前が
  途切れる場合は残る。`AuthorshipMark` は `inclusive: true`（`src/features/attribution/AuthorshipMark.ts:26-33`）で、
  human と ai の境界で text node を分けうる。名前の途中で分かれると FTS は一致しない。頻度は測っていない。

## 4. 採用のロジックへの影響

`selectRelatedPastScenesWithAnchor`（`src/features/related-scenes/selectRelatedScenes.ts:111-227`）で、sparse は次の 3 か所に効く。

1. **救済**：sparse の上位 10 件にいて、cosine が床−0.05 以上の場面を入れる（`:178`）。日本語の床は
   gate 0.85 なので 0.80 以上（`fetchRelatedScenes.ts:123`、`semanticRecall.ts:54`、`:97`）。
   今は tail の断片の偶然の一致（合成データで平均 2.6 件の無関係な過去の場面）がこの救済に入りうる。
   提案では無関係が減り（1.4 件）、名前を共有する場面が増える。
2. **RRF**：sparse の順位が `1/(60+rank)` で足される（`:186`）。sparse の順位は上位 10 件の位置で、
   現在の場面や未来の場面も位置を取る（`:162-166`）。
3. **先頭の固定**：dense の最大 cosine が床以上なら、その場面を先頭に置く（`:210-219`）。sparse は 2 位以下を動かす。

前提として、sparse は dense の pool（上位 30 チャンク）にいる場面にしか効かない（`:42-43`、`:131-152`）。

改訂 1 では sparse は必ず呼ばれる。なお、製品の呼出しは両方とも `relativeRescue` を渡す（`fetchRelatedScenes.ts:129`、
`fetchNir1RelatedScenes.ts:197`）ので、sparse が空でも `fused` は真のまま（`selectRelatedScenes.ts:193`）で、
RRF は dense の順位だけになり、並びは cosine 順と同じになる。

**閾値**：gate 0.85、救済の幅 0.05、SPARSE_LIMIT 10、相対救済の幅 0.05 は変えない。gate は 2026-06-14 の較正に基づき
（`docs/Grimodex_セマンティック検索の閾値とモデル特性.md:4`、`:86`）、hybrid は 06-17 に入った（同 `:133`）。救済の幅と
SPARSE_LIMIT は同じ文書で暫定とされ、実プロジェクトでの効果は未検証とされている（同 `:158-159`）。日本語の hybrid の効果は
liveEval の近似（下記）で測られている。sparse が働くようになると、救済の幅 0.05 が日本語で適切かが初めて問われる。

**再検証の計画（この一手の後。値は変えずに測るだけ）**：

1. 本番と同じ経路で日本語を測る評価が要る。liveEval は「FTS5 がこの環境で動かない」として trigram の重なりで近似している
   （`src/features/related-scenes/liveEval/relatedScenesLive.eval.test.ts:15-16`、`:61-90`）。調査の実行では、本番と同じ経路だと
   ja の 4 case の sparse はすべて空、近似では 6〜7 場面が並んだ。近似を使う限り、日本語の hybrid の数値は本番の挙動を表さない。
2. 実際の FTS5 と埋め込みで Raw を回す runner は既にある（`evals/nir1-retrieval/README.md:22-36`、`:47-54`）。ただし Codex を
   作らず、corpus は NIR-1 の凍結物なので、関連場面の改善の評価に流用するには別の corpus と別の記録が要る（§5）。
3. 日本語の小さな corpus（Codex の登録とルビを含む。実際の小説の抜粋か合成。正解は名前の共有ではなく意味で付ける）を
   新しく作り、期待値を測る前に固定し、本番の経路（実 FTS5、ruri）で「現状」と「提案」を比べる。gate・救済の幅の見直しは
   その結果を見て別に提案し、ユーザーの確認を取る（閾値の変更なので）。

## 5. NIR-1 との関係

### 5.1 読んだこと

- `docs/plans/nir1-related-scenes-precheck.md:189-193` の節「Final scene ranking contract v1」は、「既存の Raw の選び方を
  そのまま走らせて R とする。この slice では Raw の基準を再調整しない」と書く。NIR-1 の slice の約束で、Raw を永久に変えない
  規則ではないと読む。ただし NIR-1 は R を「既存の Raw」と定義し、評価をそれに対して行う。
- L0 の manifest は Raw の sparse を `Native ftsSearch(project, buildSparseQuery(tail, fullBody), scenes, 10); no trigram surrogate`
  と書く（`evals/nir1-retrieval/manifest.json:47`）。manifest と corpus は SHA-256 で凍結済み（`evals/nir1-retrieval/freeze.json`、2026-09-08）。
- corpus は日本語 22 場面・12 query と英語 22 場面・12 query（`corpus.json:5`、`:1118`、`manifest.json:99`）。受入れの条件は、
  言語ごとの群を含めて Recall と nDCG が Raw より下がらないこと（`manifest.json:110`）。`recovery-workload.json` も日本語（診断用）。
- L0 の runner は Raw の各 sample で `db_execute`・`semantic_search`・`fts_search` がちょうど 1 回であることを確かめ、違えば
  sample を失敗にする（§2.2 の根拠）。
- Graph の評価（`evals/nir1-graph/g02`〜`g08`、`evals/nir1-g01/fixture.v1.json`）と trace の fixture（G-02 を使う）はすべて
  `language: "en"`。英語の分岐を変えないので値は変わらない。ただし CP-4 の harness は `buildSparseQuery` を bytes の pin つきで
  使う（§2.3）。
- ranking の policy（`policies/narrative/nir1-related-scenes-ranking.json`、版 `nir1-related-scenes-ranking/2`）は IR の床と融合だけを持ち、
  Raw の値を持たない。`ranking-candidate-v2.json` は `fixedRawBudgetUnchanged: true`。
- IR の待ちの上限 D＝0.20×B（B は Raw だけの warm p95）を L0 で固定した
  （`docs/plans/narrative-ir-nir1-implementation-plan.md:408`、`relatedScenesConfig.ts:6-7`）。
- CP-4 の状態は込み入っている（続行計画の `docs/plans/nir1-continuation-2026-10.md:661`、`:761`、`:788` には、取り直し、
  可用性の HOLD、未凍結の手順などの論点が並ぶ）。ここでは状態を断定せず、§8.2 の時期の判断材料としてだけ引く。

### 5.2 NIR-1 の日本語 corpus での見積もり（sparse 腕だけ）

`ftsport.py` に L0 の日本語 corpus（22 場面＋現在の場面。各本文を 1 段落とした近似）を入れ、今と改訂 1 の sparse を比べた
（`nir1ja.mjs`、`nir1ja2.py`）。

- corpus に Codex は無い（`corpus.json` に "codex" の文字列が 0）。改訂 1 の語はカタカナ 3 字以上だけで、12 query 中 10 件は
  語が残らず今の query に戻る。**10 件は query の文字列が今と同一**、ja-09 は「リズム」、ja-12 は「ページ」に変わる。
- 12 件とも `fts_search` は 1 回で、返る場面の並びも今と同じだった（ja-09 は現在の場面だけ、ja-12 は現在の場面と
  `ja-raw-non-event`）。
- 現在の場面は pool から外れるので、**この近似では Raw の顔ぶれ・並び・点数は変わらない見込み**。IPC の回数も変わらない。
- 確かめていないこと：実際の runner は本文を正規の writer で保存し、IR の準備で Chronicle を走らせる。その過程で Codex の項目が
  できるか、評価の renderer で `completionTargets` が読み込まれるか、本文の JSON がこの近似と同じかは確かめていない。
  matcher の計算の分だけ Raw の所要時間（B の元）は増えうる。

### 5.3 判断

**ユーザーの確認が要る**、と判断する。理由：

1. 凍結した L0 の manifest が Raw の sparse の経路を `buildSparseQuery(tail, fullBody)` と名指しし、日本語の群を受入れに含む。
   改訂 1 では近似の上で 10/12 の query の文字列と 12/12 の結果が今と同じだが、ja-09・ja-12 の query の文字列は変わり、
   経路の記述と製品は食い違う。実測はしていない。
2. CP-4 の harness は `buildSparseQuery` を bytes の pin つきで使う。英語では値が同じでも、製品と harness の関係は変わる。
3. この変更は NIR-1 の残レーンの外の製品の変更で、AGENTS の事前委任（NIR-1 の残レーンだけ）の外にある。閾値は変えないが、
   日本語の Raw の顔ぶれを変える。

凍結物（manifest、corpus、freeze、policy、receipt）は変えない。必要なら、Raw の経路の変更を別の記録（候補の宣言と Raw だけの
再測定）として足す。

## 6. 試験

### 6.1 renderer の単体試験（`src/features/related-scenes/seedTerms.test.ts` の流儀。vitest、純関数）

| 試験 | 期待 |
| --- | --- |
| ja：tail を入れない（語があるとき） | 返り値に tail の文が含まれない |
| ja：3 字以上の Codex 名（例：長谷部、アリア）が本文にある | その名前が入る |
| ja：ルビの名前（`ruby` の base が「長谷部」） | 「長谷部」が入る |
| ja：2 字のカタカナ名（リオ）、2 字の漢字名（朱音） | 入らない（3 字未満） |
| ja：別名で言及（本文に「千尋」、名前は「藤原千尋」） | 「藤原千尋」が入る。「千尋」は入らない |
| ja：除外の別名（本文に「千尋の谷」だけ、除外に「千尋の谷」） | 「藤原千尋」が入らない |
| ja：短い別名の言及（名前「山田大地」、別名「大地」、本文「大地が揺れた」） | (i) なら「山田大地」が入る（(ii) を採るなら入らない。採った方を固定する） |
| ja：境界（本文に「アリアナ」、名前は「アリア」） | 「アリア」は Codex 由来で入らない（カタカナの seed として「アリアナ」は入る） |
| ja：並びと重複 | Codex 由来が回数順で先、カタカナが後。Codex 名と同じカタカナ語は 1 回だけ |
| ja：1 項目の上限（別名 10 個の項目） | その項目から 3 語まで。ほかの項目の名前が残る |
| ja：全体の上限 | 9 語以上の候補から 8 語。2 字のカタカナ seed が多くても枠を使わず、3 字以上の語が 8 語まで残る |
| ja：空白を含む名前（「山田 太郎」、全角空白も） | 分けた結果がどちらも 2 字なので入らない |
| ja：Codex 0 件 | カタカナの seed だけ |
| ja：3 字以上の語が無い本文（ひらがなと 2 字以下だけ） | `buildSparseQuery(tail, body)` と同じ文字列 |
| en：英語の分岐 | Codex・ルビがあってもなくても、`buildSparseQuery(tail, body)` と同じ文字列 |
| 言語 | `"en"`・`"en-US"` は英語の分岐。`"ja"`・`"zh"`・`""` は日本語の分岐（今の挙動として固定する。`"EN-US"` は `startsWith` が大小を区別するので日本語の分岐になる。これも今の `recallParamsForLang` と同じ） |

### 6.2 呼出し元の試験（`fetchRelatedScenes.test.ts`、`fetchRelatedScenes.nir1.test.ts` の流儀。invoke を mock）

- ja で語があるとき、組み立てた文字列がそのまま `fts_search` の `query` に渡る（両方の経路）。
- ja で語が無いとき、今と同じ query で `fts_search` が 1 回呼ばれる。
- en のとき、渡る `query` が今と同じ。
- chat の recall（`semanticRecall` の試験）の `fts_search` の `query` が変わらない。
- **既存の試験への影響**：`fetchRelatedScenes.nir1.test.ts` は `language: "ja"`（`:34`、`:147`）で本文が「保存された本文」
  （`:165`）。3 字以上の語が無いので今の query に戻り、sparse は今どおり呼ばれる。sparse の保留中の順序を確かめる試験
  （`:365-385`、`tRawReadyMs` 200 を期待）は前提を保つ。`fetchRelatedScenes.test.ts` も ja で本文が「本文テキスト本文テキスト」
  （`:10`、`:19`）。「テキスト」が 3 字以上のカタカナ seed として残るので query の文字列は変わるが、sparse は mock
  （`:29-32`）で、query を assert していないので試験は今の意味のまま通る見込み（実行していない）。初版の「呼ばない」案では
  前者の試験の前提が崩れていた（レビューの指摘。改訂 1 で解消）。
- 試験では `useCodexStore` の `completionTargets` を空と非空の両方にする。

### 6.3 変異で落ちることの確認（実装時に手で当てる）

- 3 字未満の除外を外す → 「2 字の名前は入らない」が落ちる。
- tail を戻す → 「tail を入れない」が落ちる。
- 語が無いときに空の query を返す → 「3 字以上の語が無い本文」と呼出し元の試験が落ちる。
- ルビを無視する → ルビの試験が落ちる。
- 除外の別名を無視する → 除外の試験が落ちる。
- 言語の条件を逆にする → en の同一性の試験が落ちる。
- 全体の上限を 9、1 項目の上限を外す → 上限の試験が落ちる。

### 6.4 実 FTS での試験（Rust の意味は変えず、今の挙動を固定するだけ）

置き場所は `src-tauri/crates/grimodex-db/src/fts.rs:447` の `mod tests`（`Database::new(":memory:")` と `search_fts` を使う既存の書き方。
例は `fts.rs:484` と `:530` の試験）。日本語のプロジェクトで次を固定する。

- 空の query の scenes は `LIKE '%%'` で場面を返す（renderer が空を渡さない理由の固定）。
- 「長谷部 ランプ」のような 3 字以上の語の OR で、その語を含む場面が返る。
- ルビの base（JSON の `"base":"長谷部"`）を含む場面が「長谷部」で返る。
- 2 字の語だけ（「ミナ 澪」）は 0 件。

## 7. 次の一手（この設計の外）

| 案 | 中身 | 確認が要るか |
| --- | --- | --- |
| F1（2 字の LIKE） | 2 字の語を ESCAPE なしの LIKE で FTS 表に当てる | 要る。`search_fts` は chat history・chat recall・agent tool・profileEgress が共用するので、場面専用の新しい経路（IPC 契約の追加）になる。renderer だけで 2 字ごとに `fts_search` を呼ぶ手は、順位が無く、IPC の回数の assert（§2.2）にも触れるので推奨しない |
| 過去限定 | 読書順で過去の場面だけを sparse の上位 10 件にする | 要る。読書順は renderer の `computeSceneTimeIndex` が決めるので、Rust に渡す新しい経路（IPC 契約の追加）が要る |
| F3（言及の共通） | `scene_codex_mentions` で、現在の場面と同じ項目に言及する場面を引く | 要る（Raw の顔ぶれが大きく変わる）。renderer は Drizzle でこの表を既に読んでいる（`nir1GraphSeedCandidates.ts:78-103`）が、L0 の `db_execute` の 1 回の assert に触れる。登録が無ければ何も返さない。言及は保存の後に遅れて更新される |
| chat の recall | 同じ `fetchSparseSceneIds` を message＋tail で使い、同じ問題を持つ（`semanticRecall.ts:379-391`） | 要る。注入の precision の設計（迷ったら注入しない）に関わる |
| CP-4 の harness を揃える | `cp4-harness.ts:619`、`cp4-diagnostic-probe.ts:67` を新しい関数に揃える | 要る（§8.2 の (b)）。bytes の pin の対象 |
| liveEval | 日本語の sparse の近似を本番の挙動に揃える（新しい関数を使い、FTS が使えないなら sparse 腕の検証を §6.4 の Rust 側へ移す） | 試験の変更だけなら不要。docs の hybrid の数値の扱いを変えるなら、その旨を docs に書く |
| 閾値の再検証 | §4 の計画 | 測るだけなら不要。値を変えるなら要る |

## 8. 確かめていないこと、確認が要る点

### 8.1 確かめていないこと

- 実際の小説での効果（名前の長さ、Codex の登録の率、カタカナの普通名詞の多さ、短い別名の誤言及の率、ルビの率）。
- dense と合わせた最終の一覧の変化。gate 0.85・救済の幅 0.05 が日本語の sparse の下で適切か。
- NIR-1 の L0 runner での実測（§5.2 は近似）。Chronicle の準備で Codex の項目ができるか、評価の renderer で
  `completionTargets` が読み込まれるか。
- JS と Rust の matcher の差（BMP の外の文字）。mark で text node が分かれた名前の索引の側での頻度。
- 実際の項目数・除外の別名・本文の長さでの matcher の所要時間と、Raw-ready への影響。
- `codexStore` を related-scenes の fetch から import したときの起動時の module graph の変化。
- item・lore の名前を入れたときの影響（合成データに無い）。除外の別名の効果（合成データに無い）。
- Latin の語が JSON のキーに当たる件の頻度と、製品の SQLite での大小の区別。
- Rust の空白（`char::is_whitespace`）と JS の `\s` は U+0085 と U+FEFF で違う。名前にこれらがある場合の挙動。
- 既存の試験（§6.2）が実際に通るか（実行していない）。
- en・ja 以外の言語が製品で選べるか。
- 評価の作業ファイル（`gen.py`、`ftsport.py`、`queries2.mjs`、`queries3.mjs`、`eval2.py`、`eval3.py`、`nir1ja.*`、
  `nir1ja2.py`、`bench_matcher.mjs`）は repo の外にある。残すなら別に置き場所を決める。

### 8.2 確認が要る点と、この草稿の判断で決めた点

**ユーザーの確認が要る点**（選択肢と推奨）：

1. **入れる時期**（NIR-1 との順番）
   - A（推奨）：CP-4 の測定が終わってから入れる。その後、L0 の corpus で Raw だけを測り直し、顔ぶれ・並び・点数が
     変わらないこと（§5.2 の見込み）と所要時間を記録する。改訂 1 では `fts_search` が必ず 1 回なので、L0 の runner の契約の
     ままこの再測定ができる（初版の「呼ばない」案ではできなかった）。
   - B：今入れて、Raw の新しい候補として宣言し、CP-4 の候補に含めて測り直す。
   - C：入れない（F3 など別の案を待つ）。
2. **(a) 語が無いときの扱い**：改訂 1 の「今の query に戻す」（推奨。runner の契約も凍結物も変えない）か、初版の
   「呼ばない」を残して L0 runner の `fts_search` 1 回の契約（`contract.mjs:285-297`、`paired.mjs:169-180`）を変えるか。
   後者は凍結済みの評価の規則と品質資産の変更になる。
3. **(b) CP-4 の harness**：製品と同時に新しい関数に揃えるか、CP-4 が終わるまで据え置くか。推奨は据え置き（bytes の pin を
   崩さない。G-case は英語なので値は同じ）。据え置く間、harness の「製品と同じ」は英語でだけ成り立つ。
4. **(c) 短い別名による言及を数えるか**：(i) 数える（今の仕様）か (ii) 一致した表記が 3 字以上の言及だけ数えるか。
   Raw の顔ぶれへの影響が大きく、合成データでは決められない（§3.3）。推奨は付けない。決めてから実装と測定を行う。
5. **(d) Codex が変わったら一覧を取り直すか**：取り直さない（推奨。依存を変えず、NIR-1 の lifecycle に触れない。
   同じ本文から Codex の状態で違う Raw R が出ることを受け入れる）か、`completionTargets` を取り直しの依存に足すか。
6. **Codex の種類**：全種類か、人物と場所だけか（推奨なし。§2.4）。

**この草稿の判断で決めた点**（技術判断。異論があれば直す）：

- 2 字の語は renderer で落とす（Rust の LIKE に `ORDER BY` が無く、空白入りの句は 0 件になるため。§2.2）。
- Codex の取り方は案 1（`completionTargets`＋JS matcher）。IPC と DB 読みを増やさない（§2.3）。
- ルビの base を照合用の本文に入れる（§2.2）。
- 1 項目あたり 3 語、全体 8 語の上限（§2.2）。
- 英語の分岐と既存の `buildSparseQuery` は変えない。
- 次に起案するもの（意見）：過去限定（上限が過去でない枠の約 5 件にあると分かったため）と、本番と同じ経路の日本語の評価（§4 の 3）。

## 9. 決定と実装の記録（2026-11-03）

### 9.1 ユーザーの決定

§8.2 の 6 点は次のとおり決まった（記録は branch `claude/nir1-contracts` の `user-confirmation-2026-11-01-g04-c-redesign.md`、`6d8b370a`、`665a30f3`）。

1. 入れる時期：A（CP-4 の測定の後に入れ、L0 の corpus で Raw だけを測り直す）。CP-4 の正式な再測定は 2026-11-03 に終わった。
2. (a) 語が無いとき：今の query に戻す（推奨のまま）。
3. (b) CP-4 の harness：据え置き（推奨のまま）。harness の 2 か所は `buildSparseQuery` を直接呼び続ける。
4. (c) 短い別名による言及：**(i) 数える**。
5. (d) Codex が変わったら取り直すか：取り直さない（推奨のまま）。
6. Codex の種類：**全種類**（integrator の推奨は「人物と場所だけ」だった。item・lore の普通名詞に近い名前による枠の消費と誤言及は測っていない）。

### 9.2 実装で決めた点（技術判断）

- 新しい関数は新しい file `src/features/related-scenes/relatedScenesSparseQuery.ts` に置いた。`seedTerms.ts` は変えていない（CP-4 の harness が import するので、harness の build の中身を変えないため）。S4b'''' の S2 の pin の path と R5 の記録の path に、変更した file との交差は無い。
- 組立てが投げたとき（Codex の別名の JSON に文字列でない要素があるなど）は従来の query に戻す。組立ては `fts_search` の Promise の外で同期に評価されるので、投げると一覧全体が失敗するため（独立レビューの P2）。
- 重複は大小を区別せずに除く（FTS5 の trigram は既定で大小を区別しない）。
- matcher は `completionTargets` の配列ごとに 1 回だけ作る（WeakMap）。store は更新のたびに新しい配列に置き換える（独立レビューが全ての set を確かめた）。合成（500 項目・1 万字、node 24）で、関数全体の 2 回目以降の平均は 2.20→1.04 ms、最大 3.23→1.88 ms、初回は約 5.7 ms で変わらない。memo の有無は結果を変えないので、試験は memo を外しても通る（性能だけの変更）。
- 「1 項目 3 語」は空白で分ける前の表記で数える（§2.2 の手順 4 のあと手順 6）。複数語の Latin の別名は 1 項目で多くの語を出しうる。2 字の名前も 3 つの枠の 1 つに数える。

### 9.3 L0 の Raw だけの測り直し（参考。正式な測定ではない）

`scripts/quality/run-nir1-retrieval.mjs --mode raw`（標準 build の受領書つき、Xvfb、本番の ONNX）を、master `cbf33077` と実装の枝 `eb12fb49`（独立レビューの直しの前）で 1 回ずつ回した。直しの後の head での測り直しは PR に書く。凍結物（manifest、corpus、freeze）は変えていない。

- 両方 `baseline-complete`。24 query すべてで、結果の場面・並び・点数・抜粋が一致した。品質（recall@8／nDCG@8）も同じ（全体 0.910／0.896、ja 0.819／0.835、en 1.000／0.957）。§5.2 の見込み（顔ぶれ・並び・点数は変わらない）と合う。
- warm の時間：ja の p50 は 21.0→20.4 ms で増えていない。全体の p95（B）は 63.1→73.9 ms だが、差は en の裾（p95 29.4→63.3 ms）から来ていて、en の経路のコードは変えていない。ホストでは別のセッションの試験が並行して動いていて、静かな環境での測定ではない。L0 の凍結時の B（54.2 ms）とも環境が違う。
- 確かめていないこと：L0 の corpus には Codex が無いので、Codex 由来の語の効果と所要時間はこの測定に現れない。実際の小説での効果、dense と合わせた最終の一覧、gate・救済の幅の妥当性は §8.1 のまま。

