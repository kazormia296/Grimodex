# Write-Safety Gate A A2：版の列が無い関係の照合（判断記録）

- 状態：技術判断（2026-11-28）。実装は Native の writer まで。製品の呼び手は無い。
- 根拠：確定した [A2 判断記録](gate-a2-approval-decisions.md) の DR-A2-4（Capability を交換する時に対象の `target_basis` を再確認し、対象が変わっていれば出さない）、DR-A2-10（今の経路には照合が無い。読み口と照合を実装で足す）、第 6 節の必須防御（交換直前の basis の再検証、stale basis の拒否）。actor、受信先、保存範囲、受け入れる残りは変えない。
- 対象：`stamp_scene_event`・`unstamp_scene_event`・`add_event_relation`・`remove_event_relation` の 4 本（Native の writer は 2 つ）。紐付けと関係には版の列が無く、今の writer は呼び手が読んだ状態を照らさない。

## 信頼境界

- 期待状態は main が DB から読んだ値で作る。モデルや renderer が渡す版・識別子を根拠にしない（DR-A2-5）。
- Native は、渡された期待状態を書き込みと同じ transaction で照らし、違えば何も書かない。
- Native は渡し手が main かどうかを区別しない。期待状態は書き込みの条件を増やすだけで、許可を増やさない。
- 期待状態の無い呼び出しは今のまま通る。承認を経た書き込みが必ず期待状態を渡すことは、この変更では強制していない。交換の service につなぐ段で、実 main の往復の試験で縛る。

## DR-A2T-1 期待状態の形

- payload の省略できる欄 `expected`。
  - 紐付け：`{ linkIncarnation: string | null, eventVersion: number }`。`linkIncarnation` は `scene_events.incarnation_token` の値そのまま。`null` だけが「関係が無いはず」。古い行の空文字列は「関係がある」。
  - 出来事の関係：`{ related: boolean, causeVersion: number, effectVersion: number }`。`event_relations` は両端の組しか持たないので、外して付け直した関係は区別しない。
- `expected` を渡すときは、全部の欄が要る。欄の欠落と未知の欄は拒む（`linkIncarnation` の書き忘れを「関係が無いはず」と読まない）。
- 場面の版（`tree_nodes.version`）は照らさない。本文の保存のたびに進み、承認を待つ間の執筆で必ず食い違うため。場面があることは writer が今までどおり確かめる。
- 出来事の版は照らす。承認の後に出来事の欄が変われば、対象が変わったとみなす。
- hash は Native で作らない。TypeScript と Rust で読みの食い違いを作らないように、値のまま渡す。

## DR-A2T-2 照合の位置と拒否

- writer の `BEGIN IMMEDIATE` の中で、同じ依頼（request）の再送の判定の後、書き換えの前に照らす。前に置くと、成功した後の同じ依頼の再送が不一致で失敗する。
- 拒否の文は `version conflict` を含み、今の版の不一致と同じ分類になる。紐付けの識別子の値は文に入れない。
- `expected` は request hash に含まれる。同じ requestId で `expected` を変えた再送は、冪等性の不一致として拒む。**呼び手は、承認を開いた時に作った `expected` を保ち、再送でも同じ値を送る。**
- `expected` を省略した依頼の request hash は、変更の前と同じ。

## この変更の範囲外

- main の読み口（tool ごとの対象の表示、basis、`expected` の作り方）。次の変更で足し、DR-A2-5 の「14 本すべてで版か hash が取れる」はそこで確かめる。
- 場面をまとめて紐付ける writer（`agent_scene_event_link_batch`）。上の 4 本の tool は使わない。
- MCP の呼び出しは `expected` を渡さない（A2 判断記録の対象外）。
