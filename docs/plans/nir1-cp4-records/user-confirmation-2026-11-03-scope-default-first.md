# ユーザーの回答の記録：IR の測定の scope の扱い（2026-11-03 夜）

## 提示した事実
抽出なしの経路の試運転（branch `claude/fusion-slot-ir-eval`）で、全 query が IR の対象外（`unsupported-query`）になった。新しい Scene の scope の binding は `compatibility_marker: unknown` で作られ（`src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs:464`）、IR の query の文脈は `Unknown` を `ScopeUnsupported` にする（`retrieval_admission/query_context.rs:120-133`。`LegacyAbsent` だけ通る）。つまり作者が場面ごとに scope を決めない限り、新しい場面では IR が関連場面に出ない。

## 質問・選択肢・回答（原文）
「IR の測定で、場面の scope（時間軸・世界線・叙述の層。今の製品では作者が決めないと IR が出ない）をどう扱いますか？」
- 選択肢：全場面に同じ scope を付ける (推奨)／既定のまま測る／scope の既定を先に議論
- **回答：「scope の既定を先に議論」**（integrator の推奨と異なる選択）
- 日時：2026-11-03（JST）。経路：AskUserQuestion。

## 読みの根拠と範囲
IR の測定を止め、先に「新しい場面で scope が unknown のとき IR が出ない」という製品の既定を見直すかを議論する。integrator は scope の設計の意図・決めた経緯・見直しの案と影響を read-only で集めて示す。scope の既定・契約・開示の境界の変更は、議論の後にユーザーが決めるまで行わない（新しい契約・authority にあたりうる）。

## 追記：scope の既定の議論の結論（2026-11-04、AskUserQuestion）

- 示した材料：`docs/plans/nir1-fusion-records/scope-default-material-2026-11-04.md`（contracts `eea7fcd7`）。案 A（規則はそのまま、案内と 1 クリック設定）、B（project に既定の scope を持たせ、新しい場面が受け継ぐ）、C（新しい場面を最初から「本筋」にする）、D（未設定でも IR を出す。推奨しない）。
- 質問 1「新しい場面の scope の既定（今は「未設定」で、作者が設定するまで IR も Graph も出ない）をどうしますか？」（選択肢：A：案内と 1 クリック設定 (推奨)／B：project の既定を受け継ぐ／C：最初から「本筋」／もう少し議論する）
  - **返答（自由記述）：「BかCで良いと思うが違いが分からない」**
- integrator が B と C の違い（B は project の設定に既定の scope を持ち、変えられる。既に作った場面は変わらない。C は固定の「本筋」。どちらも設定を忘れた回想などが本筋に混ざる危険と、`scope-storage-authority` の改訂の確認、既存の未設定の場面の扱いの決定が要る）を説明した。
- 質問 2「新しい場面の scope の既定を B と C のどちらにしますか？（どちらも契約の改訂として設計を書き、独立レビューを経て、あなたに確認してから実装します）」（選択肢：B (推奨)／C／もう少し議論する）
  - **回答：「B：project の既定を受け継ぐ (推奨)」**
- 読み：案 B の設計（契約 `scope-storage-authority` の改訂の新しい draftRef。project の既定の scope の保存、新しい場面の作成の全経路での継承、作者が変えられる UI、既存の未設定の場面の扱いの選択肢、既存の Revision／Index の失効への対処、開示の安全、CP-4／PUB-G への影響）を書き、独立レビューを経てユーザーに確認する。**この回答は設計の着手の承認で、契約の改訂・実装の承認ではない**。
