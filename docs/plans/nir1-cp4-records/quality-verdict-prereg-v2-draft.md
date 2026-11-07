# CP-4 品質の判定：事前に固定する定義 v2（草稿。2026-11-07）

> 状態：**草稿**（判定の結果ではない）。v1 は `quality-verdict-prereg-2026-11-06.md`（以下「v1」。本文は書き換えない）。v2 は、K6/6（`nir1-final-request-eval-proposal/6#graph-eval-procedure`。草稿 `../nir1-final-request-eval-proposal-6-draft.md`）の凍結の後に始めた正式 run の品質の判定にだけ当てる。s6r1 の判定（`quality-verdict-s6r1-1/`、全体 hold、条件 5 の (a) は fail）は v1 のまま残し、v2 で読み直さない。
> 根拠：ユーザーの決定（2026-11-07、`user-confirmation-2026-11-07-s6r1-hold-k66.md` の問 2「契約の『子』の定義にそろえる（推奨）」）。位置づけは v1 と同じ手順外の補助の記録（DR-CP4-QV-0・QV-1）で、S6 の可用性の規則を置き換えない。製品・harness・S2・S4 の bytes、閾値、fixture、Gold は、この草稿では変えない。

## 0. 観測の規律と、v2 の前に見たもの

- **v2 は観測の後の改訂である**。起案者は次を見た後に v2 を書いた：s5r6 の判定（`quality-verdict-s5r6-1/`）、s6r1 の判定（`quality-verdict-s6r1-1/`、訂正 `ce302ea1`）、s6r1 の Gold の受領書の G-08 の 5 variant の sample（子の `origin`・`refreshTrigger`・`outcome`・`edgeCount`・`chronicleIndexUsable`、親の IR の outcome。下の 4 の参考値）、fixture の G-08/chronicle-index-unusable の `forbiddenSceneIds`（`g08-cass-attic`）と `blockedCandidates`（空）。
- **v2 の規則が変えるのは、期待 `unavailable` の variant で `index-ready` の再 query をどう扱うかと、それに連動する箇所だけ**（下の 1 の差分の表）。この変更で s6r1 の条件 5 の (a) の fail は消える方向に働く（緩和）。そのため v2 は s6r1 に当てない。
- **先に固定したことを git で示す**（v1 の訂正 (b) の反省）：v2 の確定版は、K6/6 の凍結の後、かつ v2 で判定する最初の正式 run の開始の前に `claude/nir1-contracts` に commit・push し、commit の時刻と run の開始の時刻（受領書の `head.runStartedAtUtc`）を判定の出力に書く。後の commit なら、その判定は v2 の判定と呼ばない。
- 以降の定義は、v2 の確定の後に変えない。変えるなら v3 を作り、変える前の結果を残す。

## 1. v1 からの差分

