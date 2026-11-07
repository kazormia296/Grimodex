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

## 追記：Fable の意見を示した後の決定（同日、AskUserQuestion）

- 示した事実：Fable（`fable-synthesis-actuality-advice-2026-11-03.md`、contracts `77a61c03`）は案 1 を推奨。合成の prompt の版が 2→3 に上がり、Rust の開示の方針（`disclosure_policy.rs:33`、`retrieval_admission/disclosure.rs:24`）は 1 組しか受け付けないので、版 3 だけにすると版 2 の既存の抽出結果が IR で使えなくなる。
- 質問「合成の段の不具合を案 1（prompt を設計に合わせる。Fable も推奨）で直すとき、prompt の版が 2→3 に上がります。版 2 で作られた既存の抽出結果をどう扱いますか？」
  - 選択肢：版 2 と 3 の両方を受け入れる (推奨)／版 3 だけにする／今は直さない
  - **回答：「版 2 と 3 の両方を受け入れる (推奨)」**
- 読み：案 1 で直す（ユーザーは前の返答で案 1 に傾いており、この回答の選択肢は案 1 を前提にしている）。Rust の開示の方針と retrieval admission は版 2（既存の digest）と版 3 の両方を受け入れる。NIR-1 の開示の方針の文書（`nir1-diagnostic-disclosure-policy.md`）の「changed contract requires new content review」は、integrator が内容の review（足すのは指示の文と出力例だけで、LLM に渡すデータの種類は増えない）を行い、DR と PR 本文に残す。閾値・Gold・新しい送信先は変えない。
