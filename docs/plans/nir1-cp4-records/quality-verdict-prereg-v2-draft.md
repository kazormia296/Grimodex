# CP-4 品質の判定：事前に固定する定義 v2（草稿。2026-11-07、改訂 2）

> 状態：**草稿**（判定の結果ではない）。v1 は `quality-verdict-prereg-2026-11-06.md`（以下「v1」。本文は書き換えない）。v2 は、K6/6（`nir1-final-request-eval-proposal/6#graph-eval-procedure`。草稿 `../nir1-final-request-eval-proposal-6-draft.md`）の凍結の後に始めた正式 run の品質の判定にだけ当てる。s6r1 の判定（`quality-verdict-s6r1-1/`、全体 hold、条件 5 の (a) は fail）は v1 のまま残し、v2 で読み直さない。
> 根拠：ユーザーの決定（2026-11-07、`user-confirmation-2026-11-07-s6r1-hold-k66.md` の問 2「契約の『子』の定義にそろえる（推奨）」）。位置づけは v1 と同じ手順外の補助の記録（DR-CP4-QV-0・QV-1）で、S6 の可用性の規則を置き換えない。製品・harness・S2・S4 の bytes、閾値、fixture、Gold は、この草稿では変えない。

## 改訂の履歴

| 版 | 日付 | 中身 |
| -- | ---- | ---- |
| 初版 | 2026-11-07 | contracts `02af2760` |
| 改訂 1 | 2026-11-07 | Opus の独立レビュー（K6/6 と同時。P1-4、P1-5、P2-9〜P2-11、P3）を反映。D3 を G-08/chronicle-index-unusable に限り、親の時点で Graph の Index が使えたことを条件に足した。D3 に (d) の Revision の解決を足した。窓内に合流したが表示に数えない sample を K6/4:171 どおり `fail` にそろえた（D8。v1 の実装は `hold` で K6/4 より弱かった）。D5 を数字で書いた。実装の commit も run の前に置く。`followUp.requeries[]` の扱いと D6 を整理した。レビューの依頼には起案者の要約が含まれ、完全な盲検ではなかった |
| 改訂 2 | 2026-11-07 | K6/6 改訂 1 への Sonnet の 4 観点のレビューと各指摘の反証（完全な盲検ではない）を反映。(1) D8 の FAIL の条件を、Scene の一覧の差ではなく「親の合流が Graph を受けて表示に寄与した（`graph.joined`、宣言 `used`、`edgeCount` 1 以上）のに表示に数えられなかった」事実にした（path の添付だけを足す G-03・G-05・G-06 で FAIL にならない穴を閉じた）。§4 の参考値を数え直した。(2) `followUp.requeries[]` の行は Scene の寄与を持たないので N29・N32 でだけ見ると書き、Scene の寄与の検査の対象を親・子・受領書の最上位の `requeries` に限った。試験の例から「`requeries[]` の行が禁止 Scene を出す例」を外した。(3) D2 の「v1 のまま」を直した。(4) 「最初の正式 run」を定義し、確定版と実装の commit の remote 側の時刻を前提の検査にした。実装の独立のコードレビューを足した |
| 改訂 3 | 2026-11-07 | K6/6 の Fable の最終 pass の任意の指摘 b を integrator が反映：D5 の手順のファイルを「K6/5 の v2」に固定（K6/6 は版を上げないと決めた）、§5 の 2 に v2 の確定版は integrator が決めユーザーの確認の対象ではないことを明記 |

## 0. 観測の規律と、v2 の前に見たもの

- **v2 は観測の後の改訂である**。起案者は次を見た後に v2 を書いた：s5r6 の判定（`quality-verdict-s5r6-1/`）、s6r1 の判定（`quality-verdict-s6r1-1/`、訂正 `ce302ea1`）、s6r1 の Gold の受領書の G-08 の 5 variant の sample（子の `origin`・`refreshTrigger`・`outcome`・`edgeCount`・`chronicleIndexUsable`、親の IR の outcome と snapshot。下の 4 の参考値）、fixture の G-08/chronicle-index-unusable の `forbiddenSceneIds`（`g08-cass-attic`）と `blockedCandidates`（空）。
- **v2 が変えるのは、G-08/chronicle-index-unusable の `index-ready` の再 query の扱いと、K6/6 と K6/4 の字義に連動する箇所だけ**（下の 1 の差分の表）。D2・D3 は s6r1 の条件 5 の (a) の fail を消す方向に働く（緩和）。D5・D8 は狭める側の整合。v2 は s6r1 に当てない。
- **先に固定したことを git で示す**（v1 の訂正 (b) の反省）：v2 の確定版と、それを実装した `quality-verdict.mjs`・`quality-verdict-cli.mjs` と試験の commit は、K6/6 の凍結の後、独立のコードレビュー（read-only。v1 の実装の後の受入れレビューで P2 が 3 件見つかった前例）を受けた後、S4 の 7 回目の凍結の前に、`claude/nir1-contracts`（文書）と実装の枝に commit・push する。「最初の正式 run」は、v2 で判定する `(s4Commit, candidate.commit)` の組の**すべての受領書（SP-P4、trace、parity、Gold、negative、G-01 の診断）のうち最も早い `head.runStartedAtUtc`** とする。判定の出力は、v2 の確定版と実装の commit の remote 側の時刻（repository activity か PushEvent）がその時刻より前であることを前提の検査とし、満たさなければ `[precheck]` で止まる。両方の commit、remote 側の時刻、最初の正式 run の時刻を出力に書く。
- 以降の定義は、v2 の確定の後に変えない。変えるなら v3 を作り、変える前の結果を残す。

