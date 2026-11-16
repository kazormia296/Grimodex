# ユーザーの回答の記録：PUB-G #5 の Q1（容量を超えた project で B の再構築が拒否されたとき）（2026-11-17）

- 経路：Claude Code の AskUserQuestion（1 問）
- 材料（contracts の外）：`/home/grimodex/fusion-eval-data/pubg-a/05-v0.md`。dev 枝 `claude/pubg-5-v0-dev` の `9b510f50`（push していない）の試験で確かめたもの。

## 質問の要旨

B の binding を持つ project が容量の上限を超えたときに起きること：

- Verify が容量で失敗し（`NEX_VALIDATION_TERMINATED:capacity-exceeded`）、その失敗は再試行しない扱いになる。
- そのため、その project の自動の maintenance は止まり、自動では戻らない。durable な Finding は `narrative-maintenance-failure:dependency-verify:…` になる。
- コードを読む限りでは、`discover_all` の Err で workspace 全体の discovery が失敗する恐れがある（試験では確かめていない）。
- binding が無い project では、同じ超過でも何も起きない。
- B は製品では公開していないので、利用者への影響は今は無い。

選択肢：

- (i) 開示
- (iii) 拒否されたときに binding を退かせる（「成功したときだけ sealed head を進める」の読みを変えるので、新しい契約の起案になる）
- (ii) `dirty-pending-semantics`（今回の失敗の形には効かないので外す）

## 回答

**「(iii) を起案する (Recommended)」**

- binding を退かせる読みを新しい契約として起案し、確認をいただいてから実装する。
- #5 の実装は、それまで (i) の前提で進める。
- workspace 全体への波及（`discover_all` の Err の封じ込め）は、委任の範囲の技術判断として別に扱う。
