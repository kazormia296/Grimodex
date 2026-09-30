# Claude Code の入口

共通のプロジェクト規則・作業範囲・品質ゲートは次を使う。

@AGENTS.md

`.claude/skills/` は `.agents/skills/` の共通手順への入口。
Claude 専用の `update-licenses` はライセンス生成物の更新にだけ使う。
やり取り・設計ドキュメント・実装計画は日本語で書く。

## Claude の実行環境

- `.claude/hooks/block-push-to-main.sh` が master への直接 push を拒否する。
- Superpowers を使う場合も、AGENTS の作業範囲・明示確認要件を適用する。
  計画やレビューの各段階で再承認待ちにせず、依頼された可逆な作業を検証まで進める。

## レイアウトの検証

happy-dom は flex/grid の実寸を計算しない。位置・寸法・ヒット領域の修正や
CenterStripe／RegionStripe／Splitter／LayoutShell のレイアウト変更では
`pnpm test:browser` の実 Chromium テストを使う。
既存の幾何 invariant は `src/features/layout/layoutInvariants.browser.test.tsx`。