## 1. v1 からの差分

| # | v1 の箇所 | v1 の文（要旨） | v2 の文 | 理由 |
| - | --------- | --------------- | ------- | ---- |
| D1 | §3 の 1 つ目（v1:31）「親は `graph-late`（D の窓の後に Graph が届く設計）」 | 表示の一覧は `classifyFollowUp(sample, { context: "steady" })` の `displayedSceneIds` | 読み方は変えない。分類器は K6/6 の first-render の条件（K6/6 の「変える点」の 3）を実装したものを使う。親は D（40 ms）の窓内に合流して first-render で表示されうる（「親は graph-late」の前提を外す） | K6/6 に連動 |
| D2 | §3 の 3 つ目（v1:33）。期待 `unavailable` の variant | 「親・子の表示がすべて対の R+IR と同じ一覧で、Graph が合流も表示もしていなければ … 違えば `fail`」。「子」は区別しない | 文は v1 のまま。ただし D3 の条件をすべて満たす `index-ready` の子だけは「子」に含めず、D3 の別の検査にかける。それ以外のすべての子（`origin` が `graph-ready`〔K6/4:52 の「子」〕、`ir-retry`、`raw-recovery`、`unattributed`、D3 の条件を 1 つでも欠く `index-ready`）は、v1 のまま判定の対象に残す（fail closed）。`followUp.requeries[]`（DR-CP4-C7。trace の Chronicle の停止の形の record にだけ作られ、定常状態の Gold の受領書には無い。行は `seq`・`publishCount`・`lateGraphInDisplay` だけで Scene の一覧を持たない。`trace-record.mjs:1270-1277`）の行は、v1 も対象にしていなかった。v2 では、その行がもしあれば `classifyFollowUp` の N29・N32 の violations で見る（D4）と足す | ユーザーの決定（問 2）。範囲を決定の対象（G-08/chronicle-index-unusable の `index-ready` の取り直し）に限る |
| D3 | （新設。§7 の後に §7a） | — | **`index-ready` の再 query の禁止寄与の検査**。対象：Graph arm の measured の sample のうち、次をすべて満たすもの。(1) variant が `G-08/chronicle-index-unusable`。(2) `child.origin === "index-ready"`（harness の帰属。`k64-record.mjs:333-347`）。(3) `child.refreshTrigger` が `graph-ready` でない。(4) 親の開始時に Chronicle の Index が使えなかった（`snapshot.chronicleIndexUsable === false` かつ親の IR の outcome が `index-unavailable`）。(5) 親の開始時に Graph の Index は使えた（`snapshot.usable === true`。B の seal が current）。(6) 子の開始時に Chronicle の Index が使えた（`child.chronicleIndexUsable === true`）。検査：`publishCount > 0` の子ごとに、(a) 子の `finalSceneIds` から同じ `repeat` の R+IR の一覧を引いた集合が、fixture の `forbiddenSceneIds` と `blockedCandidates[].sceneId` に 1 件も入らない。(b) 子の Graph の path の寄与（`materialRevision.observed[].sceneId`）がそれらに 1 件も入らない（R+IR の一覧にある Scene への path でも数える。厳しい側）。(c) 子の `lateGraphInDisplay` が true でなく、`publishCount` が 1 以下。(d) `materialRevision.unresolvedEdges === 0` で、観測した各 `revision|edge` の Revision が、受領書の setup の記録（`settings.setupReceipt`）の、その材料の最新の typed Revision に解決する。(a)〜(d) のどれかを破れば条件 5 は `fail`（component `a2-index-ready-requery-forbidden`）。`materialRevision` の記録が無く (b)(d) を検査できない子は `hold`。開示（条件に数えない）：対象の子の数、Graph を出した子の数と edge の件数、期待の外の追加の件数、(1)〜(6) のどれかを欠いて D2 に残った `index-ready` の子の件数と欠けた条件 | ユーザーの決定（問 2）の「その取り直しに禁止された場面が混ざらないことは、別に検査する」 |
| D4 | §7 の (a)・(b)（v1:59-60） | 親と `publishCount > 0` の子の一覧から R+IR を引いた寄与が禁止 Scene・blocked 候補に入れば違反。遅れた Graph の混入 | (a) は変えない。Scene の寄与を見る対象を明記する：親、origin を問わないすべての子（D3 の対象の子を含む）、受領書の最上位の `requeries`（`trigger` が `user-operation` でない行）のうち Scene の一覧を持つもの。(b) は変えない。`followUp.requeries[]` の行は Scene の寄与を検査できない（Scene の一覧を持たない）ので、N29・N32（遅れた Graph の混入、2 回以上の公開）の violations でだけ見る | 厳しい側を保ち、実装できる範囲を正直に書く |
| D5 | §4（v1:38-41）の上限の導き方「D が cap 未満のとき B = D / c、上限 = B + D」 | B を D から逆算する | D・B・上限は手順のファイル（K6/5 の v2。K6/6 は版を上げない）を正式の loader で読み、constants の契約の値（D 40 ms、B 54.2 ms、上限 94.2 ms）と一致しなければ `[precheck]`。B を D から逆算しない（K6/5 の変える点 4）。母集団・判定・failed の扱いは v1 のまま | v1 の文面のまま manifest の `D = min(100ms, 0.20*B)`（`evals/nir1-retrieval/manifest.json:137-138`）を D=40 ms に当てると B=200 ms、上限 240 ms で、K6/5 の 94.2 ms より緩い。D5 は狭める側の整合。**s6r1 の判定の script はすでに 94.2 ms で判定していて（`e6abddd2`、`quality-verdict-s6r1-1/README.md`）、v1 の文面からずれていた** |
| D6 | §6 の edge の束縛（v1:54）「子が無い・`graph-ready` でない sample は検査できないので数えず（`skipped`）」 | 子の記録だけで検査する | first-render で表示された sample は、親の合流の結果の寄与の記録（K6/6 の「変える点」の 6）で同じ検査をする。K6/6 の FR-7 は親の寄与の記録を first-render の条件にするので、first-render の sample には必ず記録がある。`skipped` は、表示されなかった sample と、follow-up の子が無い sample だけに残る。検査した sample が 0 の variant は `hold`（v1 と同じ） | K6/6 に連動 |
| D7 | §8 の束縛（v1:66） | procedure `k64-procedure.v1.json` ほか | 手順のファイルは K6/5・K6/6 の版、受領書の `head.k65` と `head.k66` が凍結と一致すること、この v2 の file の sha256 と実装の commit を出力に書く | 束縛の更新 |
| D8 | §3 の 2 つ目（v1:32）「表示されなかった sample … は品質の計算に入れず、件数を開示する」と、その実装（`quality-verdict.mjs:368-371`。表示されない sample の Scene の一覧が R+IR と違えば `hold`〔`not-displayed-sample-differs-from-r-plus-ir`〕） | 表示されない sample の Scene の一覧の食い違いは `hold` | 表示されなかった sample について、次のどちらかなら、その variant の条件（条件 1・2 と、期待のある variant の条件 4）は `fail`（K6/4:171「表示されなかった sample は、R+IR に混ざりなく戻ったことを確かめる」と K6/6 の「変える点」の 6）：(a) **親の合流が Graph を受けて表示に寄与した**（`graph.outcome === "graph-ready"`、`graph.joined === true`、`followUp.parent.declaration === "used"`、`graph.edgeCount >= 1`）。Scene の一覧が R+IR と同じ（path の添付だけを足す）場合も含む。(b) Scene の一覧が対の R+IR と違う（v1 の検査を `hold` から `fail` に）。件数の開示は v1 のまま | v1 の実装は K6/4 の字義より弱かった（`hold`）うえ、Scene の一覧の比較では path の添付だけの variant を見落とす。新しい緩和を足さず、K6/4 と K6/6 にそろえる（狭める側） |

