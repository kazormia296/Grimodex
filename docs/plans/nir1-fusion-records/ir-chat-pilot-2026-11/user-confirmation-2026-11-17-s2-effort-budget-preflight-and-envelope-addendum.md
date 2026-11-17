# ユーザーの回答の記録：S2 の effort（Q1）、回答の段の上限の組替え（Q12）、予備測定、generic SQL の envelope の追補の形（2026-11-17 夜）

- 経路：Claude Code の AskUserQuestion（2 回、計 6 問のうち 4 問）。PR #935（S1-A）の merge（master `01dd6821`）の後に、統合者（grimodex-bb）が伺った。
- 資料：`/home/grimodex/fusion-eval-data/pubg-a/q1-effort-cost-2026-11-17.md` §7、`/home/grimodex/fusion-eval-data/design-notes/generic-sql-envelope-addendum-draft.md`。
- 文面は資料の §7 を短くしたもの。総額の上限 $35、縮める順序、送信先、保存範囲は、どの問いでも変えていない。

## Q1：回答の model（Sonnet 5.5）の effort

- 回答：**「製品の値に揃える (Recommended)」**。tool の arm は high、注入の arm は medium。費用が段の上限に収まらないときは、T4 を落とす前に止めて伺う。

## Q12：回答の段の上限の組替え

- 回答：**「組み替えてよい (Recommended)」**。抽出の実費が出た後、凍結の前に、回答の段の上限を「35 − 抽出の実費 − judge − 反復」（最大 $22）に決める。発動線は上限の 8 割のまま。縮める順序と、T4 を落とす前に止めて伺う点は変えない。決めた値は凍結の記録に書く。

## 予備測定

- 回答：**「行ってよい (Recommended)」**。先に Haiku の反復（約 $0.03）と `count_tokens`（課金なし）で往復数と prefix を測り、high／medium の出力の比が分からないときだけ、Sonnet 5.5 で 12 回答（Gold の先頭 6 問を ID 順で選ぶ × medium／high、約 $0.9、段の上限 $1.5）を走らせる。送信先は既存の Anthropic。記録するのは費用・往復数・出力 token だけで、回答の本文は読まず保存しない。変えるのは段の配分と縮める順序の案だけで、Gold・採点・閾値は変えない。Haiku の数値は Sonnet に持ち越さない。

## generic SQL の envelope（#933）の脅威モデルへの記録の形

- 回答：**「追補にする (Recommended)」**。確認済みの脅威モデル（`contract-confirmation-2026-11-09/`、SHA 固定、contracts `357a87b7`）は変えず、別の追補文書として置く。内容は 3 点：guard は `payload_json` と `reconciliation_envelope_json` を拒否する、artifacts と review bundle は設計上の公開面として残る、★3 (b) の理由 2 は chronicle の IR では成り立たないが結論の向きは変わらない。
- 追補の本文は下書き（上の資料）から作る。下書きの「未解決」5 項目（typed run の artifacts の中身、`plan_fragment_json` の過去の値の据え置きなど）は、この回答では決めていない。
