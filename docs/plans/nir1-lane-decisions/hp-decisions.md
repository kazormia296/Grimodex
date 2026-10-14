# HP-1 decisions

## D1 nir1_generation_history.rs の test fixture だけを最小更新する（confidence 70）
- 判断: `GenerationHistoryReadBudget` に turn 共有の SQL ledger と project-authority 行台帳を
  field として追加すると、`nir1_generation_history.rs` の `adapter_tests::budget()` の struct literal
  がコンパイルできなくなり、受入れの `cargo test ... nir1_generation` と `clippy --all-targets`
  が通らない。そこで当該 test fixture に新 field の値（十分な SQL 予算、行台帳 0）だけを足す。
- 信頼境界: 資格 gate（7種の扱い）、reauthorize の本体、AttemptBinding、schema は変更しない。
  製品経路（reauthorize_from_generation_snapshot）は signature 不変で、caller_budget を
  そのまま渡す。未指定の SQL 予算は fail-closed（SQL 前に拒否）なので、製品側で予算を
  設定しない限り history 読取は起動しない（A-1：製品入口は閉じたまま）。
- 代替案: (a) snapshot 関数に別引数で SQL 予算を渡す → 製品と test の呼出し両方を変える必要が
  あり差分が広い。(b) field を足さず thread-local 等で渡す → caller 所有の明示性を失う。
  どちらも採らない。
- 許可ファイル外の編集はこの fixture の数行に限る。

## D2 lifecycle / egress
- subprocess・background・async・egress は変更しない。既存の participant bounded read
  transaction（busy_timeout の適用・復元、rollback、接続 cleanup）と既存の capacity scope を
  組み合わせるだけなので、新しい owner/lifecycle matrix は不要。

## D3 PostToolUse の rustfmt が crate 全体を整形した件
- Edit 後の hook が grimodex-db 全体に rustfmt をかけ、無関係な 40 ファイルが整形差分になった
  （master は rustfmt 未整形の箇所を含む）。内容は整形のみと確認し、各ファイルを
  `git show HEAD:<path>` で HEAD の内容に戻した（git checkout は拒否されたため）。
  最終差分は許可 3 ファイル + D1 の fixture の 4 ファイルだけ。最終の test/clippy/build は戻した後に実行。
