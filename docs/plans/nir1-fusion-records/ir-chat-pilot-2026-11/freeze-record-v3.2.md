# 事前登録 v3.2 の凍結の記録（chat の IR の pilot、2026-11-07）

- 事前登録：`preregistration-v3.2.md`（`fusion-eval-data/ir-chat-pilot-2026-11/design-v3.2-final.md` の写し）、SHA-256 `69a8a8587cba2e9790aa0fedf24b4a3fadc059e1a04beb74b5413951f0599c55`。
- 凍結の manifest：`freeze-manifest-v3.2.json`、SHA-256 `ac9260ccfc9128572a734b2af73662287b342525a227c709998334fbba15f47b`。code は dev 枝 `claude/ir-chat-pilot-context` の `127c500f2354968a7c0d2b5df02396fe416652af`（clean。push・merge しない）、runner・集計・judge・request の型・停止規則・bootstrap と照合の定数・data の sha256 を含む。`main-run.mjs answer` は manifest が今の状態と一致しないと始まらない。
- この commit の push が凍結の時点。本測定（Sonnet 5.5 effort high、79 問×6 arm、474 request）はこの push の後に始める。凍結の前に本測定の API は呼んでいない（通しは Haiku の探索と Sonnet の 12 問×6 arm の小さい通しだけ。どちらも設計の手順で、本測定の判定に使わない）。
- 凍結までの経緯：設計 v3（`2915b06e`）・v3.1（`ee0d7e10`）→ Haiku の通しと Opus のレビュー（指摘 16）→ ユーザーの決定（IR は質問つきの seed で評価側が選ぶ、上限 $60、judge は Haiku の API・照合は subagent）→ 直し（dev `dcc1dacc`）と Sonnet の小さい通し（$1.42）→ Opus の凍結前レビュー（P1×5、P2×6）→ 直しと runner・集計の実装（dev `127c500f`、試験 51 件成功）→ ユーザーの再確認（effort は high のまま。製品の chat の既定は medium）。
- 台帳の合計は凍結の時点で $18.00（上限 $60）。見込みは中央 $35.4、最悪 $50.1。
- 凍結の後は、質問・arm・配分・主指標（答えのある 67 問の項目の再現）・採点・除外と欠測・停止の規則を変えない。停止規則で中断した場合は deviations.json に逸脱として記録する。
