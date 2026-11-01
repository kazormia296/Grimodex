# ユーザーの確認の記録：X1 /2 の選択、G-04 の扱い、索引時強化の spike（2026-11-01）

この file は、ユーザーが AskUserQuestion の回答として行った**確認**を原文のまま残す記録。直前の説明（X1 /2 の要点、SHA-256、G-04 の見立て）は会話の記録にあり、ここには回答と、integrator の範囲の読みだけを書く。

## 確認した内容

- 日時：2026-11-01（JST）。経路：Claude Code のセッションの AskUserQuestion（3 問）。
- **質問 1**（X1 /2。draftRef `nir1-scene-scope-projection-proposal/2`、contractId `scope-storage-authority`、SHA-256 `0282f639264958998ea7c70c73e8faf172efdf2ab3ac6e3e2f05f0d14b735761`、branch `claude/x1-proposal-2-draft` の commit `a0553c76`）。選択肢：「推奨のまま確認する(推奨)」「(a)-1b も今含める」「確認せず保留する」。**回答（原文）：「(a)-1b も今含める」**。
- **質問 2**（G-04/base。前提条件 raw-membership が成り立たず、可用性の pool で 30/30 欠落）。選択肢：「β: fixture を新しい版に(推奨)」「α: pool から外す」「現状のまま」。**回答（原文）：「β: fixture を新しい版に(推奨)」**。
- **質問 3**（索引時強化のオフライン spike）。選択肢：「進めてよい(推奨)」「今はやらない」。**回答（原文）：「進めてよい(推奨)」**。

## 確認の範囲（integrator の読み）

1. **質問 1 は X1 /2 の確認ではない。** 回答は「(a)-1b を今含める」で、/2 は (a)-1b を今選ぶ場合は /3 を起案して /3 に対して確認を取ると定めている（/2 の「確認の扱い」、(a) の表）。したがって、`nir1-scene-scope-projection-proposal/2` は**確認されていない**。integrator は (a)-1b を含む `nir1-scene-scope-projection-proposal/3` を起案し、独立レビューを通し、SHA-256 を計算して、改めてユーザーに確認を求める。確認の前に、製品の code、`scope-storage-authority`、閾値、評価の規則を変えない。/2 の他の選択（(b)-1、(c)-1、(d)-1、(e)-1 の推奨）については、ユーザーは異議を述べていない。ただし、回答は (a) についてだけで、(b)〜(e) の確認は /3 に対して改めて取る（確認していないことを確認済みと記録しない）。
2. **質問 2 は方向の確認。** G-04/base の fixture を、基準（IR floor、Raw gate）の下で前提条件が成り立つ新しい版にする（Raw の予測と IR の条件を直す。正解の場面〔Gold〕と閾値は変えない）。独立した期待値レビュー、凍結前の admission probe の必須化、S2 の追補と S4 の再凍結、測定のやり直しを経る。新しい版の中身（期待値の変更）は、独立した期待値レビューを通した後、ユーザーに示す。α（pool から外す）は採らない。
3. **質問 3 は、提示した範囲での spike の承認。** G-04 の正解の場面に想定質問・関係文を手書きで 2〜3 本作り、質問との cosine を `/tmp/onnxprobe` の既存の方法で測る。製品・fixture・harness は変えず、測定に数えない。

## 関連する記録

- `s6-aggregation-s5r4/g04-cosine-probe.md`（G-04 の診断）、`s7-report-s5r4/README.md`、`user-confirmation-2026-11-01-lapse-scope.md`（編集中の失効の方向）、`lapse-case2-design-investigation-2026-11-01.md`。
