# ユーザーの回答の記録：chat IR の S2 の作品・費用・候補・effort（2026-11-16）

- 経路：Claude Code の AskUserQuestion（4 問、1 回）
- 日時：2026-11-16T06:2xZ ごろ（回答の後の記録の時刻）
- 材料（contracts の外）：`/home/grimodex/fusion-eval-data/design-notes/chat-ir-2026-11-08/s2-estimate.md`
- 位置づけ：chat IR の閾値の選択の試験。CP-4 の証拠ではない。実行（抽出と回答の API の run）は、次の S4 の merge の後に行う。

## 回答

1. **held-out の作品と費用の上限**：「新作・上限 $35 (Recommended)」
   - AI 原稿の新作。100 場面（約 18 万字）、質問 40 問。
   - 固有名詞が既存の全作品と重ならないかを機械で検査する。Gold は IR の抽出の前に凍結する。
   - 費用は中央 約 $24、幅 $14〜40。$35 を超えそうなら止めて伺う。
2. **前倒し**：「前倒してよい (Recommended)」
   - S4 の merge の前に始めてよいのは、原稿の生成、質問と Gold、harness の実装（subagent で行う。API の費用なし）。
   - S4 の測定や重い作業とは重ねない。
3. **上位 4 件の候補**：「入れる (Recommended)」
   - 比べる候補は、τ＝0.813／0.85／0.86 と、上位 4 件の 4 つ。設計の §5 の範囲に入れる。
4. **回答 model の effort**：「medium（製品の既定） (Recommended)」

## 範囲

この回答に含まれないもの：

- 製品の公開（S3 の開放）
- PUB-G
- 新しい送信先、保存範囲の拡大
- 送信データの開示の確認（S3 の前に伺う）
