# ユーザーの回答の記録：setup の静止の直しを 9 回目の S4 に入れることと、PUB-G の (A) 8 件への着手（2026-11-16）

- 経路：Claude Code の AskUserQuestion（2 問、1 回）
- 材料（contracts の外）：`/home/grimodex/fusion-eval-data/db-stage1-pr3-2026-11-15/setup-quiesce-design.md`、`pubg-remaining-triage.md`

## 問 1：setup の静止

- 質問の要旨
  - setup が、maintenance の実行中に DB を写すことがある（dev gate の drift 1 件の原因）。
  - 直し方の案は次の 3 つの組み合わせ。
    - (B) 静止を待つ。待ち切れなければ session を開き直す。
    - (A) それでも静止しなければ止める。
    - (C) 測定の入口で、running の行がある DB を弾く。
  - pin される harness の file が変わるので、今が最後の機会。後に回すと、凍結と正式 run をもう 1 回取り直すことになる。
  - 閾値の緩和ではなく、止まる場合が増える厳しくする向きの変更。
- 回答：**「今回の S4 に入れる (Recommended)」**
  - 範囲には、dev での効果の確認 1 回と、DR-CP4-L-27 の「記録だけ」を「止める」に変えることを含む。

## 問 2：PUB-G の前提の (A) 8 件

- 対象：#6、#30、#48、#32、#35、#38、#41、#5
- 回答：**「着手する (Recommended)」**
  - 1 件ずつ別の枝で PR にし、merge まで進める。
  - 公開・有効化はしない（定数は false のまま）。
  - #5 は編集の前に precheck を当てる。
  - 途中でご判断が要るものが出たら止める。
  - 一覧の古い記述 3 か所も直す。

## 範囲

この回答に含まれないもの：

- 製品の公開・PUB-G の承認
- 閾値の緩和、Gold・fixture の変更
- 新しい送信先、保存範囲の拡大
- 契約・authority の新設
- 正式 run の開始
