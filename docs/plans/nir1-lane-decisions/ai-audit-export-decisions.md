# AI 監査 export の期限なしの待ちを断りに変える判断記録（DR-AAEX-1）

これは NIR-1 の事前委任の判断ではなく、ユーザーの通常の依頼（2026-11-19 夜、
`user-confirmation-2026-11-19-overbuilt-defenses.md` の M8 「直す」、contracts `206ad2f4`）に対する通常の修正の記録である。
根拠の報告は `fusion-eval-data/design-notes/overbuilt-defenses-2026-11-19/report.md` と `fable-review.md`（M8、区分 (d)）。
mutation の前に書いた。実装の後に分かったことは、行の本文を直さず末尾の「実装後の追記」に書く。

## 問題

`runAiAuditExportBoundary`（`src/features/ai-audit/exportBoundary.ts`）は quiescence lease を取った後に
`awaitPendingAiAuditExecutions()`（`executionRegistry.ts`、期限なし）で、実行中の AI の durable な終端を待つ。
lease に期限は無く、その間は application の mutation と、read／derived の IPC の admission が閉じる。
export のボタンは export 中だけ無効で AI の実行中は押せるので、長い AI の応答の最中に押すと、AI が終わるまで保存と読込が止まりうる。

## DR-AAEX-1（決定）

export を始めた時点で実行中の AI があれば、待たずに断る。lease を取ってから AI の終端を待つ経路を無くす。

1. **lease の前**に registry の保留（`hasPendingAiAuditExecutions()`、同期）を見て、あれば lease を取らずに断る（保存を一切止めない）。
2. **lease の取得の直後**にもう一度見て、あれば lease を放して断る。lease の取得は await を挟むので、前の確認と取得の間に AI が始まる隙があり、
   lease の取得で AI の admission（`beginAiAuditExecution` の `AI_AUDIT_ADMISSION_BLOCKED`）が閉じた後の確認だけがその隙を閉じる。以後は新しい実行が始まらない。
3. strict flush の前後・IPC の actual task の drain の後の各 `awaitPendingAiAuditExecutions()` は、待ちでなく同じ確認に置き換える
   （admission が閉じているので、2 の後に保留が現れるのは想定外で、現れたら待たずに断る）。
4. 断りは closed な code `AI_AUDIT_EXPORT_AI_RUNNING` の型付きエラー（`AiAuditExportBusyError`）で表す。
   UI は `attribution.aiAudit.aiRunning`（ja／en）を「AI の実行中なので、終わってから書き出してください」の趣旨で出す。
   これは失敗（`exportFailed`）ではなく案内なので、alert でなく status で出す。
5. 実行中の AI が無いときの経路（lease → IPC drain → strict flush → seal → controlled read）は変えない。

変えないもの：監査の記録そのもの（`beginAiAuditExecution` の start・prepared・dispatched の durable 化、terminal の append、
quiescence provider `ai-audit-executions` の `awaitPendingAiAuditExecutions`）、export bundle の内容、strict quiescence の他の stage。

## 信頼境界

- actor・攻撃・防御・受信先は変えない。新しい送信先・保存範囲・authority・契約は無い。秘密・データの流れは増えない。
- 断りは export の開始を拒むだけで、実行中の AI の監査 start・terminal の durable 化には触れない。
  断った後に AI が完了すれば、その terminal は今までどおり append される。作者は終わってから書き出し直す。
- 断る側（fail-closed）なので、frozen read の根拠（registry が空で admission が閉じた状態での read）は弱まらず、むしろ「registry ゼロ」を
  lease の取得直後に 1 度確かめるだけで成り立つ。`continuesPreexistingAttempt`（`api.ts`、lease 中の既存の親の retry を通す例外）は、
  export が保留中の親を持たなくなるので、export の lease の下では通らなくなる。コードは変えない（無害で、別の経路の契約）。

## GDX-AI-AUDIT-001 との整合

`policies/quality/iron-laws.md` の GDX-AI-AUDIT-001 を読み直した（grep と通読）。条文が求めるのは次の 3 点である。
(a) 観測できる全ての実行を、dispatch の前に durable に記録する。(b) 開始した実行は、観測できる限り append-only の terminal に到る。
(c) report は観測の境界（宣言された範囲、標準 MCP client の外部の実行は対象外）を過大に主張しない。
「freezes」は、request の project／workspace／path／operation／execution／parent の**同一性を start の記録に固定する**意味で、
export 中に実行を止める・待つ要求ではない。export の凍結（lease の下の frozen read）は GDX-AI-AUDIT-001 でなく
`exportBoundary.ts` の実装上の設計で、条文は export が実行中の AI の完了を待つことを要求していない。
この変更は (a)(b) の記録を変えず、(c) についても、実行中の AI があるときに export を作らないので、
「terminal が未記録の実行を含む bundle」を作る機会をむしろ減らす。よって矛盾しない。
`docs/AI経路検証.md` の同名の節も、経路の観測範囲の記述で export の待ちには触れていない。

## 試験

- 実行中の AI があるとき：待たずに `AI_AUDIT_EXPORT_AI_RUNNING` で断る。lease を取らない／取った場合は放し、`canScheduleQuiescenceMutation()` が true、
  strict flush・read が呼ばれない。保存（mutation IPC）が止まらない。
- lease の取得中に AI が始まった場合（前の確認は通る）：lease の直後の確認で断り、lease が放される。
- 実行中の AI が無いとき：今までどおり書き出せる（既存の順序の試験の確認を、待ちから確認に直す）。
- UI：断りのとき `attribution.aiAudit.aiRunning` を status で出し、ZIP を組まず download しない。
- 文言：`ja.json`／`en.json` の同じ key があり、locale の検査が通る。
