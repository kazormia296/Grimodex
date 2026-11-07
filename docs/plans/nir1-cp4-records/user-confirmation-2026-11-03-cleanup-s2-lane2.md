# ユーザーの返答と回答の記録：後片付け・S2 の文面・lane 2 の進め方（2026-11-03 夜）

前の記録は `user-confirmation-2026-11-03-ja-sparse-start.md`（`665a30f3`）。この間に PR #782（JA sparse）が merge された（`39ac13c8`）。

## 自由記述の返答（原文。AskUserQuestion の前）

1. 最終報告（次の候補：1 CP-4 の品質の判定の所在の調査、2 融合の枠と Raw 偏重の議論、3 S2 の改版、4 後片付け）への返答：**「まず4で。1,2、3って何ですか？」**
2. 1〜3 の説明への返答：**「3で測定やり直すのはあれなので、文章だけ修正しましょう。1は2影響するんじゃないでしょうか？であれば2から進めるべきかと思います。」**

## 提示した事実（AskUserQuestion の直前）

- 封印の仕組み：CP-4 の admission（`scripts/quality/nir1-retrieval/contract.mjs` の `assertObservationPrepAdmits`）は、S2 などの bytes の sha256 が S4b'''' の freeze record と一致することを照合する。S2 の文面を変えると、今日の結果（封印時の commit に結びつく）は有効なまま、以後の CP-4 の測定は新しい封印（6 回目の S4）まで止まる。
- 後片付け：worktree 68 本、合計で target 196 GB・.artifacts 327 GB・node_modules 122 GB（hardlink）・dist 40 GB。contracts の記録が worktree 名で参照する正式な測定の出力は `claude-cp4-s5cand`（143 か所）と `claude-g04-cand`（106 か所）、dev の診断は `claude-cp4-lp-diag`。push していない commit がある worktree は 7 本。merge 済みの worktree に dev の測定の出力が約 95 GB（相対パスだけの参照があり、完全には確かめきれていない）。

## 質問・選択肢・回答（原文）

1. 「後片付けで、何を消しますか？（正式な測定の出力と、push していない commit がある worktree は、どの案でも残します）」
   - 選択肢：作り直せる分だけ (推奨)／dev の測定の出力も消す／build 出力だけ消す
   - **回答：「作り直せる分だけ (推奨)」**
2. 「S2 の古い文面（最終関門の P3）をどう直しますか？ S2 は封印されていて、文面を変えると以後の CP-4 の測定は止まります（今日の結果は有効なまま）。測定のやり直しはどちらの案でもしません。」
   - 選択肢：S2 を直して封印し直す／S2 は触らず訂正は別文書 (推奨)
   - **回答：「S2 は触らず訂正は別文書 (推奨)」**
3. 「2（融合の枠の議論）から進めます。2 の最初の材料集めとして、1（CP-4 の品質の判定がどこにあるかを読むだけで調べる）を含めますか？ …」
   - 選択肢：2 の材料として 1 を含める (推奨)／1 は含めず 2 だけ
   - **回答：「2 の材料として 1 を含める (推奨)」**

- 日時：2026-11-03（JST）。経路：通常の返答 2 回と AskUserQuestion。

## 読みの根拠と範囲（integrator の読み）

1. 後片付け：merge 済み（または branch が remote にあり push していない commit が無い）で、測定の出力が無い worktree を外す（branch は残す）。残す worktree も含めて cargo の build 出力（`src-tauri/target`）を消す。`claude-cp4-s5cand`・`claude-g04-cand`・`claude-cp4-lp-diag` の `.artifacts`、push していない commit がある worktree、dev の測定の出力（約 95 GB）は消さない。外す前に各 worktree の `git status --ignored` を見る。
2. S2：S2・G-01 setup addendum v3・作者の宣言の bytes は変えない（6 回目の S4 はしない）。訂正は #780 の DR-CP4-S4-8 追記 6 で足りるとし、`policies/quality/iron-laws.md` の GDX-TRACE-001 に S4 の PR の `--merge` の例外を書く（P3-6）。品質規則の変更なので grimodex-author と impact gate の手順で行う。最初の返答「文章だけ修正しましょう」の範囲はこの 2 点と読む。
3. lane 2（融合の枠と Raw 偏重の議論）を始め、最初の材料集めとして CP-4 の品質の判定の所在を read-only で調べる。新しい測定、閾値・Gold・融合の枠の変更、実装は含まない（議論の材料と提案まで）。
