# G-04 fixture v2（案 C）の B2a（宣言 addendum v2、S2 validator の freeze.v2 への向け直し、定数、分類）の独立コードレビュー（2026-11-01）

**ユーザーの確認ではない**。別の agent（Opus、read-only）による独立コードレビューの記録。対象は worktree `claude-g04-v2c` の B2a の 10 commit（`7635e880`..`a7679acd`）。

- 判定：**(b) 修正してから受入れ可**。P1 なし。B2a の実装（宣言 addendum v2、K2/4 の 5 件目、観測後の行の検査、freeze.v2 への向け直し）は正しく、迂回路は見つからなかった。「修正してから」は DR-CP4-G4-7 に trace 2 file への連鎖の記述が無いこと（P2-1）。
- 宣言の値：`g04-lio-landing` の行（reading 20／100、excerpt [0,211)、veto なし）は、fixture v2 と K2/4 の規則（:391、:399、:294-299）だけから、G-02／G-07／G-08 と同じ方法で導き直して一致。v1 の addendum の bytes は不変。
- 変異：49 個中 46 個が落ちた。通った 3 個はどれも P3（確認の `question`／`answer` が照合されない、宣言する Scene の A1 を validator が確かめない〔既存の穴〕）。v1 の 4 件の検査は弱まっていない。
- 落ちる 30 件：実行して一致（119 件中 89 pass／30 fail）。原因は 8 種類の参照ずれと、試験の補助 `draftOf` の TypeError 13 件だけで、別の種類の失敗や件数の増加はない。分類の訂正（P3）：(a) だけ 22、(b) だけ 4、両方 4。
- 新しい版の 2 文書（seed-pin addendum、G-01 の setup addendum）：参照だけを v2 に直した写しで両 validator の誤りが 0。内容は変わらないのでユーザーの確認は要らないとの判断（integrator も同意）。P2-1：`SEED_PIN_ADDENDUM_PATH` を変えると frozen の trace 2 file が落ちる→integrator の判断で (ii)「trace の検査で v1 と現行の両方を受ける」。P2-2：SP/1 は改版の条項を持たない→DR に SP-N8 の読み替えを明記。
- 不変：fixture v2 の sha256、v1、freeze.v1、addendum v1、S2、作者の宣言、S4、trace、setup・seed-pin の addendum、K2/4、SP/1 は基点 `8187fbfc` から差分が空。
