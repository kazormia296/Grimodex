# Mastra 移行 MP-9 判断記録（草稿）

状態：未確認。U-12 の回答までは案であり、実装しない。

## 1. 範囲

履歴の持ち主・保存、既存履歴機能、会話ごとの目的欄。旗 M は閉じる。

## 2. 確かめた事実

- Mastra が履歴を持ち、renderer は新規 user message を渡す案。既存保存との二重化を避ける（`mastra-migration-plan.md:481-484`）。
- 要約・過去会話・pin は system／context で渡し、cache の volatile tail に置く案（`docs/plans/mastra-migration-plan.md:482`）。
- U-12 は要約、chatRecall、pin、chat_message_prompts、窓・予算・cache・prompt snapshot、二重 embedding を未決にしている（`docs/plans/mastra-migration-plan.md:655-657,855`）。
- MP-7 案の表は全て closed。`mastra_message_parts`、`mastra_thread_metadata`、`mastra_resources`、`mastra_observational_memory`、`mastra_memory_vectors`（`docs/plans/mastra-migration-plan.md:428-431`）。
- ADR 007 は Agent が required criterion を弱めることを禁じる（`007-agent-collaboration-execution-boundary.md:225`）。

## 3. 判断案

- **DR-MP9-1 保存境界。** Mastra turn は main adapter が保存し、renderer の旧 persist を呼ばない。二重保存を拒む（`docs/plans/mastra-migration-plan.md:483-484`）。
- **DR-MP9-2 目的欄。** SessionTasks 案として、作者が会話ごとに書く目的を毎回 S-M10 の system／context で渡し、WM と分ける。保存先は MP-7 の `mastra_thread_metadata` 独自キー、または専用 closed 表。AI に必須条件を弱める書換えを許さない（`docs/adr/007-agent-collaboration-execution-boundary.md:225`）。採否は第 7 節。
- **DR-MP9-3 検証。** M を閉じたまま、journey の入口から最小の 2 turn 保存・再読込を試す。旗は開かない（`docs/plans/mastra-migration-plan.md:493-498`）。

## 4. owner／lifecycle（案）

| 対象              | owner                  | 終了・失敗                                                                                                             |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| turn buffer／保存 | main adapter           | terminal で commit、abort は破棄。commit receipt を証跡にする（`docs/plans/mastra-migration-threat-model.md:337-348`） |
| 目的欄            | main adapter（要確認） | thread 削除に追随。権限・競合規則は未決                                                                                |

## 5. 影響と PR の分け方

旗 M は閉のまま。まず保存・再読込の入口 journey と旧経路との非二重化、次に機能移行と bytes／cache 先頭の比較を分ける。NIR-1 capture、削除、再生成も計画の受入れ条件に含める（`docs/plans/mastra-migration-plan.md:492-497`）。

## 6. 脅威モデルへの影響

目的欄は作者の条件を永続化するため保存範囲・authority の新規判断。必須条件を Agent が弱める危険を追加検討する。既存脅威モデルは確定済みで、確認前に改訂しない。

## 7. ユーザーに確認する点（U-12）

回答（2026-11-26）：U-12＝**動かせるものだけ移す**（要約・過去の会話・pin・prompt の控えのうち、どれを移しどれを止めるかは、機能ごとの一覧にして改めて伺う）。**目的欄は不要**（利用者「要らないと思います」。DR-MP4-57 の 3 は取り下げ。SessionTasks からも外した〔DR-ST-9〕）。DR-MP9-2 は取り下げ。

1. 要約・過去会話の参照・pin・prompt snapshot をどうしますか？ **推奨：**現行の窓・予算を保ち、system／context で渡す。選択肢：この案を移す／安全に動かせる機能だけ移す／いったん止める。
2. semantic embedding はどうしますか？ **推奨：**既存 `chat_message_chunks` と MP-7 vectors の二重化を当面許容し、統合を別判断にする。選択肢：二重化／統合／semantic 機能を止める。
3. 目的欄を採用しますか？ **推奨：**作者が設定し毎回 system／context に渡す。保存は独自 metadata key（小さい変更）／専用 closed 表（明示的な表）。どちらも AI は必須条件を弱められない。
4. 目的欄の保存を新しい保存範囲として承認しますか？ **推奨：**MP-7 の metadata key を使う。専用表にする場合は schema 契約も確認する。新しい送信先・authority・契約・閾値は現案に含めない。必要なら送信先とデータ、権限、契約、閾値を明示した案を別途提示して確認する。

## 8. 採らなかった案

目的を WM に混ぜる案（作者の必須条件と AI の作業記憶が混線）。回答前の旗開け（計画の gate に反する）。

未確認：指定の `.codex-jobs/mp9-survey.out.md` は作業ツリーに無く、調査の実測・既存機能の細部は照合できていない。
