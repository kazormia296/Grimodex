# ユーザーの回答の記録：JA の sparse の実装の着手前の 3 点（2026-11-03）

AskUserQuestion の回答を原文のまま残す。前の記録は `user-confirmation-2026-11-03-next-lane-a-b.md`（`6d8b370a`。lane A＋B の選択）。設計は branch `claude/ja-sparse-design` `01c3604f`（`docs/plans/related-scenes-ja-sparse-design-draft.md` 改訂 1）の §2.4、§2.5、§8.2。

## 提示した事実（質問の直前）

integrator は、JA の sparse で触る製品の file（`seedTerms.ts`、`fetchNir1RelatedScenes.ts`、Codex の matcher など）が S4b'''' の S2（`observation-prep.v1.json`）の pin にも R5 の閉包の記録にも入っていないこと（`git show cbf33077:` での grep。src/ の path は 0 件）を示し、実装は評価の再凍結にならないと伝えた。

## 質問・選択肢・回答（原文）

1. 「JA sparse の設計の枝（claude/ja-sparse-design、設計文書 1 本だけ）は remote にまだありません。通常の push（force なし）で残しますか？」
   - 選択肢：push して残す (推奨)／push しない
   - **回答：「push して残す (推奨)」**
2. 「短い別名だけの言及を数えますか？（例：名前「山田大地」・別名「大地」の項目だと、「北の大地」も言及になり、検索語に「山田大地」が入る）」
   - 選択肢：(i) 数える (推奨)／(ii) 3 字以上だけ数える
   - **回答：「(i) 数える (推奨)」**
3. 「検索語に使う Codex の種類はどちらにしますか？（合成データには人物と地名しかなく、差は測れていません）」
   - 選択肢：人物と場所だけ (推奨)／全種類
   - **回答：「全種類」**（integrator の推奨と異なる選択）

- 日時：2026-11-03（JST）。経路：AskUserQuestion。

## 読みの根拠と範囲（integrator の読み）

- 設計の枝は通常の push（force なし）で remote に置き、実装の PR に設計文書を含める。
- (c) は (i)：設計の基準の仕様のまま（matcher の一致を長さで絞らない。誤りは除外の別名で消す）。
- Codex の種類は全種類（組込みの character／location／item／lore と、ユーザーが足した種類）。item・lore の普通名詞に近い名前による検索語の枠の消費と誤言及は**測っていない**ので、実装の PR と記録に限界として書く。
- 含まないもの：閾値（gate 0.85、救済の幅 0.05、SPARSE_LIMIT 10）の変更、CP-4 の harness の変更（(b) 据え置き）、取り直しの依存の追加（(d) 取り直さない）、凍結済みの L0 の manifest・corpus の変更、製品の公開。