v1 の §1・§2・§5・§9 と、§3 の 4 つ目（R+IR arm）、§7 の (c) は変えない。

## 2. 守ること（v2 の In-scope な誤り）

- `index-ready` の子の帰属（`origin`）は harness の推論なので、それだけで判定から外さない。D3 の (1)〜(6) で、variant、製品の契機の印（`refreshTrigger`）、親と子の Index の状態の遷移を観測で確かめ、欠けるものは D2 の判定に残す。G-08/chronicle-index-unusable 以外の variant（G-08/both-indexes-unusable、G-08/graph-index-unusable、G-03/frontier-exceeded）の `index-ready` の子は D3 の対象にしない。
- `graph-ready` の子（K6/4 の「子」）が期待 `unavailable` の variant で Graph を出したら、v1 と同じく `fail`。v2 はこれを緩めない。
- D3 は禁止 Scene・blocked 候補への寄与を Scene の一覧と path の両方で見て、Revision の解決まで確かめる。「表示された一覧が R+IR と同じ」だけで済ませない。
- 窓内に合流して Graph が表示に寄与したのに表示に数えない sample を、Scene の一覧が R+IR と同じことを理由に見逃さない、また `hold` に留めない（D8）。
- v2 を s6r1 に当てて合格の側に読み直さない。

