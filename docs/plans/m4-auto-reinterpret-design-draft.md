# 自動再解釈の送信の設計（起案・未確認、2026-11-25）

状態：**起案**。前の「送信の形」（追記 3）は前提が誤りで失効した（[判断の記録](nir1-lane-decisions/m4-pullforward-decisions.md) の「DR-M4PF-6 の前提の訂正」）。
**送信の経路は開けていない。この文書は送る前に確かめるための案で、実装の根拠にしない。**
2026-11-25 のユーザーの回答（原文）：「自動送信を先に設計し直す」。

## 1. 事実（read-only の調査、2026-11-25）

- 手動の構造抽出（`CodexStructureExtractDialog.tsx`）は `useAi: false` が固定で、AI の経路（`codexStructureExtractionApi.ts:1775-1778`）は空。**今、構造抽出で AI に送るものは何も無い**。単位はフォルダと配下の場面。
  画面は env flag の裏で、未指定なら開発版だけ有効。
- AI タスク `runEntityResolutionTask`・`runRelationSynthesisTask` は実装だけあり、製品の呼び手が無い。
- Entity の prompt が組むもの（`runEntityResolutionTask.ts` の `buildEntityResolutionPrompt`）：cluster の呼称、**本文の抜粋（Source View）**、Type の一覧、**既存の項目の一覧（名前・別名・Type）**。DB の実 id は送らず、不透明な参照（T####・K####・S####）だけ。
- **この経路に hidden の除外は無い**（既存の項目の一覧に hidden が入り得る）。同じ種類の守りは候補の AI 評価（`candidateJudgment.ts`、`listCodexIdsHiddenFromAiInAnyPhase`）にある。
- 本文の保存は Change Feed に積まれ、main は約 1 秒の poll（`electron/main/narrativeFreshness.ts`）で Freshness と Build Action を更新する。**AI の実行主体は今は renderer** で、main から起こすなら通知の経路が要る。
- 保存済みの Build Action は Native にあるが、renderer の inbox の型には `buildAction`・`consumerKey` が無い。
- token の見積もりは `countTokens`（tiktoken）、実測の記録は `ai_usage.tokensIn`。構造抽出の過去の実測は無い。

## 2. 送る形の案

| 項目       | 案                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 何を送る   | 最初の版は **Entity の同定だけ**（`runEntityResolutionTask` の prompt の形）。Relation の合成は送らない。本文の抜粋は、`rebuild-required` になった**場面の中の**、その呼称を含む抜粋だけ（場面全体は送らない）               |
| 単位       | 場面（今の手動の単位はフォルダだが、自動は影響した場面だけにする。新しい単位なので確認が要る）                                                                                                                               |
| 除外       | hidden の Codex の項目は、既存の項目の一覧（名前・別名）から除く（どれかの Phase で hidden の項目も除く。`listCodexIdsHiddenFromAiInAnyPhase` と同じ、判定に失敗したら**送らない**）。除いた項目に当たる呼称の抜粋も送らない |
| 送信先     | 作者が設定した provider と model のうち、役割 `narrative_entity_resolve` の割り当て（未設定なら何もしない）。新しい provider の種類は足さないが、**本文を送る新しい経路**になる                                              |
| きっかけ   | 作者の本文の編集で `rebuild-required` になった場面だけ。取り込み・復元・変更レビューの適用では送らない                                                                                                                       |
| 上限       | 場面を離れた時か無編集 10 分。同じ場面は 30 分に 1 回。1 回 3 場面、1 日 20 回。1 日の入力 token の上限は、`countTokens` の見積もりと最初の実測から決める                                                                    |
| 同意       | 既定オフ。プロジェクト単位でオン、設定は端末側（DB に入れない）。オンの時に送る中身（上の行）を画面に出す。provider か model を変えたらオフ                                                                                  |
| 記録       | 送信の記録（時刻・場面・件数、本文なし）を残す。前の確認は同じ前提の上にあったので、**改めて伺う**                                                                                                                           |
| 結果の扱い | 新しい提案は変更レビューに積むだけで、Story Bible は書き換えない。失敗・超過は再試行 1 回まで、送らずに手動の入口へ                                                                                                          |

## 3. 実装の前に要るもの（旗は閉じたまま、順）

1. 手動の AI の経路の配線（`useAi` の stub に Entity の task をつなぐ）。**本文を送る経路そのものなので、自動より先に、手動で確かめられる形にする。**ここが新しい送信の最初の入口になる。
2. hidden の除外（fail-closed）と、その試験。
3. token の見積もり（送らずに prompt を組んで数える）と実測。
4. 読み取り：inbox の型に `buildAction`・`consumerKey` を通すか、専用の読み取りを足す。
5. 契機と実行主体（main の cycle 完了の通知 → renderer の実行）。
6. 同意・上限・記録の画面と保存。

## 4. 伺うこと

1. 「何を送る」「単位」「除外」の案でよいか。
2. 送信先を役割の割り当てにし、未設定なら何もしない形でよいか。
3. 記録（時刻・場面・件数、本文なし）を残してよいか。
4. 順番：自動の前に、手動の AI の経路（上の 3-1）を先に配線してよいか（それ自体が新しい送信）。
