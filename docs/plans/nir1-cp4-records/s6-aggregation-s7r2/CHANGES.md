# s6-aggregation-s7r2/scripts：s7r1 の script からの置き換え一覧

> **2026-11-15 の run の後に追記**：この一覧は run の前に下書きとして書いたもので、下の本文はその時点の記述のまま残しています。その後、script を contracts のこの dir に写して実行しました（`s6-aggregation.json`。`[precheck]` では止まっていません）。同じ入力で 2 回実行し、出力が byte 一致することも確かめました。B の 3 の「空配列」の読みは、実際の受領書で確かめました。Gold の 13 receipt の `priorAttempts.gold` は、すべて空配列でした（`gold1Disclosure.goldReceiptsWithEmptyPriorAttemptsGold`＝13）。

元：`docs/plans/nir1-cp4-records/s6-aggregation-s7r1/scripts/` の 3 本（contracts の worktree `claude-nir1-contracts-results`。読むだけで、書き込んでいない）。
今回（s7r2）：S4b `f2f99b13`（再凍結なし）、候補 `29a120ddd3dd8ec5a43845a76cbda837e9b20f6a`（PR #909 の merge commit）、worktree `/home/grimodex/worktrees/Grimodex/cp4-formal-s7r2`。

**実行していない。** 確かめたのは `node --check`（3 本とも構文 OK）と、元との `diff` の読みだけ。構造を変えた箇所（下の B）は、run の前に目で追うこと。run の後の実行は、次のどちらでもなく **contracts の `docs/plans/nir1-cp4-records/s6-aggregation-s7r2/scripts/` に写してから**行う（`REC = path.resolve(HERE, "../..")` と `${HERE}/../trace-k64-recompute.json` が script の位置の相対なので、drafts の位置では `attempts-final-s7r2/` などを解決しない。絶対 path には直していない）。

## A. 機械的な置き換え（3 本共通。行番号は s6-aggregate.mjs の新しい行）

| 置き換え | 元 | 新 | 場所 |
|---|---|---|---|
| 候補の worktree | `/home/grimodex/worktrees/Grimodex/cp4-formal-k66` | `/home/grimodex/worktrees/Grimodex/cp4-formal-s7r2` | s6-aggregate.mjs:21、recompute-trace-base.mjs:3、recompute-trace-k64.mjs:4 |
| 候補の 40 桁 | `3f333a83554d4dba6c54417d500d3af6f0e985c5` | `29a120ddd3dd8ec5a43845a76cbda837e9b20f6a` | s6-aggregate.mjs:26（`CAND`）、recompute-trace-base.mjs:6（`head`）、recompute-trace-k64.mjs:7（`head`） |
| 8 桁の候補の表記 | `3f333a83`（コメントと error 文） | `29a120dd` | s6-aggregate.mjs:3・5・65 |
| run 名の接尾辞 | `s7r1` | `s7r2` | s6-aggregate.mjs の `PARITY`・`NEG_RUNS`・`EXPECTED_LEDGER`・`attempts-final-s7r2/`・`parity-s7r2-1/`・`negatives-s7r2-1/`・`g01-e2e-s7r2-1(-report)/`・`trace-*-s7r2-1`・`sp-p4-s7r2-1`・selectReceiptsForAggregation の runId の正規表現（:94）。recompute-trace-base.mjs:10、recompute-trace-k64.mjs:12 の `trace-${kind}-s7r2-1` |
| 変えていない | S4b（`f2f99b13…`）、K6/2・K6/4・K6/5・K6/6 の凍結 commit と SHA-256（`K62`〜`K66`）、`45`（SOURCE_PINS の件数。S2 の pin は bytes 24＋ancestor 21＝45。依頼元は S2 の pin 94 件の一致を照合済み）、`28`（集計に入る受領書）、`13`／`12`／`3`（Gold／parity／negative の受領書数） | — | — |

## B. 構造を変えた箇所（s7r1 では「Gold が 2 回」を前提に書かれていたため）

s7r1 の script は、台帳 9 件（`gold-s7r1-1` stopped＋`gold-s7r1-2` completed）を前提に、`GOLD`＝`gold-s7r1-2`、`GOLD_PRIOR`＝`gold-s7r1-1` を固定していた。単純に `s7r1`→`s7r2` にすると `GOLD`＝`GOLD_PRIOR`（どちらも `gold-s7r2-…`）になり壊れるので、次のように直した。

