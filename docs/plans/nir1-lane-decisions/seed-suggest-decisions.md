# Related Scenes の起点の表示と候補（段階 1）の判断の記録

lane：Related Scenes の Graph に「起点（seed）の表示」と「起点の候補（1 クリックで pin）」を足す段階 1。base は master `865a3e2b`（#741 まで）。branch `claude/related-scenes-seed-suggest`。
ユーザーの要望（2026-10-27「pin 自動にしたい」）に対し、read-only の advisor が 3 段の道筋を推奨し、ユーザーが同意した。この lane は段階 1 だけを行う。gate（`NIR1_GRAPH_UI_ENABLED`）は閉じたままで、製品の誰にも見えない。

## 範囲

- 作るもの：起点の名前の表示、pin が無い Scene の起点の候補（最大 3 件）、候補を作者のボタン操作で pin する確定。
- 変えないもの：`selectNir1GraphSeed`（`nir1GraphSeed.ts`）、`useNir1RelatedScenes.ts`（begin の payload、cache key、revocation、requalification の意味。file そのものも変えない）、Native、IPC 契約、`schema.ts`／migration、`evals/**`、`scripts/quality/nir1-graph-eval/**`、gate の値。

## 指示書との照合（master `865a3e2b` で確かめた事実）

| 指示書の記述 | master の事実 | 扱い |
|---|---|---|
| 「Graph 節（gate の内側）に足す」。Graph 節の UI は `Nir1GraphRelatedScenes.tsx` | `RelatedScenesSection.tsx` の `showsGraph` が真のときだけ `Nir1GraphRelatedScenes` の lazy chunk が描かれる（`graph-ready` で payload がある、`restart-required`、活性化の UI 定数が on の `profile-not-restricted`）。seed が無い query には `graphOutcome` が付かない（`nir1RelatedScenesFetchTypes.ts`「Present only for a seeded query」）ので、seed が null の Scene では Graph 節そのものが描かれない。seed があっても `not-activated` などでは描かれない | 候補は `Nir1GraphRelatedScenes` の中に置けない。別の lazy chunk `Nir1GraphSeedPanel.tsx` を作り、`RelatedScenesSection` の中、同じ gate（`isNir1GraphUiEnabled()`）の内側に置く（DR-SEEDSUG-1） |
| 「成功後は seed が変わるので、Graph の問い合わせがその seed で走り直すこと（既存の仕組みで起きるか確認）」 | hook の query effect の依存は `enabled, sceneId, nodes, mode, projectId, workspace, openRevision, listening, refresh` で、pin は含まれない。`upsertScenePin` は tree store を変えない。renderer 内の通知 `notifyNir1GraphOnlyRevoked` は、表示中の Graph-only の Scene と一致するときだけ取り直す（seed が無いと Graph は無い）。session の invalidation の後は `recoverRaw` の `rawOnly`（seed を読まない） | 既存の仕組みでは seed は読み直されない。hook を変えずに、節を mount し直す（節を閉じて開くのと同じ既存の経路）（DR-SEEDSUG-3） |
| `scene_codex_pins` は `schema.ts:1111-1128`、`pov_character_id` は `schema.ts:98` | `sceneCodexPins` は 1111 行から。`povCharacterId` は 97 行（`codexEntries.id` への FK、`onDelete: set null`） | 食い違いなし（行番号の 1 行差だけ） |
| Scene の pin を書く UI は Matrix だけ（`MatrixPanel.tsx:268-270, 297`） | Matrix は一致。ほかに Grid のカードの chip（`GridCardChips.tsx` → `sceneCodexPinsStore.addPin` → `upsertScenePin`）も Scene の pin を書く | 影響なし（どれも同じ `upsertScenePin` を通る。Grid／Matrix で pin を変えても、Related Scenes は次の問い合わせまで seed を読み直さない（既存の挙動のまま）） |

## 判断

