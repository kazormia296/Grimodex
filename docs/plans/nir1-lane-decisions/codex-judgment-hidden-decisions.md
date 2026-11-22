# 候補画面の「AI で評価」が hidden の Codex を送る件の直し — 判断の記録（DR-CJH）

この文書は、`src/features/codex/candidateJudgment.ts` を変える最初の mutation の前に、判断と信頼境界を残す。
先例は #998（2026-11-21。読みの一括推定と項目ごとの「AIで推定」が hidden を送らない）。#998 は判断を ADR 013 と IME 連携設計書にだけ残し、decisions 文書は作っていない。この文書はその続きで、記録先をここに置く。

## 出所

| 項目             | 内容                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| この lane の位置 | NIR-1 の残レーンではない。送信先・送る範囲を**狭める**直しで、新しい送信先・保存範囲の拡大・閾値の緩和・製品認可の削除・新しい契約を含まない                                                                                                                                                                                              |
| 根拠             | 画面の約束（`ja.json` の Phase の露出の説明）「hidden はどの経路でも AI に渡りません」、ADR 013 の J2（Codex の hidden は「どの経路でも AI に渡さない」、確認 3 の (b)）、#998                                                                                                                                                            |
| 不具合           | 候補画面の「AI で評価」（`CodexCandidatesReport.tsx` の `handleJudge`）が、store の生の `entries` を `judgeCandidates` に渡し、`candidateJudgment.ts` が先頭 200 件の id・name・aliases を `codexJudgment` の prompt の「既存エントリ」の行にして送っていた。hidden を除く処理も Phase の考慮も無かった。作者がボタンを押したときだけ送る |
| 範囲外           | `codexHiddenFromAi.ts` の本体（別 lane が触る）。候補の本文の抜粋（`context`、場面の本文）の送信（これまでどおり、作者が押したときの本文の送信で、抽出の経路と同じ作者視点）。ほかの AI 経路の hidden（ADR 013 の残漏れの表）。`codex_judgment` の経路の廃止の判断（`recordAiUsage.ts` の古い注は実態に直した）                           |

## 判断

- **DR-CJH-1（直し方）**
  - `judgeCandidates` の中、prompt を組む前に、hidden の項目を `entries` から除く。除いた一覧から `knownIds`（AI が返す `aliasOfId` の照合先）と `existingEntries`（先頭 `MAX_ENTRIES`＝200 件）を作る。窓は除いた後に数える（hidden が窓を占めて公開の項目が落ちない）。
  - 判定は送信の直前に DB で行う。呼び側の `entries` は store の写しで古いことがあり、hidden へ変えた直後の項目も守る。
- **DR-CJH-2（hidden の範囲：広く隠す側）**
  - 「base が hidden（不明な mode を含む）、DB に無い id、project が合わない id、またはどれかの Phase の `contextModeOverride` が hidden（不明を含む）」の項目を全部除く。
  - 理由：この画面は場面を持たない。`listCodexIdsHiddenFromAi` を sceneId なしで呼ぶと anchor が base になり、base の mode だけの判定になる。base は公開で Phase でだけ hidden の項目が、公開と判定されて漏れる。時点が決まらない経路では、いつか hidden になる項目も送らない側に倒す。逆に、base が hidden で Phase で解除される項目も除く（時点が決まらないので、解除後の姿を送る根拠がない）。
  - 実装：`context/codexHiddenAnyPhase.ts` の `listCodexIdsHiddenFromAiInAnyPhase`（新しい小さな helper）。`listCodexIdsHiddenFromAi` の結果に、base の mode と全 Phase の override を直接読んだ判定を足す（正本の判定より狭くならない）。`codexHiddenFromAi.ts` は変えない。suppress は hidden ではない（#998 と同じ。送る）。
- **DR-CJH-3（fail-closed）**
  - 判定が失敗したら送らず、`CandidateJudgmentHiddenCheckFailedError`（code `CODEX_JUDGMENT_HIDDEN_CHECK_FAILED`）で reject する。画面の既存の経路（`handleJudge` の catch → 「AI 評価に失敗しました」の toast と `rootCause`）がそのまま通知する。決定的な候補一覧は維持される。空の結果を返す案は採らない（「評価できた」ように見えるため。`readings` の `YomiHiddenCheckFailedError` と同じ形）。
  - 送信は 1 回だけで、判定の失敗の後に再送しない。
- **DR-CJH-4（画面の候補の扱い）**
  - `activeCandidates` は変えない。これは store の全 `entries`（hidden を含む）の名前・別名と照合して既知の語を候補から外すので、hidden の名前は「新しい候補」として出ない。
  - hidden を AI の一覧から除いた結果、AI が hidden の項目の別名の語を `aliasOfId: null`（新規）と判定する経路は、その語が本文に出ていて、かつ `activeCandidates` を通る場合だけ（hidden の名前・別名と完全一致する語は、そもそも候補に出ない）。残るのは表記ゆれで、候補としては以前からあったもの。hidden を守るための副作用として受け入れる。
