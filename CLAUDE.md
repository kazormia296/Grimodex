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

## Codex への委譲

ユーザー単位の skill `codex-delegate` と agent `codex-worker` が入っている環境では、
実装・調査・デバッグ・テスト作成・レビューを、自分で手を動かす前にまず Codex に委譲する。
数行で済む修正は、依頼文を書くより速いので自分で行ってよい。

- Claude が持つもの: 設計判断、契約・脅威モデル、ユーザーへの問い、commit／push／PR、最終の受入れの確認。
- 委譲しても AGENTS の作業範囲・明示確認要件・品質ゲートは変わらない。
  依頼文に範囲と「やらないこと」を書き写し、API key などの認証情報は入れない。
- 結果は事実（差分と報告）として受け取り、そのまま commit・PR にしない。
  差分が許可範囲に収まるかと、受入れ条件のテストを自分で確かめる。
- workspace-write の依頼は、差分の無い linked worktree に向ける（メイン checkout は `codex-worker` の事前検査で止まる）。
  依頼文・結果・ログは repo の外に置く。

## レイアウトの検証

happy-dom は flex/grid の実寸を計算しない。位置・寸法・ヒット領域の修正や
CenterStripe／RegionStripe／Splitter／LayoutShell のレイアウト変更では
`pnpm test:browser` の実 Chromium テストを使う。
既存の幾何 invariant は `src/features/layout/layoutInvariants.browser.test.tsx`。
