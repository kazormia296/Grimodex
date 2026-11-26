# 統合者のセッションでのユーザー回答（2026-11-26、§11 の残りと bump-version）

記録：統合者（grimodex-07、表示名「統合」）が直接見た AskUserQuestion の回答。記録の時刻は 2026-11-26 19:56（date で確かめた）。

## 背景
- workflow wf_ff5c2704-e37 で、作業記録 `docs/plans/nir1-continuation-2026-10.md` の §11 を、origin/master ada7d3527 と照らした。
  - 小項目 75 件のうち、委任の範囲内でまだやれるものは 2 件だった。どちらも反証を試みた後に残った。
  - bump-version の手順 9 の食い違いは、委任の外と判定された（NIR-1 の残レーンではない）。

## 問 1（原文）
「NIR-1 の §11 の棚卸しで、委任の範囲内で手つかずの 2 件が残っていました。(1) 同梱の C-query worker（約 91.5 MB）の固定 heap 約 84 MB を実行時の確保に直し、install 後のディスクを約 80 MB 減らす。C-resource の受入れの対象なので、独立レビューが要ります。公開に必須ではありません。(2) Nir1LocalGenerationInput.config の pub(crate) を締める、小さな整理です。この 2 件を誰が持ちますか？」
- 選択肢：「新しいセッションに渡す (Recommended)」／「統合者が持つ」／「今はやらない」
- 回答：「新しいセッションに渡す (Recommended)」

## 問 2（原文）
「.agents/skills/bump-version/SKILL.md の手順 9（97 行目）は、release の Full をローカルの pnpm ci:local:full で回すよう書いたままです。今の規則（GDX-TRACE-001：Full は GitHub-hosted だけ、ローカルの Full は証跡にならない）と食い違っています。これは NIR-1 の委任の外です。直しますか？」
- 選択肢：「直す (Recommended)」（説明：手順 9 を、hosted の canonical-ci.yml の Full を dispatch する形に直します。AI 指示の変更なので、品質ゲート（grimodex-author の手順）を通して docs の PR にします。次の release の前に入れます。）／「次の release の準備で直す」／「直さない」
- 回答：「直す (Recommended)」

## 効力
- (1) と (2) は新しいセッションが受け持つ。引き継ぎは `fusion-eval-data/handoff/nir1-s11-leftovers-handoff-20261126.md`。
  - (1) は C-resource の受入れの対象なので、独立レビューを経る。
- bump-version の手順 9 は、上の説明の形で直す。同じ新しいセッションが受け持つ。