- **DR-CJH-5（ADR・コメント）**
  - ADR 013 の経路の表（経路 6 の `codex_judgment`）に、hidden（base と Phase のどちらか）を除いて送ることと、#998・この DR への参照を足した。
  - `recordAiUsage.ts` の `codex_judgment` の注「retired: Codex 構造抽出へ移行済み」は実態に合わない（`aiPathRegistry.ts` でも現役の経路）。候補画面の「AI で評価」の説明に直した。

## 信頼境界

- 送信先は変えない（`codex_judgment` の既存の provider）。送る範囲は狭まるだけで、新しい項目・保存・送信先は増えない。
- hidden の判定の正本は DB（`codexEntries.contextMode`、`codexEntryPhases.contextModeOverride`）。renderer の store の値は信頼しない。
- 判定の失敗・DB に無い id・不明な mode は、送らない側に倒す。

## 試験

- `candidateJudgment.realHidden.test.ts`：実物の helper と DB（in-memory）を通す。base が hidden・Phase でだけ hidden・Phase で解除される hidden・公開の項目を作り、request の本文に前 3 つの id・名前・別名が無く、公開の項目はあること、DB に無い id・別 project の id が送られないことを固定する。
- `candidateJudgment.test.ts`：候補の表記が hidden と同じなら除く、判定の失敗で送信が 0 回、200 件の窓を除いた後に数えること、hidden の id を AI が `aliasOfId` に返しても採用しないこと。

## レビューの指摘への対応（DR-CJH-6〜）

- **DR-CJH-6（F1 を反映）**：`judgeCandidates` 自体が、除いた hidden の項目の名前・別名（`knownNameSet`）と、候補の surface・lemma を照合し、一致する候補を prompt の前に除く。全部該当すれば AI を呼ばず空の Map を返す。照合先は呼び側が渡した `entries` のうち hidden と判定されたもの。`entries` に hidden が無ければ照合できない（DB の判定は id 経由のため）。それは呼び側の契約で、現在の呼び元（`CodexCandidatesReport`）は store の全件を渡す。候補の `context`（本文の抜粋）に hidden の語が入る件は、作者の本文を作者が押したときに送る範囲（上の「範囲外」）のままとする。
- **DR-CJH-7（F2 を反映）**：`projectId` を同期的な入口で固定し、`getProject`・hidden 判定・送信に同じ値を使う。送信の直前に store の `projectId` が一致するか再確認し、不一致なら `CandidateJudgmentProjectChangedError`（`CODEX_JUDGMENT_PROJECT_CHANGED`）で reject する。`captureAiOperationAuthority` までは使わない（workspace の path などこの経路が持たない資源が要る）。
- **DR-CJH-8（F3 を反映）**：`listCodexIdsHiddenFromAiInAnyPhase` が id を 500 件ずつに分けて判定する（どれかが失敗したら reject）。実際の bind 変数の上限での失敗は確認していない。予防として入れ、1200 件の実 DB の試験で、複数の chunk にまたがる hidden（base と Phase）が除かれることを固定した。送る先頭 200 件だけを判定する案は、除いた後に窓を数える契約（DR-CJH-1）と両立しにくいので採らない。
- **DR-CJH-9（F4 を反映、一部は DB の制約で形を変更）**：試験を足した（候補の表記が hidden と同じ、Phase の問い合わせの失敗、projectId なし、判定の間の project 切替、1200 件）。base の mode と Phase の override の不明値は、DB の CHECK 制約（`always／mentioned／suppress／hidden` のみ）で入れられないので、Phase の読み（`listPhasesByEntryIds`）を差し替えて不明値を返し、除かれることを固定した。base の不明値は DB から入らないため試験にしていない（`isCodexContextModeHiddenFromAi` が不明値を hidden とする判定は helper が使っている）。
- **DR-CJH-10（F5 は別件として記録、この PR では直さない）**：`codexYomi.ts` の `inferReadings` は base の mode だけを見る（`listCodexIdsHiddenFromAi` を sceneId なしで呼ぶ）。Phase でだけ hidden の項目の名前・別名が読みの推定で送られる。#998 の範囲と試験（`codexYomi.codexHidden.test.ts`）・ADR 013 の記述（「base の mode」）を変える別の直しなので、別 PR で `listCodexIdsHiddenFromAiInAnyPhase` に切り替える候補とする（送る範囲は狭まる向き）。構造抽出の `existingCatalog`（`codexStructureExtractionApi.ts`／`CodexStructureExtractDialog.tsx`）の hidden の扱いは未確認で、別途 read-only で確かめる。
