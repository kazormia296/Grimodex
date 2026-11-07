# K6/5・C7 と SP-N の合成の検出の道具（6 回目の S4、S3 の M2。2026-11-07）

`hook.mjs`、`register.mjs`、`run.mjs` は contracts の `sp-synthetic-detection-tools-2026-11-02/` から持ってきた（`hook.mjs` `e5732d01…`、`register.mjs` `5f651fff…` は同じ bytes。`run.mjs`〔元は `d47f41d5…`〕は、変異の一覧・対象の試験・陽性の対照・等価の変異を引数や欄にしただけで、変異の当て方は同じ）。

- `mutations-spn.json`：SP-N の 23 変異（元の `mutations.json` と同じ置換。SP-N12 の 2 件の期待の行だけ、`receipt.test.mjs` の行が動いたので 997→1087）。
- `mutations-k65.json`：K6/5-N1〜N4、K6/5-P1、C7 の 23 変異（今回足した）。`equivalent: true` の 2 件は、置換しても判定が変わらない等価の変異で、試験が落ちないことが期待（理由は各行の `equivalentReason`）。
- `positive-k65.json`：陽性の対照（K6/5-N1〜N4、P1、C7 の題を持つ 14 件。baseline で ok であること）。
- `count-n.mjs`：全体の TAP から K6/4-N1〜N40、K6/5-N1〜N4、K6/5-P1、C7 の試験を数える。

使い方：

```
node run.mjs <候補の worktree> --mutations mutations-spn.json                               # SP-N（対象の試験は seed-pin-setup／seed-pin／receipt。全体の baseline も走る）
node run.mjs <候補の worktree> --mutations mutations-k65.json --targets <a.test.mjs,…> --positive positive-k65.json --no-full
node count-n.mjs <baseline-all.tap> <候補の worktree> --out counts.json
```

候補の file は書き換えない。変異は hook が読込み時に 1 か所だけ置換し（当たった数が 1 でなければ読込みを失敗させる）、その変異の試験 file だけを走らせる。

**期待の決め方（開示）**：`mutations-k65.json` の `expected`（落ちるべき試験の file・行・題の先頭）は、変異を当てる前に決めたものではない。最初の run（`expected` が空）で落ちた試験を見て、各変異と落ちた試験の題が対応する（例：`C7-graphOutcome` は「外す条件を 1 つでも満たさない begin」）ことを確かめた上で `expected` に写し、変異 `C7-irStatus` が生き残ったので、C7 の試験に variant を足してからもう一度走らせた。結果の `verdict` はその 2 回目の run のもの。
