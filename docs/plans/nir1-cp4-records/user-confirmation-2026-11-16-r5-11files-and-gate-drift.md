# ユーザーの回答の記録：R5 の閉包の拡大（11 file）と、dev gate の drift_at_query 1 件（2026-11-16）

- 経路：Claude Code の AskUserQuestion（2 問、1 回）
- 日時：2026-11-16T08:59Z ごろ（回答の直後に読んだ時計の値）
- 関係する記録
  - `user-confirmation-2026-11-16-refreeze-9th-and-r5.md`（`7a03eaf9`）の問 B の条件「10 file の外が変わっていたら及ばず、改めて伺う」
  - `user-confirmation-2026-11-16-pr3-dev-gate.md`（`235e0c67`）の 3 回目

## 問 1：R5 の閉包の拡大

- 質問の要旨
  - 閉包は 43 file から 44 file に増え、変わる file は 11 file になった。
  - 増えたのは、項目 C で新設した `evidence-fields.mjs` の 1 file。`receipt.mjs` がこの file を import している。
  - この file がするのは、evidence の field の形の検査と、本文の平文の混入の拒否だけ。seed の規則と pin の読み戻しの経路には触れない。
  - 正式 run の各 variant が seed を自分で検査すること（X7・X12）は変わらない。
- 回答：**「11 file で前回の記録を使う (Recommended)」**
  - 使う記録は、R5 の記録 `56d4ec54` と確認 `82119012`。
  - 凍結の直前に閉包を再計算する。11 file の外が変わっていたら、改めて伺う。

## 問 2：dev gate の 3 回目の drift_at_query 1 件（前の質問文で伝えていなかった事実）

- 質問の要旨
  - `hd-g03h2`（head）の受領書の `checks.process.ownerReady.diagnostics` に、`driftAtQuery: 1` があった。測定の前の準備の段の値で、measured の sample では 0 件。
  - 3 回の gate と probe-gc の全受領書を調べた結果、この種類の記録は head のこの 1 件だけ。base では、この記録も `stampStale` も 0 件。
  - 古い Graph を返した記録ではなく、worker が drift を検出した記録。
  - 重なった commit は、まだ特定していない。
  - gate が名指す指標で、件数は head 1、base 0。
  - 3 回目の「悪化なしとして進める」は、この事実を示さないまま伺っていた。
- 回答：**「判断は変えず、重なった commit だけ調べる (Recommended)」**
  - 受領書と DB を読んで、重なった commit を特定し、DR-DBC-7 に書く。新しい測定はしない。
  - 古い Graph を返す経路が見つかったら、止まって伺う。

## 範囲

この回答に含まれないもの：閾値の緩和、Gold・fixture・契約の変更、製品の公開・PUB-G の承認、正式 run の開始。
