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

## 問 3（20:03、統合者の AskUserQuestion。「済み」が崩れた 5 件）
- 背景：「済み」36 件の反証（wf_6c88df74-8ff）で 10 件が崩れた。
- 問い（原文）：「§11 で「済み」とされた 36 件を反証したところ、10 件が崩れました。どれも公開の前提に関わります。うち 5 件は、委任の範囲内で今やれます：① restricted のときの restore・importTree・saveBaseline の試験が無い。② 状態ファイルが読めないときのエラー dialog の見え方を、実機で確かめていない。③ 作業記録が「canonical Full で確認済み」と書いているが、裏づけが無い。加えて、workspace の切替の flake の原因が未調査。④ da2b の decisions の冒頭表の行 3・4 が古いまま。⑤ owner Suspended からの復帰を、journey で確かめていない。残り 5 件は、凍結・正式 run、Session C-1 の承認、PR-2 の撤去のどれかで扱うものです。この 5 件をどうしますか？」
- 回答：「別の新しいセッションに渡す (Recommended)」。引き継ぎは handoff/pubg-prereq-gaps-handoff-20261126.md。

## 問 4（20:03、統合者の AskUserQuestion。PR の枠と CI）
- 背景：Mastra の担当（grimodex-57）が、ユーザーの指示の原文として 2 つを中継した。統合者は直接見ていない。「PRもCIは最終的に通ってればいいので、途中のPRはCIを無視してmergeして構いません」「PR枠も守らんでいいです。めちゃくちゃにしてください。」
- 問い（原文）：「Mastra の担当から、あなたの指示として 2 つの文が届きました。（上の 2 文）。これは全 lane（M2・M3・M4・年表・出力打ち切り・新しい 2 セッション）に当てはめますか？注意点：master が赤い間は、他の PR の Quick も赤になり、原因の切り分けが難しくなります。また hosted runner は同時 20 job なので、PR が一度に並ぶと CI の待ちが伸びます。」
- 選択肢：「全 lane、ただし Rust・schema は除く (Recommended)」／「全 lane にそのまま」／「Mastra の lane だけ」
- 回答：「Mastra の lane だけ」
- 効力：
  - Mastra の lane は、枠と順番を待たずに PR を出し、CI を待たずに merge してよい。ただし schema の版は、merge の前に統合者と合わせる（Mastra の申し出）。
  - 他の lane は、今までどおりにする。製品 PR は同時 2 本までで、Quick と ci.yml を通してから merge する。
  - 統合者の読み：Mastra の PR は、他の lane の 2 本の枠に数えない。
