# CQ-MEM の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQM-1 | 2026-10-14 | CQ-MEM | registration の Revision ごとの資格確認を S（64 MiB、既存の上限）の scope で行い、封止の前に解放する。verify_complete_source_index の JSON の式を承認状態と current で gate する。query の Decision と digest の一時文字列を無くす | Q と S の値、preflight 2 MiB、whole-set 16 MiB は変えない。fail-safe（unavailable で R+IR）は保つ | Q を広げる（実装上の防御上限の緩和で [precheck]）。preflight を下げる（固定値の変更で [precheck]） | 現実形の検証（opus、read-only）：複製の削減と S への移動は委任の範囲 | 該当なし | 不要（worker の lifecycle は変えない。allocator の scope の使い方だけ） | 記録済み（実装前） |
