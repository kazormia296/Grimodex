# ユーザーの返答の記録：Chronicle の合成の段の不具合の直し方（2026-11-03 夜）

## 経緯

PD の原稿の IR をクラウド LLM で作る試運転（`t-ja-1`、branch `claude/fusion-slot-ir-eval`）で、製品の不具合が 2 つ見つかった。
1. thinking の `summary`／`signature` が `null` で出て renderer が拒む → PR #786 で修正（integrator の判断。製品の不具合の修正）。
2. 観測の段は actuality を 10 種類許すが、合成の段の schema（`src/features/chronicle/extraction/schemas.ts:36-41`）は 4 種類（actual／attempted／prevented／rumored）だけで、合成の prompt（`runEventSynthesisTask.ts`）はそれを AI に伝えない。仮定の観測の cluster で AI が `hypothetical` を返し、run 全体が失敗した（`extractionCoordinator.ts` の `NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED`）。

## 質問と返答（原文）

1. AskUserQuestion「Chronicle 抽出の 2 つ目の不具合をどう直しますか？（…）」（選択肢：prompt を schema に合わせる (推奨)／schema を広げる／今は直さない）
   - **返答（自由記述）：「観測段と合成段というのはどういう違いですか？」**
2. integrator が観測の段と合成の段の違いを説明した後、AskUserQuestion「合成の段（観測を束ねて年表の出来事を作る段）の不具合をどう直しますか？（…）」（選択肢：prompt を設計に合わせる (推奨)／年表に仮定なども載せる／今は直さない）
   - **返答（自由記述）：「1で良いとは思いますが、ちょっとFableに聞いてみましょう。」**

- 日時：2026-11-03（JST）。経路：AskUserQuestion（どちらも自由記述）。

## 読みの根拠と範囲（integrator の読み）

ユーザーは案 1（prompt を設計に合わせる）に傾いているが、**まだ決定ではない**。Fable（effort high、read-only）に案の比較と推奨を聞き、その結果をユーザーに示してから決めてもらう。それまで合成の prompt・schema は変えない。
