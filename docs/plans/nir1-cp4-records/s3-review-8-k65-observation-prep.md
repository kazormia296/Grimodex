# S3 の 8 回目の独立レビュー（6 回目の凍結のやり直し。K6/5。2026-11-07）の記録

**この file の出所**：S3 の独立 reviewer（Opus の agent）の報告の原文は repo に無い。次の本文は、integrator が S4 の builder（Claude の agent）に渡した指示書に書かれていた指摘を、builder が写したもの（7 回目の `s3-review-7-observation-prep.md` が「integrator が会話の記録から書き起こした原文」としたのと同じ型。ただし 7 回目と違い、この写しは原文から書き起こしたものではなく、指示書からの再写し）。判定の語は指示書に無く、blocker を含むので、builder は `changes-required（blocker 1、major 2、minor ほか）` と読んだ。reviewer は agent で、人間ではない。S3 のレビューはユーザーの確認ではない。

## 対象

- PR #827（枝 `claude/k65-harness`）の head `280ff921621e51cf6d814ba37551ac76d3d1fc39`。S2 追補 #14（`6aad102d`）、S4a（6 回目。`b852debd`）、DR-CP4-P-9／S4-9（`280ff921`）。
- 見ていない範囲：反映後の bytes（S2 追補 #15 以後）。S3 は反映を見ていない。

## 指摘

### B1（blocker）C7 と G-01 の admission の新しい経路にユーザーの確認が無い

S2 の `k65Readings.limits (d)`、作者の宣言の `g01-e2e-diagnostic-decision`、DR-CP4-P-9 の除外欄が、C7 と G-01 の経路を「問 5（問 3）の範囲」と書いている。問 3・問 5 は手順の起案（irw3）の指示で、ユーザーの確認ではない。確認を取り、その記録を根拠に書き直す。S2 の `userConfirmations` の扱い（draft では review が null で置けないので `contracts.k65.confirmation` に置き、S4b で review に入れる）に合わせて、この確認も同じ場所に入れる。

### M1（major）K6/5 の変える点 7 と、R5 の候補の後の製品の変更

K6/5 の変える点 7 は K6/4 :317（R5 は凍結の前）を /5 の bytes で読む。① は 2026-11-02 で、/5 の凍結（`07fc80ec`、2026-11-07）より前なので順は満たす、と S2 (g) と DR-CP4-S4-9 (7) に /5 も挙げて書く。① の候補 `179139b4` の後の製品の変更（#777、#782、#793、#797、#802、#811、#814、#817、C1＝#824。seed の規則の file `src/features/related-scenes/nir1GraphSeed.ts` は不変）を開示する。閉包の file 数の食い違い（`ac2e93d6` は 43＝静的 42＋dynamic import 1、S2 は 42）を正す。

### M2（major）K6/5 の受入れ N1〜N4・P1 の検出力の記録が束縛されていない

K6/5 の受入れ N1〜N4・P1（C7 の例を含む検出力の記録）が、S2 の placeholder でも phase でも束縛されていない。K6/4 の検出力の記録（SP-N。前回は `8edd6496`。DR-CP4-S4-8 (6) と残る穴 (h)）を、C7 と K6/5 の例を足して S4b の中で取り直し、S2 の placeholder と S4b の門で束縛する（record の path と sha256）。取り直しの手順は前回の SP-N の記録と DR を正本にする。

### minor

- (f) `a1492815` では `followup.mjs` だけでなく `trace-record.mjs` も pin から外れている。開示を直す。
- (e) 凍結の前に見た観測は 3 つでなく、LAPSE-4 の dev の診断と QV-1 の s5r6 の p95 も含む。R-4（p95 の上限 94.2 ms）を選ぶ前に s5r6 の p95 を見ていたことを S2 に書く。p95 を判定する quality-verdict が pin の外であることも書く。
- validator：TP-1 の C7 の語、G01 の `notCountedAs` の残り 2 つ、確認の記録の SHA-256 の値、frozen のときの K6/5 の `userConfirmations`、K6/5 の凍結の commit が祖先にあること、を検査し、変異つきの試験を足す。
