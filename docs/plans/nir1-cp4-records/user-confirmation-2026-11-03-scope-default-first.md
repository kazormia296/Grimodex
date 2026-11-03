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
