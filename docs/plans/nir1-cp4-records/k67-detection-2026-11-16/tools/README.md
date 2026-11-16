# 9 回目の S4 の検出力の道具（候補 `c3209e1d`。2026-11-16）

`hook.mjs`、`register.mjs`、`run.mjs`、`count-n.mjs` は `../../k65-detection-2026-11-08/tools/` と同じ bytes。変異の当て方は同じで、変異の一覧・対象の試験・陽性の対照を引数にする。変えたのは次のとおり（詳細は各記録）。

- `mutations-spn.json`（23）、`mutations-k65.json`（23。C7 の 9 件を含む）：期待の行を今の試験の行に取り直しただけ（題は同じ）。
- `mutations-k66.json`（51）、`mutations-k66-addendum.json`（28）、`mutations-k66-qv3.json`（48）：stamp の変異 3 件の廃止、`K66-FR3-ticket` の K6/7 への移動、`QV3b-P32-branch` の find の当て直し、期待の写し直し。
- `mutations-k67.json`（core 38）、`mutations-k67-v3.json`（品質判定 v3 45）：新設。`expectedRewritten: true` は最初の run の結果から期待を写し直した変異、`gapTest: true` は検出力の欠けに試験を足した変異（`c3209e1d`）。
- `positive-*.json`：陽性の対照（行は題で引いた）。`positive-k67.json`・`positive-k67-v3.json` は新設。

使い方（各組の `--targets` は記録の「実行」の節の baseline の command）：

```
node run.mjs <候補の worktree> --mutations mutations-spn.json --positive positive-spn.json          # SP-N（全体の baseline も走る）
node run.mjs <候補の worktree> --mutations mutations-k65.json --positive positive-k65.json --targets admission.test.mjs,followup.test.mjs,followup.k66.test.mjs,k64-record.test.mjs,procedure-file.test.mjs,quality-verdict.test.mjs,receipt.test.mjs,trace-record.test.mjs --no-full
node run.mjs <候補の worktree> --mutations mutations-k66.json --positive positive-k66.json --targets followup.k66.test.mjs,outcome.test.mjs,receipt.test.mjs,admission.test.mjs,quality-verdict.test.mjs --no-full
node run.mjs <候補の worktree> --mutations mutations-k66-addendum.json --positive positive-k66-addendum.json --targets followup.k66.test.mjs,quality-verdict.test.mjs --no-full
node run.mjs <候補の worktree> --mutations mutations-k66-qv3.json --positive positive-k66-qv3.json --targets followup.k66.test.mjs,quality-verdict.test.mjs,quality-verdict-first-run.test.mjs,pubg16-e2e-run.test.mjs --no-full
node run.mjs <候補の worktree> --mutations mutations-k67.json --positive positive-k67.json --targets followup.k66.test.mjs,native-sample.test.mjs,availability.test.mjs,outcome.test.mjs,receipt.test.mjs,admission.test.mjs,followup.test.mjs,run-sample.test.mjs,k64-record.test.mjs,trace-record.test.mjs --no-full
node run.mjs <候補の worktree> --mutations mutations-k67-v3.json --positive positive-k67-v3.json --targets quality-verdict.test.mjs,quality-verdict-first-run.test.mjs,evidence-fields.test.mjs,receipt.test.mjs --no-full
node count-n.mjs <baseline-all.tap> <候補の worktree> --out counts.json
```

候補の file は書き換えない。変異は hook が読込み時に 1 か所だけ置換し（当たった数が 1 でなければ読込みを失敗させる）、その変異の試験 file だけを走らせる。
