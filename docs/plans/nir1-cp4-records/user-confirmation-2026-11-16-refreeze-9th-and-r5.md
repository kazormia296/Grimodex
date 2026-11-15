# ユーザーの確認の記録：次の S4（9 回目）の失効・作業の範囲・R5 の記録（2026-11-16 JST）

- 経路：AskUserQuestion（3 問）
- 日時：2026-11-15T17:40Z ごろ（直後に読んだ時計の値）
- 材料：`/home/grimodex/fusion-eval-data/db-stage1-pr3-2026-11-15/s4a-draft.md` の §3・§4（contracts の外）

## 問 A：失効と新しい S4b の許可

質問の要旨：

1. 今の S4b `f2f99b13`（7 回目）の freeze record を削除し、S2 を draft に戻す。失効の commit は S4 の枝に置き、既定の枝の凍結は PR を merge するまで変わらない。
2. s7r1・s7r2 は判定に使わず、履歴として残す。
3. S6 の許可リストは、新しい S4b と新しい候補の組だけにする。
4. 新しい S4 には次の 3 つを入れる。
   - PR-3
   - DR-DBC-4 の検査器の直し
   - evidence 4 件の記録の拡張
5. 閾値・Gold・fixture・契約は変えない。

回答：**「失効して進める (Recommended)」**

## 問 A′：作業の範囲

質問の要旨：どこまでを一括で進めてよいか。正式 run の開始は、どちらの選択肢にも含めない。S3 や検出力の記録で設計の前提が崩れたら、止まって伺う。

回答：**「S4 の PR の merge まで一括 (Recommended)」**（5 回目の前例と同じ形）

## 問 B：R5 の記録（Q9）

質問の要旨：

- 閉包 43 file のうち、10 file が変わる（既出 7、新規 3：native-sample、native-architecture、architecture）。
- seed の規則と pin の経路の file は変わらない。
- 製品は 509 commit 進んでいる。
  - pin の表に write clock の trigger が入った。
  - そのほかの変更は、全部は読めていない。
- 正式 run の各 variant は、seed を自分で検査する（X7・X12）。
- 凍結の直前に閉包を再計算する。10 file の外が変わっていたら、この確認は及ばず、改めて伺う。

回答：**「前回の記録を使う (Recommended)」**（R5 の記録 `56d4ec54`、確認 `82119012`）

## 範囲

この確認に含まれないもの：

- 製品の公開・PUB-G の承認
- 閾値の緩和、Gold・fixture の変更
- 新しい送信先、保存範囲の拡大
- 契約・authority の新設
- 正式 run の開始（別に確認する）