## 3. 確かめられないこと（v1 の §9 に足す）

- `index-ready` の子が出る理由（G-08/chronicle-index-unusable の測定中に Chronicle の Index が使える状態に戻ること）は未確認。D3 は、戻った後の取り直しの禁止寄与だけを見て、戻ったこと自体の是非は判定しない（開示だけ）。
- D3 の (b)(d) は `materialRevision` の記録に頼る。記録の無い子は `hold`。
- D3 の (d) の「setup の記録の最新の typed Revision」を受領書だけで引けるかは、実装の時に確かめる（引けなければ (d) は `hold`）。

## 4. s6r1 に当てた場合の参考値（予告。判定に使わない）

- G-08/chronicle-index-unusable の Graph arm の 30 sample（measured）：子はすべて `origin: index-ready`、`refreshTrigger: null`、親の IR は `index-unavailable`・`snapshot.chronicleIndexUsable: false`・`snapshot.usable: true`、子の `chronicleIndexUsable: true`、子の outcome は `graph-ready`・`edgeCount` 1・`publishCount` 1。D3 の対象になる。子の一覧は対の R+IR と同じ（Scene の追加 0）。path の寄与は `g08-attach`（`g08-r-juno|g08-rents-to-juno`、`unresolvedEdges` 0）で、`forbiddenSceneIds`（`g08-cass-attic`）に入らない。`lateGraphInDisplay` は false。(d) の Revision の解決は起案者は確かめていない。**(a)〜(c) は違反 0 で、D2 の判定の対象（親）にも違反は無い**ので、(d) が通れば v2 では条件 5 の (a) は fail にならない見込み。
- G-08/both-indexes-unusable：子は `index-ready`・`graph-unavailable`。D3 の対象にならず D2 に残るが、Graph を出していないので違反 0（v1 と同じ）。
- D8 を s6r1 に当てると（s6r1 の分類器の読み、つまり窓内の 163 件がすべて表示されなかった扱いで）、163 件はすべて D8 の (a) に当たる（`joined`、宣言 `used`、`edgeCount` 1〜3）。D8 の (a) で `fail` になる variant は G-01/v1（30）、G-02/base（6）、G-03/base（30）、G-05/base（7）、G-06/base（30）、G-08/base-usable（30）、G-08/graph-recovered（30）の 7 つ。そのうち Scene の一覧が R+IR と違い v1 の検査でも見えていたのは G-01、G-02、G-08/base-usable、G-08/graph-recovered の 4 つ（96 件）で、G-03、G-05、G-06（67 件）は path の添付だけで、v1 の Scene の一覧の検査では見えなかった。K6/6 の下でこれらの親が first-render の条件を満たせば、表示された sample として測られ、D8 には当たらない（s6r1 では FR-7 の記録が無いので確かめられない）。s6r1 の全体は v1 でも hold。

## 5. 確定までの手順

1. 草稿（この file）。K6/6 の改訂 1 のレビューと同じ時期に、read-only のレビューを受ける（起案者の結論は渡さない）。
2. K6/6 の確認・凍結の後に、v2 の確定版を commit・push する。v2 の確定版は integrator が決め、ユーザーの確認の対象ではない（D2・D3 の方向は contracts `1e6ede44` の問 2 でユーザーが選んだもの、D8 は K6/6 の変える点 6 に連動する狭める側）。
3. `quality-verdict.mjs`・`quality-verdict-cli.mjs` を v2 に合わせ（pin の外。DR-CP4-QV-1）、D2・D3・D4・D8 の試験（`index-ready` の子の (1)〜(6) のそれぞれを欠く例、G-08/both-indexes-unusable の `index-ready` の子が Graph を出す例、禁止 Scene への path の寄与の例、Revision が解決しない例、`graph-ready` の子が Graph を出す例、`followUp.requeries[]` の行が遅れた Graph を混ぜる・2 回公開する例〔N29・N32〕、表示されない sample の Scene の一覧が R+IR と違う例、**表示されない sample の Scene の一覧が R+IR と同じで Graph の path の添付だけがある例〔G-06 の形〕**、Graph が合流したが `edgeCount` 0 の例〔D8 に当たらない〕）を足す。独立のコードレビューを受け、S4 の 7 回目の凍結の前に commit・push する（0）。K6/6 の「確認までの手順」の 7 に入れる。
4. 取り直しの正式 run の後に、v2 で判定し、v1 の判定（s6r1）と並べて記録する。