| # | v1 の箇所 | v1 の文（要旨） | v2 の文 | 理由 |
| - | --------- | --------------- | ------- | ---- |
| D1 | §3 の 1 つ目（v1:31）「親は `graph-late`（D の窓の後に Graph が届く設計）」 | 表示の一覧は `classifyFollowUp(sample, { context: "steady" })` の `displayedSceneIds` | 表示の一覧の読み方は変えない（`classifyFollowUp` の `displayedSceneIds`）。ただし分類器は K6/6 の first-render の条件（K6/6 の「変える点」の 3）を実装したものを使う。親は D（40 ms）の窓内に合流して first-render で表示されうる（「親は graph-late」の前提を外す） | K6/6 に連動 |
| D2 | §3 の 3 つ目（v1:33）。期待 `unavailable` の variant | 「親・子の表示がすべて対の R+IR と同じ一覧で、Graph が合流（`graph.joined`）も表示（子が `graph-ready` かつ `edgeCount > 0`）もしていなければ、Graph arm の一覧は R+IR と同じとする。違えば … `fail`」。「子」は区別しない | **「使えない間」の判定の対象は、親と、K6/4 の「子」（その世代について製品が `graph-ready` で出す 1 回の再 query。K6/4:52）だけ**。子が K6/4 の「子」であるとは、`followUp.child.origin === "graph-ready"` かつ `followUp.child.refreshTrigger === "graph-ready"`。それ以外の文（R+IR と同じ一覧、合流も表示もしていない、違えば `fail`）は v1 のまま。**`index-ready` の子**（下の D3 の条件をすべて満たすもの）は、この判定から外し、D3 の別の検査にかける。D3 の条件を 1 つでも欠く子と、`origin` が `ir-retry`・`raw-recovery`・`unattributed` の子は、v1 のまま判定の対象に残す（fail closed） | ユーザーの決定（問 2）。K6/4:52 の「子」の定義にそろえる |
| D3 | （新設。§7 の後に §7a） | — | **`index-ready` の再 query の禁止寄与の検査**。対象：期待 `unavailable` の variant の Graph arm の measured の sample のうち、子が次をすべて満たすもの。(1) `child.origin === "index-ready"`（harness の帰属。`k64-record.mjs:333-347`：親の呼出しと子の呼出しの間に `index-ready` の通知がある）、(2) `child.refreshTrigger` が `graph-ready` でない、(3) 親の開始時に Chronicle の Index が使えなかった（`snapshot.chronicleIndexUsable === false`、または親の IR の outcome が `index-unavailable`）、(4) 子の開始時に Chronicle の Index が使えた（`child.chronicleIndexUsable === true`）。検査：`publishCount > 0` の子ごとに、(a) 子の `finalSceneIds` から同じ `repeat` の R+IR の一覧を引いた集合が、fixture の `forbiddenSceneIds` と `blockedCandidates[].sceneId` に 1 件も入らない、(b) 子の Graph の path の寄与（`materialRevision.observed[].sceneId`）が `forbiddenSceneIds` と `blockedCandidates[].sceneId` に 1 件も入らない（R+IR の一覧にある Scene への path でも数える。厳しい側）、(c) 子の `lateGraphInDisplay` が true でなく、`publishCount` が 1 以下。1 つでも破れば条件 5 は `fail`（component `a2-index-ready-requery-forbidden`）。開示（条件に数えない）：対象の子の数、Graph を出した子の数と edge の件数、期待の外の追加（禁止でない Scene の追加）の件数、親の Chronicle の状態の内訳。D3 の条件の (3) または (4) を満たさない `index-ready` の子があれば、その件数も開示する（その子は D2 の判定に残る） | ユーザーの決定（問 2）の「その取り直しに禁止された場面が混ざらないことは、別に検査する」 |
| D4 | §7 の (a)（v1:59） | 親と `publishCount > 0` の子の一覧から R+IR を引いた寄与が禁止 Scene・blocked 候補に入れば違反 | 変えない（`index-ready` の子も含めて、すべての子に当てる。D3 の (a) と重なるが、D3 は期待 `unavailable` の variant での path の寄与を足す） | 厳しい側を保つ |
| D5 | §4（v1:38-41）の上限の導き方「D が cap 未満のとき B = D / c、上限 = B + D」 | B を D から逆算する | K6/5 の読み：D・B・上限は手順のファイル（v2 か、K6/6 で版を上げるならその版）を正式の loader で読み、constants の契約の値（D 40 ms、B 54.2 ms、上限 94.2 ms）と一致しなければ `[precheck]`。B を D から逆算しない（K6/5 の変える点 4）。母集団・判定・failed の扱いは v1 のまま | s6r1 の script はすでにこの読み（`e6abddd2`、`quality-verdict-s6r1-1/README.md`）で、v1 の文面と食い違っていた。文面を script と契約にそろえる |
| D6 | §6 の edge の束縛（v1:54）「子が無い・`graph-ready` でない sample は検査できないので数えず（`skipped`）」 | 子の記録だけで検査する | first-render で表示された sample は、親の合流の結果の寄与の記録（K6/6 の「変える点」の 6 で harness が足す、子と同じ `contributionBasis`・`materialRevision`）で同じ検査をする。親の記録が無い first-render の sample は `skipped` で、検査した sample が 0 の variant は `hold`（v1 と同じ） | K6/6 に連動 |
| D7 | §8 の束縛（v1:66） | procedure `k64-procedure.v1.json` ほか | 手順のファイルは K6/5・K6/6 の版、受領書の `head.k65` と `head.k66` が凍結と一致すること、この v2 の file の sha256 を出力に書く | 束縛の更新 |

