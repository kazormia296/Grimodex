# ユーザーの回答の記録：chat IR の S1-A0、埋め込みの audit の終端が期限の内に書けないときの扱い（2026-11-17）

- 経路：Claude Code の AskUserQuestion（1 問）。統合者（grimodex-ed）が伺った。
- 位置づけ：chat IR（NIR-1 の残レーンの外。AGENTS の事前委任は適用されない）の S1-A0 の実装の前の判断。確認済みの脅威モデル（contracts `357a87b7`、SHA-256 `08f26f789501e6149852900e2fd537844843fbd9e1aad062ae33d52698a43db3`）の防御 T12（期限、preempt しない）を守るための audit の取得の置き換えに伴う点。契約・脅威モデルの文は変えない。

## 経緯

- S1-A0 の実装担当が mutation の前に止めた（workflow `wf_e1ccd355-d1b`）。設計どおりに作ると、埋め込みの取得と scoring の中で、既存の取得（`Database::with_conn` → `lock_conn`、期限なしで `ForegroundConnectionWaiter` を名乗る。grimodex-db `lib.rs:412`・`:471`）が project の spec の確認で 5 回、埋め込みの audit の append で 2 回（と再試行）走り、T12 を満たせない。
- 統合者の技術判断（防御を強める側）：A）spec の確認と audit の append を、期限つき・waiter を名乗らない取得に置き換える（grimodex-db に 4 つ目の公開 primitive）。D）spec は呼び手が渡し、DB の read の 5 回を消す。

## 質問の要旨

- 埋め込みは local の ONNX で、外部への送信は無い。
- 推論の前の記録（start／prepared／dispatched）が期限の内に書けなければ、推論せず IR を返さない（どの案でも同じ）。
- 推論の後の終端の記録が期限の内に書けないときの扱い：
  - 「終端を書けなければ IR を返さない (Recommended)」：fail-closed。推論の結果は捨て、IR なしで返す。終端の記録は後で期限の外で書き足す。
  - 「終端なしでも IR を返す」：終端は後で書き足す。失敗すると dispatched のまま終端の無い記録が残る。
  - 「今の取得のままにする」：audit だけ今の期限なし・maintenance を譲らせる取得を使う（T12 を弱める）。

## 回答

**「終端を書けなければ IR を返さない (Recommended)」**

- 推論の後の終端の記録が期限の内に書けないとき、推論の結果は使わず、IR なしで返す。
- 終端の記録は、期限の外で書き足す。
- audit に終端の無い結果が使われることはない。
