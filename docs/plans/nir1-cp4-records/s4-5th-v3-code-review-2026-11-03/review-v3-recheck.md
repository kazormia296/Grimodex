# G-01 setup addendum v3 の修正差分の再確認（read-only）

- reviewer: 前回のレビュー（`review-v3.md`）と同じ Claude の subagent（Opus、read-only）。人間のレビューでも、ユーザーの確認でも、S3 でもない。Graph の runtime は実行しておらず、測定の受領書は読んでいない。repo の file は変えていない。
- 対象: worktree `/home/grimodex/worktrees/Grimodex/claude-cp4-s4-5th`、HEAD `7b128636`（親 `0d456ee2`）。commit が変えたのは `evals/nir1-g01/setup-addendum.v3.json` だけ（`git diff --stat HEAD~1 HEAD`。11 行足して 9 行消した）。worktree は clean。
- SHA-256: 新しい v3 は `5578c52684ffdb8165ed9bc367fefd616070043a97403c93daea77d244ba8e0f`、前回の v3（`HEAD~1`）は `54b69bc2…`。v2 は `fd6b0c3c…`、v1 は `ade7c402…` で、どちらも変わっていない。
- 実行したこと（Node 24.18.0）:
  - 旧 v3 と新 v3 の葉の比較（`rv/leafdiff.mjs`）
  - 新 v3 を v2 に読み戻した deep equal の確認（`afterMutationReadings.status` も戻す）
  - sealPoints の各部分の一致の確認
  - `prettier --check`（通る）
  - G01 の 4 定数の `950751d0` と HEAD の比較
  - `git show a7027915:docs/plans/nir1-cp4-records/user-confirmation-2026-11-01-g04-v2c-build.md`（sha256 `1de09724…`。確認の記録で、受領書ではない）の該当行の確認
  - 試験は走らせていない（harness の file は変わっていないため）

## 旧 v3 からの変更（葉の全件）

- 変わった葉: `supersedes.rule`、`afterMutationReadings.status`、`resealAfterMutation.rule`、`measurementPointDefinition`、`sealPoints.bodyOnlySave.freshnessSettle.limit`／`interval`、`records.rule`、`limits[0]`。
- 足した葉: `limits[6]`（vii）と `limits[7]`（viii）の 2 つ。
- ほかの葉は旧 v3 と同じ。キーの順も同じ。
- 新 v3 を v2 に読み戻すと一致する（true）。v2 に対して変わった葉は、`supersedes.rule` に挙げた葉だけである（`afterMutationReadings.status` は今回の修正で列挙に足された）。

## (1) P2-1〜P2-4 の反映

- **P2-1（直った）**: (vii) が DR (8) の 5 つ目を書いている。「X1-5（#773、8187fbfc）は S4b'''（60bf9dc4）の基点に入っていたが、封印待ちの前提を X1-5 の下で確かめた記録は、読んだ範囲に無い」は DR の文と合う。後半の「a7027915 の範囲 1 に『X1-5 の候補での再測定』がある」は、記録の :19 にあることを確かめた（真）。ただし、その節の題は「確認の範囲（integrator の読み）」で、ユーザーの回答の文ではない。「計画どおり」も、DR の「評価は書かない」に照らすと評価に近い語である（P3-A）。括弧に挙げた「読んだ範囲」（S4b''' の前の独立レビュー、作者の宣言、最終関門の記録）が実際に無いかは、未確認。
- **P2-2（直った）**: `measurementPointDefinition` は「Chronicle の build の後の最後の判定で current だった B と C の世代」になり、`chronicle.recheckBranch` が鍵になった。
  - 実装と照合した。`reopenUntilSealed` は build の後に `readIndex()` を 1 回読み、同じ `metadata` で `recheckBranch` を判定して `chronicle.metadata` に残す（g01-negatives.mjs:524-540）。`measurementProbe` は最後の entry の `chronicle.metadata` を読む（g01-negative-run.mjs:246-252）。つまり、定義の世代と再判定の世代は同じ読みである。
  - unchanged なら前と同じ世代（`bSealUnchanged` は等号）、new-generation なら前より新しい世代（`bSealPublished` は `>`）で、どちらも真。
  - 「C は usable だけを確かめ、世代が新しいことは確かめない」も真（:525-527）。
  - records.rule の「S7 は sealBranch（最初の判定）と chronicle.recheckBranch（最後の判定）を開示する」も、欄の実装と一致する。