v1 の §1・§2・§5・§9 と、§3 の 2 つ目（子の読み）・4 つ目（R+IR arm）、§7 の (b)・(c) は変えない。

## 2. 守ること（v2 の In-scope な誤り）

- `index-ready` の子の帰属（`origin`）は harness の推論なので、それだけで判定から外さない。D3 の (2)〜(4) で、製品の契機の印（`refreshTrigger`）と Chronicle の状態の遷移（親で使えず、子で使える）を観測で確かめ、欠けるものは D2 の判定に残す。
- `graph-ready` の子（K6/4 の「子」）が期待 `unavailable` の variant で Graph を出したら、v1 と同じく `fail`。v2 はこれを緩めない。
- D3 の検査は、禁止 Scene・blocked 候補への寄与を Scene の一覧と path の両方で見る。「表示された一覧が R+IR と同じ」だけで済ませない。
- v2 を s6r1 に当てて合格の側に読み直さない。

## 3. 確かめられないこと（v1 の §9 に足す）

- `index-ready` の子が出る理由（期待 `unavailable` の variant の測定中に Chronicle の Index が使える状態に戻ること）は未確認。D3 は、戻った後の取り直しの禁止寄与だけを見て、戻ったこと自体の是非は判定しない（開示だけ）。
- D3 の (b) の path の寄与は `materialRevision.observed` の記録に頼る。記録の無い子は検査できないので `hold` とする（`fail` にも `pass` にもしない）。

## 4. s6r1 に当てた場合の参考値（予告。判定に使わない）

- G-08/chronicle-index-unusable の Graph arm の 30 sample（measured）：子はすべて `origin: index-ready`、`refreshTrigger: null`、親の IR は `index-unavailable`・`snapshot.chronicleIndexUsable: false`、子の `chronicleIndexUsable: true`、子の outcome は `graph-ready`・`edgeCount` 1・`publishCount` 1。D3 の対象になる。子の一覧は対の R+IR と同じ（Scene の追加 0）。path の寄与は `g08-attach`（`g08-r-juno|g08-rents-to-juno`）で、`forbiddenSceneIds`（`g08-cass-attic`）に入らない。`lateGraphInDisplay` は false。**D3 は違反 0、D2 の判定の対象（親）にも違反は無い**ので、v2 では条件 5 の (a) は fail にならない見込み。
- G-08/both-indexes-unusable：子は `index-ready`・`graph-unavailable`（違反 0。v1 と同じ）。
- それでも s6r1 の全体は hold のまま（条件 1・2・4 は表示 0 の variant による hold、条件 5 は (c) が `not-evaluable`）。

## 5. 確定までの手順

1. 草稿（この file）。K6/6 の独立レビューと同じ時期に、read-only のレビューを受ける（起案者の結論は渡さない）。
2. K6/6 の確認・凍結の後に、v2 の確定版を commit・push する（0 の「先に固定したことを git で示す」）。
3. `quality-verdict.mjs`・`quality-verdict-cli.mjs` を v2 に合わせる（pin の外。DR-CP4-QV-1）。v2 の D2・D3 の試験（`index-ready` の子の 4 条件のそれぞれを欠く例、禁止 Scene への path の寄与の例、`graph-ready` の子が Graph を出す例）を足す。
4. 取り直しの正式 run の後に、v2 で判定し、v1 の判定（s6r1）と並べて記録する。
