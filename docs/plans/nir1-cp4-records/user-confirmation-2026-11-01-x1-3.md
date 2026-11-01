# ユーザーの確認の記録：X1 /3（`nir1-scene-scope-projection-proposal/3`、contractId `scope-storage-authority`）（2026-11-01）

この file は、ユーザーが AskUserQuestion の回答として行った**確認**を原文のまま残す記録。

## 確認した内容

- 日時：2026-11-01（JST）。経路：Claude Code のセッションの AskUserQuestion（2 回）。
- 対象：draftRef `nir1-scene-scope-projection-proposal/3`、contractId `scope-storage-authority`、SHA-256 **`bf01f7bd6af21716ad27cb361ad4471483a3c72fb8b216699ef6ae3b5614f52f`**（`docs/plans/nir1-scene-scope-projection-proposal-3-draft.md`、1009 行、branch `claude/x1-proposal-2-draft` の commit `0ab7f121`）。
- **1 回目の質問**：「X1 /3(… SHA-256 bf01f7bd…52f)を確認しますか?本文だけの保存では B に『古い』という印を付けないこと、および IR(Chronicle)の鮮度更新でも B に印を付けないこと(型付き Revision と判別不能は今どおり両方)を、確認済みの規則 l6-l9:113 付近の読み替えとして入れます。(b)-1 再構築の仕組みは PUB-G、(c)-1 Chronicle は現状、(d)-1 新しい候補で CP-4 全体を再測定、(e)-1 見通しは推測として開示。閾値・Gold・評価の規則・凍結済みの trace は変えません。確認しても実装は始めません。」選択肢：「推奨のまま確認する(推奨)」「一部を変えてから確認」「確認せず保留する」。**回答（原文）：「型付き Revision と判別不能ってのはどういうことですか？」**（自由記述。**確認ではない**。質問として扱い、説明した）。
- 説明の後の **2 回目の質問**：「『型付き Revision』と『判別不能』の説明を踏まえて、X1 /3(SHA-256 bf01f7bd…52f)を確認しますか?」選択肢：「推奨のまま確認する(推奨)」「もう少し説明がほしい」「確認せず保留する」。**回答（原文）：「推奨のまま確認する(推奨)」**。

## 確認の範囲（integrator の読み）

1. **確認されたもの**：`nir1-scene-scope-projection-proposal/3` の本文の全体（上の SHA-256 の bytes）を、`scope-storage-authority` の 1 行として。内容は、(a)-1b（change feed の経路で本文だけの transaction では B を dirty にしない。Freshness の経路で、既知の B 以外の Revision の閉じた一覧〔今は Chronicle の IR だけ〕に当たると示せた Revision の分は Chronicle だけを dirty にし、型付き Revision と判別できないものは今どおり両方を dirty にする）。(b)-1（B の再構築の仕組みは PUB-G で決める）、(c)-1（Chronicle は今どおり保存ごとに dirty）、(d)-1（新しい候補で CP-4 全体を、凍結済みの trace の file と K6/2／K6/4 の規則のまま再測定）、(e)-1（見通しは推測として開示）の推奨を含む。ユーザーは (a)〜(e) について推奨と違う選択をしていない。
2. **/2 は確認されていない**（履歴として残る）。`typed-revision-material` は X1 /1 の確認のまま。
3. **確認しても実装は始まらない**（質問の文に明記）。実装は、確認後の手順（X1-5 の decisions 文書と PR 本文に判断を記録し、実装、独立レビュー、CI、merge、新しい候補、再測定）で、個別の確認は要らない（本文の範囲内の技術判断）。閾値、Gold、評価の規則、凍結済みの trace の file は変えない。
4. **範囲外**：IR の edge を持つ Scene を編集する trace の新しい事前登録、G-04 の fixture の新しい版（β。別の確認）、(a)-2／(a)-3 の対案（/4 以降）。

## 関連する記録

- `user-confirmation-2026-11-01-x1-g04-spike.md`（X1 /3 を起案する経緯）、`lapse-case2-design-investigation-2026-11-01.md`、`s6-aggregation-s5r4/`。
