# ユーザーの確認の記録：IR の qualify の fast path（案 A）（2026-11-04）

## 提示した事実
- 設計の調査：`docs/plans/nir1-fusion-records/ir-fastpath-design-2026-11-04.md`（contracts `c070acc8`）。IR の qualify は、begin の検査の後に query の埋め込みの audit が同じ接続で commit し `total_changes` が進むので、ReadIdentity が外れて毎回完全検査になる（承認 236 件で p50 約 61 ms、D=10.84 ms）。
- 案 A：間にあった書込みが「audit の追加だけ」のとき（前後の identity の組を process 内・同じ接続で記録し、`validated_read == before` かつ `current == after`）だけ完全検査を省く。ほかの書込みが 1 つでもあれば今までどおり完全検査。DR-CP4-V-1 (3) が「ReadIdentity による鮮度判定の新しい規則になり、委任の外の新しい authority にあたる可能性があり、行うならユーザーの確認が要る」として採らなかった案。見込み（推測）は段 1 と合わせて中央値 6〜9 ms。

## 質問・選択肢・回答（原文）
「IR の検査を速くする案 A（間の書き込みが「監査の記録の追加だけ」のときだけ、変化なしとして重い検査を省く）を進めますか？（これが無いと、ある程度大きな原稿では IR が関連場面にほぼ出ないままです）」
- 選択肢：設計して実装まで進める (推奨)／設計だけ書いて確認／段 1 だけにする
- **回答：「設計して実装まで進める (推奨)」**
- 日時：2026-11-04（JST）。経路：AskUserQuestion。

## 読みの根拠と範囲
- 案 A の新しい規則（ReadIdentity の audit-only の引継ぎ）を確認した。設計（DR）→独立レビュー→実装→PR→merge まで進めてよい。実装の前に、append が `ai_audit_events` の INSERT だけであること（trigger を含む）と、完全検査が audit の行を読まないことを確かめ、想定外の影響があれば止めて報告する（選択肢の説明のとおり）。
- 含まないもの：D・B・P・IR の timeoutRate の閾値の変更、audit の内容と順序（GDX-AI-AUDIT-001）の変更、B・C 案、Raw の側（query の埋め込み）の変更。