| ID | 日付 | 判断 | 根拠・信頼境界 | 代替案 | 状態 |
|---|---|---|---|---|---|
| DR-SEEDSUG-1 | 2026-10-27 | 起点の表示と候補は lazy chunk `Nir1GraphSeedPanel`（`Nir1GraphBoundary` と `Suspense` の中、失敗時は何も描かない）。`RelatedScenesSection` の本文の先頭に、`enabled`（keepalive で非 active なら出さない）で、`isNir1GraphUiEnabled()` が真で、表示中の完了した問い合わせの `origin` が active な Scene のものであるときだけ描く（project は `origin.projectId`）。問い合わせの世代（`origin.queryGeneration`）が変わるたびに読み直し、読み直しの間は前の表示を残す。seed がある Scene では、Graph の結果の種類（`not-activated` などで Graph 節が描かれないときも）によらず「起点: 名前」を出す | gate が閉じている間は chunk の要求も、seed・候補の読み取りも、pin の書込みも 0（`RelatedScenesSection.seedPanel.default.test.tsx`）。文言は Graph の lazy な翻訳 module に置き、`src/locales/*.json` に足さない（DR-CP3B-7 と同じ） | `Nir1GraphRelatedScenes` の中に置く：seed が null のとき描かれないので要件を満たせない。`showsGraph` を広げる：Graph 節の表示の条件（DR-CP3B-7、DR-DA2-33）を変えるので採らない。Scene と現在の project だけで描く（問い合わせを待たない）：Scene を素早く移るたびに読み、表示が問い合わせの seed とずれうる。また既存の Graph 有効の試験（`origin: null`、DB の mock なし）で DB の読み取りが browser mock の初期化を起こし、並列の実行で `RelatedScenesSection.profileActivation.closed.test.tsx` の待ち（1 秒）を超えて落ちた（188 file の実行で再現、名前の読み取りを止めると通る）ので採らない | 実装 |
| DR-SEEDSUG-2 | 2026-10-27 | 候補の順序は (1) Scene の POV 人物（`tree_nodes.pov_character_id`）、(2) beat の言及で role が actor、(3) 本文の言及（source が body か semantic）。同順位は `entry_id` の昇順。1 項目は最も高い順位で 1 回。最大 3 件。結合は `selectNir1GraphSeed` と同じ（同じ project の archived でない scene の node、同じ project の Codex 項目）。この Scene に pin 済みの項目、起点になりえない ID（空白だけ、200 UTF-16 超。`selectNir1GraphSeed` が null にするもの）は出さない | 順位は作者の意図の強さの順：POV は作者が Scene に宣言した人物、beat の actor は作者が書いた beat から構造化した行為者、本文の言及は自動の文字列一致で最も弱い。`entry_id` の昇順は seed 自体の同順位の規則（`created_at` の次）と同じで決定的。並べ替えは JS の UTF-16 の比較（SQLite の BINARY と違いうるのは BMP の U+E000 以上と surrogate の組の比較だけで、ID は UUID）。読み取りだけ（3 本の小さな SELECT。scene、mention、pin。どれも scene の索引）で、表・列・cache を作らない。読むのは gate が on で、節が開いて active で、seed が null のときだけ | 1 本の UNION の SQL：drizzle で読みにくく、試験の差もない。role が target の beat を (2) に含める：行為者でない人物を起点にすると Graph の経路が Scene の主体から外れやすいので段階 1 では含めない | 実装 |
| DR-SEEDSUG-3 | 2026-10-27 | 確定はボタンの click だけで、既存の `upsertScenePin(sceneId, entryId)` を 1 回呼ぶ。書込み中は ref で 2 回目以降を捨て、全ボタンを disabled にする。成功したら `RelatedScenesSection` が内側の view を `key` で mount し直す：hook の cleanup（session の release、購読の解除）と新しい mount（購読、debounce、`selectNir1GraphSeed` の読み直し、その seed での begin）は、節を閉じて開くときと同じ既存の経路。失敗したら固定の文（`role="alert"`）を出し、候補を残し、押し直せる。error の文は表示も log もしない | hook の begin の payload、cache key、revocation、requalification の意味は変えない（hook の file に差分なし）。pin の行は作者のボタン操作でだけ増える（自動で書かない。試験で render 後の `upsertScenePin` 0 回を確かめる） | hook に「pin が変わった」通知の購読を足す：hook の動作の変更なので指示書に従い採らない（段階 2 で seed の規則を変えるときに合わせて検討）。tree store の `nodes` を差し替えて再実行させる：無関係な store を合図に使うので採らない | 実装 |
| DR-SEEDSUG-4 | 2026-10-27 | 文言（`relatedScenes.graph.seed*`、日英）は**暫定**。gate が閉じている間は誰にも見えない。PUB-G のときに、活性化の UI・開示・閉鎖の文言と一緒に別にユーザーが承認する | — | — | 暫定 |
| DR-SEEDSUG-5 | 2026-10-27 | 信頼境界：保存の範囲は増えない（候補は保存しない。pin は既存の表に、既存の API で、作者の操作でだけ）。外への送信、新しい受け手、新しい IPC、新しい永続状態は無い（renderer の Drizzle の SELECT と既存の `upsertScenePin` だけ）。Native の seed の再読と requalification は変わらないので、renderer の表示は防御に数えない | 確認済みの範囲の内側。新しい actor・受信先・保存先を足さない | — | 実装 |
| DR-SEEDSUG-6 | 2026-10-27 | 段階 2（pin が無ければ POV 人物を seed にする規則の変更）と段階 3（pin の中から文脈で選ぶ、自動の pin を DB に書く）は行わない | seed の規則（`selectNir1GraphSeed`、Native `read_nir1_graph_seed_in_tx`、requalification）は CP-4 の評価と K6/4 R5 の前提で、評価は固定した候補で取る。規則を変えると評価の前提が崩れる。自動で DB に書くのは保存の範囲の変更で、別の承認が要る | — | 範囲外 |
| DR-SEEDSUG-7 | 2026-10-27 | 残る端の場合：seed が null でも pin がある Scene（最初の pin の ID が空白だけ・200 UTF-16 超）は候補を出すが、pin を足しても seed は変わらない（`selectNir1GraphSeed` は次の pin を試さない）。ID は UUID なので実際には起きない。pin の後は対象のボタンが消えるので、focus は節の外に戻る（gate を開く前に見直す） | seed の規則を変えないため | 候補の側で「pin があれば出さない」：規則を写すことになるので採らない | 既知 |

## 試験

- `nir1GraphSeedCandidates.test.ts`：順序、同順位、重複の除去、beat の actor 以外と relation を含まない、他 project の項目、archived・他 project・scene でない node、pin 済みの除外、POV が無い／他 project の項目／削除済み、起点になりえない ID、書込みが無いこと、起点の名前が `selectNir1GraphSeed` の選ぶ最初の pin のもの。
- `Nir1GraphSeedPanel.test.tsx`：起点の表示、候補の list と button の名前、自動で pin しない、1 回だけ正しい引数で pin（連打）、失敗の表示と押し直し、候補が無いとき、読めないとき何も描かない、Scene の切替で前の Scene の表示を出さない、同じ Scene の新しい問い合わせで読み直す。
- `RelatedScenesSection.seedPanel.test.tsx`：seed 無しの begin → click で pin → その seed で begin し直す、失敗時は問い合わせも候補も残る、非 active では出さない、origin が無い／別の Scene の問い合わせでは出さず読まない。
- `RelatedScenesSection.seedPanel.default.test.tsx`：製品の既定（gate 閉）で chunk の要求・読み取り・書込み・表示が 0。
