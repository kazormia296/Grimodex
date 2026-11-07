# ユーザーの確認の記録：G-04 fixture v2（β）の手順と選択 Q1〜Q5（2026-11-01）

この file は、ユーザーが AskUserQuestion の回答として行った**確認**を原文のまま残す記録。対象は設計案 `docs/plans/nir1-g04-fixture-v2-design-draft.md`（branch `claude/g04-fixture-v2-design` の commit `f2f5c6c2`、350 行）の「ユーザーの確認が要る点」（§7.2）。

## 確認した内容

- 日時：2026-11-01（JST）。経路：Claude Code のセッションの AskUserQuestion（3 問）。直前の発言「OKです」は、確認の質問をしてよいという許可と読み、確認としては扱わなかった。
- **質問 1（Q1 余裕 δ の値）**（原文の要旨）：「δ は『製品の基準〔IR の下限 0.66、Raw の gate 0.51〕から、新しい候補の合格条件をどれだけ厳しくするか』。校正 probe〔G-04 以外の 7 つの観測済みの case〕で、IR の予測と保存ベクトルのずれが最大 0.0150」。選択肢：「0.03 (推奨)」「0.02」。**回答（原文）：「0.03 (推奨)」**。
- **質問 2（Q2 観測の後に作る版の記録の形）**：選択肢：「正直に true にする(推奨)」（`graphRuntimeObservedBeforeFreeze` を true にし、観測後の版であることを記録する欄を足す。G-04 以外の全 fixture と schema の sha256 が v1 の freeze と一致することを束縛する検査を足し、schema を /2 に対応させる。README の規則文〔「変える必要があれば観測の前に限る」〕と manifest の補足を改訂する）／「false を読み替える」。**回答（原文）：「正直に true にする(推奨)」**。
- **質問 3（Q3〜Q5）**（原文）：「この 3 点を推奨のままでよいですか?【Q3】候補が全部不合格なら、v2 を作らずにあなたに戻る(候補の追加は認めない)。【Q4】測定のやり直しは、X1-5 を含む新しい候補で ④⑤ を全部やり直し、1 回にまとめる(G-04 だけを測り直すことはしない)。【Q5】probe の道具は、前に承認いただいた /tmp/onnxprobe を使い、版と sha256 を受領書に残す(新しい install は無し)。」選択肢：「3 点とも推奨のまま(推奨)」「一部を変える」。**回答（原文）：「3 点とも推奨のまま(推奨)」**。

## 確認の範囲（integrator の読み）

1. 設計案 §7.2 の Q1〜Q5 は、すべて推奨のとおり：δ＝0.03、観測後の版を正直に記録する（validator・schema・README の規則文・manifest の補足の改訂を含む）、全候補が不合格なら v2 を作らずに戻る（候補の追加は認めない）、④⑤ は X1-5 を含む新しい候補で全部やり直して 1 回にまとめる、probe は `/tmp/onnxprobe`（版と model・tokenizer の sha256 を受領書に残す）。
2. **これは手順と選択の確認で、v2 の fixture の中身の確認ではない。** 設計案 §5.2 の手順（候補の作者が候補を書いて sha256 を先に記録→probe の実行者が全候補を測り全結果を載せる→固定の順で採る→独立期待値レビュー→validator・schema の変更→freeze の凍結し直し→S2 の追補と S4 の再凍結→setup の作り直し→測定）を経る。全候補が不合格なら止めてユーザーに戻る。
3. 変えないもの：Gold、閾値（IR floor 0.66、Raw gate 0.51）、比較する期待値（manifest の `comparedFields`）、query、Scope、pin、Revision。変えるのは測定条件の入力（lio-landing の IR 要約と、Gold 0 の review Scene の本文。δ＝0.03 では rv-match と rv-unknown）と、版の識別・予測の説明文・限界の記録だけ。
4. 範囲外：日本語の FTS の修正レーン（別の確認）、G-02／03／06／07 の Raw の順序（`orderPredeclared` は false で、範囲に入れない）、IR の edge を持つ Scene を編集する trace の新しい事前登録。

## 関連する記録

- `user-confirmation-2026-11-01-x1-g04-spike.md`（β の方向の確認）、`s6-aggregation-s5r4/g04-cosine-probe.md`、`g04-index-enrichment-spike.md`、`g04-bge-instruction-probe.md`。
