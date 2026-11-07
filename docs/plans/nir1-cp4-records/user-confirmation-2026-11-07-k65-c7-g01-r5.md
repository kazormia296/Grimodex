# ユーザーの確認の記録：C7、G-01 の診断の経路、R5 の記録の再利用（2026-11-07）

6 回目の S4（DR-CP4-S4-9、PR #827、head `280ff921`、S2 追補 #14 は commit `6aad102d`）の S3 の独立レビュー（Opus）の blocker B1（C7 と G-01 の admission の新しい経路にユーザーの確認が無い。問 3・問 5 の回答は起案の指示で確認ではない）と major M1（R5 の候補の後の製品のコードの変更）を受けて、AskUserQuestion（1 回、3 問）で確かめた。

## 質問と回答（原文）

### 1. C7
- 質問：「PR #827 の S2 追補 14（commit 6aad102d）に入れた C7 を、CP-4 の手順の変更として確認しますか？ Chronicle の build の途中に入った begin（querySupported、IR の理由 index-unavailable、renderer の値 graph-unavailable:cancelled の 3 つを満たすものだけ）を対応づけから外し、失効の理由 i-chronicle-stop に数えます。LAPSE-2 の例外を含みます。」
- 選択肢：「確認する（推奨）」「確認しない」
- **回答：「確認する（推奨）」**

### 2. G-01 の admission の新しい経路
- 質問：「PR #827 の admission の新しい経路 g01-e2e-diagnostic（新しい authority の候補）を確認しますか？ G-01 の凍結素材だけを、診断の run だけに許します。判定に数えず（countsInCaseJudgement:false）、別の session で走らせ、DB への新しい書込みはありません。ほかの経路は今までどおり凍結素材を拒みます。」
- 選択肢：「確認する（推奨）」「確認しない」
- **回答：「確認する（推奨）」**

### 3. R5 の記録の再利用（追加の事実の後の再確認）
- 質問：「R5 の追加の事実です。前回の R5 の候補の後、harness の 5 file に加えて、製品の関連 Scene のコード（IR の窓 40 ms、日本語の sparse、Scope の既定、Freshness の gate、先読み、C1）も変わっています。seed を決める file は変わっていません。前回の記録を使う判断はこのままでよいですか？」
- 選択肢：「このまま前回の記録を使う（推奨）」「取り直して凍結し直す」
- **回答：「このまま前回の記録を使う（推奨）」**
- integrator が確かめた事実：`git log 179139b4..origin/master -- src/features/related-scenes/nir1GraphSeed.ts` は空（seed の規則の file は不変）。その間の関連 Scene と周辺の製品の commit は #776（試験だけ）、#777、#782、#793、#797、#802、#811、#814、#817、C1（#824）。

- 日時：2026-11-07（JST）。経路：Claude Code のセッションの AskUserQuestion。

## 確認の範囲（integrator の読み）

1. C7：S2 追補 #14 の TP-1 の C7 の読み（外す条件の 3 つ、外した件数と条件を満たす fetch の数の一致、E＞0 の時計の範囲、外した親への混入の検査）と、LAPSE-2 の例外（読み・S4 を変えた上での正式の再測定）を CP-4 の手順として確認した。
2. G-01：admission の purpose `g01-e2e-diagnostic` を、G-01 の凍結素材・診断の run・判定に数えない・別 session・DB への新しい書込みなしの範囲で確認した。ほかの purpose が凍結素材を使えないことは変えない。
3. R5：前回の確認（`6b47c177`）を、製品のコードの変更を示した上で維持した。S2・S4b・PR 本文・S7 に、harness の 5 file と製品の commit の変更、seed の規則の file が不変であることを開示する。
4. 閾値、Gold、pool、K6/5 の bytes・値・判定、G-case の setup は変えない。
