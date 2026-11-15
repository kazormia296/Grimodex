# ユーザーの回答の記録：PR-3 の 2 回目の 3 問（Q5〜Q7）（2026-11-16）

- 材料：`/home/grimodex/fusion-eval-data/cp4-dev-latency-ratio-2026-11-15/formal-run-prep/drafts/pr3-questions.md`（contracts の外）
- 1 回目の 3 問（Q2〜Q4、2026-11-15）と K6/7 の確認（`user-confirmation-2026-11-15-k67-graph-eval-procedure.md`）の後に伺った。
- 経路：Claude Code の AskUserQuestion。

## Q5：次の S4（9 回目）の再凍結の進め方

### 質問の要旨

- 今の S4b `f2f99b13` を失効させ、新しい S4b の下の run だけを許可する。
- PR-3、DR-DBC-4 の検査器の直し、not-evaluable の記録の拡張の 3 つを、この S4 にまとめる。
- 手順は S4a → S3 → ①〜⑧ → S4 の枝だけを merge commit で入れる。
- 前例どおり、失効と再凍結を個別の確認で進めてよいか。

### 回答

**「前例どおり (Recommended)」**

失効と新しい S4b の許可は、凍結の前に個別に確認する。この回答は、手順の進め方の承認であり、失効そのものの確認ではない。

## Q6：not-evaluable の記録の保存範囲

### 質問の要旨

- 記録に残すのは、範囲（UTF-16 の位置）、hash、ID だけにする。
- 本文の抜粋は残さない設計にする。
- 本文が必要になったら、保存範囲の拡大として改めて伺う。

### 回答

**「範囲・hash・ID だけ (Recommended)」**

## Q7：PUB-G #15（s7r2 の合格を、PR-3 の後の候補に持ち越せるか）

### 回答

**「次の S4 の run を正とする (Recommended)」**

### 読み

- 持ち越しはしない。
- PUB-G の判定には、次の S4 の下の正式 run（K6/7）を使う。
- s7r2 は参考として開示する。
- PUB-G の前提一覧（`pubg-prereq-inventory-2026-11-03.md`）の #15 に、この規則を書く。

## 日時

- 2026-11-16（UTC）、回答の直後に読んだ時計の値。正確な値は commit の時刻を見る。
