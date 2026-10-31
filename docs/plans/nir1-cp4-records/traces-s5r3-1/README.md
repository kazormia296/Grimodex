# ⑤ trace（新候補 `0b1984dd`、run `trace-editing-s5r3-1`／`trace-browsing-s5r3-1`）の記録：2 件とも完走したが無効

2026-10-31（UTC）に integrator が実行した、CP-4 の ⑤ の (b) trace（`trace-runner.mjs`、frozen、`--trace-kind editing|browsing`）。④ SP-P4、⑤ parity、Gold、negative の後に、同じ候補・同じ S4b'（`9f52e7da`）で取った。**測定は走り切ったが、受領書の status は 2 件とも `invalid`**。製品の応答が途絶えた（stall）のではなく、trace の記録の検査が harness 側の理由で通らなかった。

## 結果

| run | 台帳 | 受領書 `status` | `attemptOutcome` | 無効の内訳 |
|---|---|---|---|---|
| `trace-editing-s5r3-1`（12:19:32Z〜12:35:30Z） | completed | invalid | completed | counted 201 件の**全行**が `rowError`（`the Native records are not aligned: 201 seeded begins, 202 records`）。K6/4 の無効 603 件（snapshot の記録なし 201、開始時の A3 の記録なし 201、N16 hook consumer 経由でない 201）、K6/2 の無効 402 件（snapshot 201、A3 201）。 |
| `trace-browsing-s5r3-1`（12:35:52Z〜12:39:35Z） | completed | invalid | completed | counted 201 件（outsideQ 200 が completed、nonCompleted 0）。**K6/4 だけ無効 201 件**（`DR-CP4-F-6: … matched F6 on another unit than the materials' Revisions`）。**K6/2 は `valid`**（無効 0）。 |

- 台帳の sha256：editing 開始時 `a71429435cd47d81e3a922cd69b6fa323c5526071497da2478588a3a790cd0c3`（contracts `1ab700f7`）→ 終了後 `47f19d300a24cd400d2e408948acd5cf18b4fc4625bccffb32cbbfd647ad38a2`、browsing 開始時 `1f669c05ea10c8413f8b5665e428ab3a7bf998a1fbae3816c4b3e87ac60366c5`（`0f1ea04c`）→ 終了後 `cb4bb3cb71132ba6ecf5bac2d1dc4426f5fc0e4ba2b44f78b45256d65d498578`。受領書・run-report の sha256 は `files.sha256`。
- `problems` は空、`defects` は空、`stalled: null`、`statusReasons` は空。

## 原因（integrator の読み。コードを読んで確かめた範囲）

1. **editing：Native の記録が 1 件多い（整列の検査）。** `alignSeededBegins`（`trace-record.mjs:505`）は、renderer が観測した seeded な `related_scenes_begin` の件数と Native の記録の件数の**完全一致**を要求する。renderer の呼出し 201 件に対し Native の記録が 202 件。renderer の呼出しの間隔と Native の `tBeginNs` の間隔を比べると、**最後の 1 件（seq 202、`begin: unavailable`、slot は `suspended`、直前の記録の 5.2 秒後）を除いたときだけ**平均ずれが 1.44 ms で揃う（次点は 27.45 ms）。最初の 201 件は renderer の 201 件に対応しており、**余分な 1 件は最後の counted query の後に出た記録**（`trace-editing-extra-native-record.json`）。この 1 件で整列が壊れ、全行が defect row になり、snapshot／A3／hook consumer の欄が空になった。製品が最後の操作の後に 1 回 begin を出したのか、観測の窓が閉じた後の記録を harness が除いていないのかは、この記録からは区別していない。
2. **browsing：F-6 の「Revision 単位の一致」が trace の経路に配線されていない。** K6/4 の時代の検査（`availability.mjs:864`）は、子の follow-up の `contributionBasis` が `material-revision` であることを要求する。Gold の runner（`frozen-k64-run.mjs:1900`）は `materialRevisionResolver` を sample の記録に渡すが、trace の経路（`trace-record.mjs`、`trace-runner.mjs`、`trace-frozen.mjs`）には resolver が無く、`k64-record.mjs:contributionOf` は resolver が無いと Scene 単位の preview（`scene-level-preview`）を返す。そのため、**子の follow-up がある全 query が K6/4 で無効になる**。K6/2 の検査にはこの規則が無いので valid。
3. どちらも**製品の振る舞いの結果ではなく、trace の経路の harness の不備に見える**。ただし 1 は製品側の末尾の begin の可能性を残し、**#768（IR の経路の短縮）が原因かは、旧候補での同じ trace を取っていないので未確認**（trace を正式に取ったのは今回が初めて）。

## 取り直しの可否（規則）

- trace の file の `stall.attemptRule` と `trace-frozen.mjs:268` は、取り直しを **stall した試行**にだけ認める（`attempt N ended <outcome>; only a stalled attempt is retaken`）。今回は `attemptOutcome: completed`・`stalled: null` なので、**同じ入口で 2 回目は取れない**。
- 直すには harness（`trace-record.mjs`／`trace-runner.mjs` など。S2 の bytes の pin に入っている）の変更が要り、S2 の pin のやり直しと S4 の凍結のやり直しになる。**Graph arm の観測（Gold、negative）の後の harness の変更は、ユーザーが 2026-10-31 に確認した再凍結の範囲に含まれない**（`user-confirmation-2026-10-31-refreeze.md`）。ユーザーの判断に回す。

## 運用上の記録

- 1 回目の起動（12:17Z）は、trace-runner の `parseArgs` が `procedure-version` を `draft-1`、`procedure-commit` を `HEAD` に既定する（`trace-frozen.mjs` の `?? "v1"`、`?? prep-commit` の fallback を隠す）ため、`[precheck] … is a draft` で 2 秒後に止まった（`trace-editing-s5r3-1.precheck-draft.log`。台帳は作られず試行は消費していない）。以後は `--procedure-version v1 --procedure-commit 9f52e7da…`（Gold が使った版と同じ）を明示した。2 回目の起動は、1 回目が残した run ディレクトリへの `EEXIST` で止まった（台帳なし）。残りのディレクトリは `.artifacts/cp4/abandoned/trace-editing-s5r3-1-precheck-draft/` へ退避した。3 回目の起動が上の 2 件。
- 候補 `0b1984dd68ec132aea394664e2ba61759e1e2830`、`--prep-commit 9f52e7da…`、`--k62-commit af643a93…`、`--k64-commit 5dea38af…`、`--setup` は G-02/base の完全な setup、`--sp-p4-receipt` は `sp-p4-s5r3-1/sp-p4-receipt.json`。trace-runner は `--keep-test-worktree` を受けない。機械は開始前に 3 回連続の静けさを確認。