- **P2-3（直った）**: `afterMutationReadings.status` に、DR-CP4-S4-8 で reseal を変えたこと、blocked を見た後の読みの変更であること、S3 は見ておらず独立コードレビューが見ること（ac2e93d6）が足された。`supersedes.rule` にも列挙された。
  - 「値は master 950751d0 の版のまま」は真。G01_CONTROL_ATTEMPTS 60、SAMPLE_ATTEMPTS 60、GRAPH_READY_WAIT_MS 10000、CONTROL_GAP_MS 250 が、`950751d0` と HEAD で同じ。
  - 「独立コードレビューが見た」は、凍結の時に review の欄が埋まって真になる文である。今は review が null なので、凍結の前提として書いている、と読む。
- **P2-4（直った）**: (i) の末尾は「harness が照合するのは Graph の関係の入力…の同一性だけで、B の入力の全体…の同一性はどこでも照合しない」になった。過剰な保証は消えている。言い回しの細部は P3-B。

## (2) 規則の本体

- `sealPoints.restore`、`bodyOnlySave.points`／`operations`／`passes`／`unchangedRequires`、`chronicleRecheck`、`onNeither`、`unchangedConstants`、`sealRule`、`measurementPoint`、`reopensMax`、`waitMs`、`blocked`、`chronicle` は、旧 v3 と bytes が同じ（比較で確認）。
- `freshnessSettle.limit`／`interval` は、定数名に値を添えただけ（「FRESHNESS_SETTLE_WAIT_MS（60000 ms）」「…INTERVAL_MS（250 ms）」）。値は driver の :167-168 と一致し、意味は変わらない（形式は P3-C）。
- `rule` の変更は 2 つだけである。
  - 「どちらの分岐も満たさないとき（静止しなかった開きは (A-1) だけの待ちなので、(A-1) を満たさなければ満たさない）」への言い換え。実装（:208-232）と同じで、「静止しない＝not-published」の誤読は消えた（P3-1 は直った）。
  - 地点名と実装の鍵の対応の追記。N2 は `resave-same-body`／label `measure`（:488 の既定。step は label を渡さない）。N4 の宣言の前は `draft-then-original`／label `before-declaration`（run.mjs:172）で、3 段の操作。N3／N4 の mutation は restore-*。どれも真（P3-4 は直った）。
- 規則の意味は変わっていない。
- 前回の P3-2（null の意味）と P3-3（N3）は records.rule で直った。P3-6 は (viii) で直った。(viii) の「注入が無い呼び出しでは (A-1) だけ」（:200）と「feed の表が読めないと例外で止まる」（readFreshnessFeed の prepare が投げる。mutation の直後の読取り :652-653 と静止の待ちの中）は、どちらも真。

## (3) 新しい誤り・過剰な保証・誤読（いずれも P3。凍結を止めない）

- **P3-A**（vii）: 引用元を「a7027915 の『確認の範囲（integrator の読み）』の 1」と書くと正確になる。「X1-5 を候補に含めたのは計画どおり」は、DR (8) の「事実だけ」に寄せるなら「…の 1 に『X1-5 の候補での再測定』とある」で止めるほうがよい。
- **P3-B**（i）: 「B の入力の全体（metadata、D1、V1、Freshness の authority の上の cache）」は、括弧が B 自身の説明（それらの上の cache）になっていて、入力の列挙として読みにくい。「B（metadata、D1、V1、Freshness の authority の上の cache）の入力の全体」と書くとよい。
  - 「Codex の entry、Relation、pin の id の列」は、実際の digest が type や端点も含むので、狭めの記述である。過剰な保証ではない。
  - 「どこでも照合しない」は、この負例の harness の範囲の否定として読める。
- **P3-C**: `freshnessSettle.limit`／`interval` は、定数名と値の混じった 1 つの文字列になった。#12 で validator が `HARNESS_CONSTANTS` と照合するなら、`limitMs: 60000` のように数値の欄に分けるほうが扱いやすい。凍結の後は変えられないので、分けるなら今。今のままでも誤りではない。

## (4) 判定

**(a) 受入れ可（凍結してよい）。**

- P2-1〜P2-4 は指摘どおり、過不足なく直っている。規則の本体には変更が及んでおらず、v2 への読み戻しも一致する。
- 残るのは P3 の 3 件（A: (vii) の引用元と「計画どおり」の語、B: (i) の括弧の位置、C: 静止の上限・間隔の値の形）で、どれも任意である。
- P3 を直す場合は、変えた葉の目視と v2 への読み戻しの再実行で足り、再レビューは要らない。ただし P3-C で欄の形（キー）を変えるなら、`supersedes.rule` の列挙と #12 の validator の設計に合わせる。
