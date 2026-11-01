# G-04 fixture v2（案 C）の B2b-1（seed-pin addendum v2、G-01 の setup addendum v2、trace の検査、DR、試験）の独立コードレビュー（2026-11-01）

**ユーザーの確認ではない**。別の agent（Opus、read-only）による独立コードレビューの記録。対象は worktree `claude-g04-v2c` の B2b-1 の 5 commit（`a7679acd`..`5591f37a`）。

- 判定：**(b) 修正してから受入れ可**。P1 なし、P2×1、P3×5。
- 新しい版 2 文書の差分：v1 と JSON の葉を比べ、seed-pin、setup ともに同じ葉 241。変わった葉は参照、それを述べる文、版の欄のどれかで、内容の変更（(d)）はない。`seedPins` は v1 と同一。v1 の bytes は不変。setup の `declarationPlace.rule` の 4→5 は K2/4 の 5 件目（ユーザー確認済み）から導かれる文の更新で、数え方は正しい。
- trace の検査の緩和：v1 の path を受けるのは完全一致で、かつ bytes が v1 の sha のときだけ。変異 約 45 個で迂回路なし。
- 残る落ちる 24 件：すべて S2 の pin し直しで直る種類（基点 `a7679acd` は 89/119、現在 98/122 から悪化なし）。
- P2-1：新しい版 2 文書の `graphRuntimeObservedBeforeAuthoring: false` は、DR-CP4-G4-6 (2) が退けた「意味の後付け」と同じ形で、B2a の宣言 addendum v2（true）とも割れる。→ integrator の判断で **true** にし、validator に「supersedes が v1 を束縛し、差が参照と版の欄だけのときに限る」条件を足した（B2b-1 が修正、`359513c4`..`cedbd867`）。
- P3：`addendumId` の検査、`supersedes.commit` の検査、DR の古い sha256、note の空白、B2b-2 への申し送り（S2 で v1 の path を持つ葉 23 の扱い）も修正・記録した。
