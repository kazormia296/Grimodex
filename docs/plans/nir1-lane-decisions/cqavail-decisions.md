# CQ-AVAIL の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-CQA-1 | 2026-10-14 | CQ-AVAIL | Graph の node の同一性から Scope を外し、Scope は binding（Revision）ごとに持つ。本当の版の矛盾だけを ENDPOINT_VERSION_CONFLICT に残す。worker の frame の版を上げて node が binding ごとの Scope を運べるようにし、内側の上限は proposal/6 の規則で決めて記録する | actor と受信先は変えない。A3 は Revision ごとに評価済みで、edge は exact binding を持つ（post-B §6.3 に合う）。frame の全体の上限は変えない | 代表の版に畳む（§6.3 に触れるので [precheck]）。何もしない（場面ごとの review で中心人物が常に unavailable） | 現実形の検証（opus、read-only）：実装の欠陥で委任の範囲 | 該当なし | 不要（worker の lifecycle は変えない） | 記録済み（実装前） |
| DR-CQA-2 | 2026-10-14 | CQ-AVAIL | node 上限・edge 上限・版の衝突に型付きの理由を与え、空の Graph を worker でも available（寄与 0）として返す | 拒否の条件は変えない。in-process と worker の結果を揃える | 空の Graph を typed unavailable に揃える（可用性の記録で常に unavailable の状態が増える） | 同上 | 該当なし | 不要 | 記録済み（実装前） |
| DR-CQA-3 | 2026-10-14 | CQ-AVAIL | project 単位の読取（Scope authority の tree、binding、registry、epoch、query scene、POV）を query で1回だけ読み、1回だけ admit する。Revision に結び付く行は Revision ごと。読取を減らさずに課金だけを減らすことはしない | 上限の値は変えない。post-B の「request-local で重複検証を抑える」に合う。読取と課金を1対1に保つ | 課金だけ減らす（閾値の緩和で [precheck]）。何もしない（2件目の Revision で 512 を超える） | 同上 | 該当なし（値も数え方の対象も変えず、実際の読取を減らす） | 不要 | 記録済み（実装前） |