1. **Gold の run 名（:31-33）**：既定 `GOLD = "gold-s7r2-1"`、`GOLD_PRIOR = null`。**取り直したときだけ** `GOLD_RUN=gold-s7r2-2 node s6-aggregate.mjs` とすると `GOLD = "gold-s7r2-2"`、`GOLD_PRIOR = "gold-s7r2-1"` になる。どちらでもない値は `[precheck]`。（`chain.sh` の `GOLD=${GOLD:-gold-$SFX-1}` と同じ run 名の規則。環境変数の名前は、`env.sh` の他の変数と取り違えないよう `GOLD_RUN` にした。）
2. **台帳の件数（:37-38、:55-74）**：`EXPECTED_COUNTED = 8`（集計の対象は常に 8 件の completed）。`EXPECTED_LEDGER` は `[GOLD_PRIOR, GOLD, …].filter(Boolean)` で、**既定は 8 件、取り直しは 9 件**。file 名の比較は、期待値も sort してから行う（元は期待値を手で sort 済みの並びで書いていた）。`counted` の判定（`a.runName !== GOLD_PRIOR`）は null でも成り立つ。
3. **`GOLD_PRIOR` が null のときの分岐**：
   - `prior` の検査（stopped であること、`GOLD` より前に終わっていること）は `if (GOLD_PRIOR)` の中へ（:68-72）。
   - `goldPrior` の受領書の読みは null なら空（:81）。元の `goldPrior.length !== 3` の検査は削除（`3` は s7r1 の停止点＝4 番目の variant の手前、に固有の数。取り直しの停止点は run ごとに違う）。
   - SOURCE_PINS の `reportFiles` は `GOLD_PRIOR` があるときだけ載せる（:142。`pinBad` の `run !== GOLD_PRIOR` は null で安全）。
   - 3c の開示（`gold1Disclosure`）は、既定では「取り直し無し」の短い記録だけ（:227-233）。取り直しのときは s7r1 と同じ中身（:234-258）。
   - **新しい検査（:111-116）**：取り直し無しのとき、Gold の 13 receipt の `priorAttempts.gold` が空配列でなければ `[precheck]`。根拠：`frozen-k64-run.mjs` の `listAttemptsFn` は `startAttemptFn` の前に呼ばれ、同じ (candidate, s4Commit, runKind) の前の試行だけを返す（s7r1 の `gold-s7r1-2` は 1 件、今回の `gold-s7r2-1` は 0 件のはず）。（run の前の時点では、`frozen-k64-run.mjs:1675-1700` を読んだだけでした。run の後に、実際の受領書でも 13 件すべて空配列であることを確かめました。）
4. **`sideBySide` の key 名（:254）**：`goldS7r1_1_notCounted`／`goldS7r1_2_counted` → `goldPriorRunNotCounted`／`goldRunCounted`（run 名を含まない一般形。取り直しのときだけ出る）。
5. **前回候補の Gold の開示欄を追加（:259-278、`previousCandidateGoldDisclosure`）**：前回 s7r1 の `gold-s7r1-1`（stopped。V-10）と `gold-s7r1-2`（completed）は別候補 `3f333a83` の試行で、台帳の key が (candidate, S4) なので、s7r2 の台帳にも `priorAttempts.gold` にも**自動では出ない**。contracts の `attempts-final-s7r1/` の 2 つの台帳を読み、status・開始と終了・候補・`sameKeyAsThisRun`（false のはず）・sha256 を載せる。読めなければ `readError` を載せて続ける。集計にも判定にも数えない。定数 `PREVIOUS_CANDIDATE`（:34）に前回候補の 40 桁と run 名を持つ。
6. **parity の `note`（:206）**：「`gold-s7r2-1` の V-10」（機械置換でできる偽の文）を、「前回 s7r1〔別候補 `3f333a83`〕の `gold-s7r1-1` の V-10 は parity が通った後に起きた」に直した。
7. **冒頭のコメント（:1-15）**：s7r2 用に書き直した（既定と取り直しの違い、前回候補の Gold は手開示、s7r1 からの変更点）。

## C. 意図して `s7r1`／`3f333a83` を残している行

`grep -n 's7r1\|3f333a83' s6-aggregate.mjs` が出す行は 8・9・10・14・34・81・206・230・259・260・273 の 11 行で、すべて意図したもの（recompute-trace-*.mjs には 0 行）：

- :8-10・:14 の冒頭のコメント（前回との関係の説明）。
- :34 の `PREVIOUS_CANDIDATE`（前回候補の 40 桁と run 名）。
- :81 のコメント（「件数は s7r1 では 3 だった」。取り直しのときの `goldPrior` の件数を固定しない理由）。
- :206 の parity の `note`。
- :230 の `gold1Disclosure` の note（「前回 s7r1 の別候補の Gold は previousCandidateGoldDisclosure」）。
- :259・:260・:273 の 3d の開示欄（コメントと note）。

いずれも「前回候補の事実」を指す。

## D. 触れていないもの（意図）

- 閾値・期待値・Gold・Q と U の定義・pool の選び方・失効の読み・K6/6 の値・束縛の照合（31 件）・SOURCE_PINS の 3 点照合・G-01 診断の束縛・trace の K6/2 と K6/4 の並べ方・C7 の開示。s7r1 の script と同じ。
- `selectReceiptsForAggregation` の期待（28 included、除かれるのは trace 2 件）。
- `recompute-trace-*.mjs` は vitest（keep test）を走らせるので、**全 run が終わった後の窓の外でだけ**実行する（手順書 §6.1）。

## E. run の後の実行の順（メモ。ここでは実行しない）

```
# contracts の worktree で（fast-forward 後）。Node は s7r1 と同じ（fnm の既定。Node 24）
SC=$CR/$REC/s6-aggregation-s7r2; mkdir -p $SC/scripts; cp <drafts>/s6-aggregation-s7r2/scripts/*.mjs $SC/scripts/
cd $W && mkdir -p $S/keep-log
node $SC/scripts/recompute-trace-base.mjs
node $SC/scripts/recompute-trace-k64.mjs $S/keep-log $SC/trace-k64-recompute.json
node $SC/scripts/s6-aggregate.mjs > $SC/s6-aggregation.json                       # 既定（Gold の取り直し無し）
# GOLD_RUN=gold-s7r2-2 node $SC/scripts/s6-aggregate.mjs > $SC/s6-aggregation.json   # 取り直したときだけ
(cd $SC && sha256sum s6-aggregation.json trace-k64-recompute.json > files.sha256; sha256sum scripts/*.mjs >> files.sha256)
```
