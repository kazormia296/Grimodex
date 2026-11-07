# ユーザーへの非ブロッキングの通知の記録（2026-11-01）

この file は、integrator（Claude）が CP-4 の S4（観測前の commit）の再凍結の前にユーザーへ出した**通知**の内容を残す記録。**ユーザーの確認ではない**。返事を求めない通知で、ユーザーからの返答は記録に含まれない。独立 reviewer（S4 の最終関門、2026-11-01）が「V-3／V-4 の規則は、確認の範囲より広いので、観測の前に通知する」ことを勧めた（P2-2）。

- 経路：Claude Code のセッション（ユーザーが「1でいいですがクラウド環境で実行してください」〔`8913f127`〕、「ローカルで測る」〔`68180464`〕と確認した会話）の中の、integrator の発言。
- 日時：2026-11-01（JST）。会話の発言そのものの原本は repo に無い。以下は会話の記録から書き起こした（項目と数値は発言のとおり。表現は整えた）。

## 通知の本文

**確認の範囲より広い、integrator の技術判断（いずれも最初の〔無効だった〕trace と稽古を見た後に決めた。閾値・期待値・Gold・Q と U の定義は変えていない。異議があれば測定の前に言えば止められる）**

1. **取り消された counted parent の扱い（DR-CP4-V-3）**：製品が begin の前に取り消した counted parent は、Q に数え、U には入れず、失効 (i)、K6/4 では X12 とする。その後の再 query は Q の外に置く。正式の editing で 3 件あり、単に除くと Q が 198 になって下限 200 を割る。事前登録の文言（K6/2 の規則 1・7、K6/4 の X12）をそのまま当てた、厳しい側の読み。(R)「再 query を親にする」と (C)「Q から除く」は緩い側なので採らなかった。read-only の advisor に諮った。
2. **cycle end の後に呼ばれた fetch を、その counted query の子にしない（DR-CP4-V-4）**：親が begin の後に取り消され、製品の再 query が cycle end の後に公開される形（稽古で 1/約 600、取り直しの 201 件で 1 件以上出る確率は約 28% の見積り）が K6/4 を E-6 で無効にするのを避ける。R4 と X12 の文言から導いた規則で、判定は成功の方向へ動かない（無効が「失敗として数える」に変わる）。advisor に諮った。
3. **quote の平文の拒否 guard の引き締め（B2）**：quote を含む鍵は、値が sha256 の 16 進のときだけ許可する。
4. **trace の記録の経路のその他の修正（DR-CP4-V-2）**：窓の外の末尾の Native 記録の除外と独立の時計の同期、凍結 trace の F-6 の resolver の配線、`parseArgs` の既定。これらは integrator と実装担当の設計で、advisor には諮っていない。
5. **trace の有効性の側には動く規則**：上の 1・2・4 は、無効だった trace を valid にする向きの規則（率や判定を成功側へ動かすものではない）。

**測定の見込み**

- editing の trace は、harness の不備を全部直しても、製品側の理由（B の index が作り直されず開始時の封印が 201 件中 200 件で dirty。測定 Main の stderr に `discovery failed … context-unavailable`。DR-BSEAM-5 は別 lane への報告で未確認）で、U=1、失効 (i)=200 になる見込みで、editing の (b) は harness の不備でなく測定の結果として HOLD／[precheck] になりうる。
- freeze record の `graphRuntimeObservedBeforeFreeze: false` は、契約が固定した形の値。実際には旧 S4b' の下で Gold・負例・trace の Graph arm が走っており、字義と事実が合わない（S2 の limits、作者の宣言、DR-CP4-S4-6 に開示した。S7 の報告でも明記する）。

## 関連する記録

- `user-confirmation-2026-10-31-trace-refreeze.md`（範囲）、`user-confirmation-2026-10-31-measure-locally.md`、`traces-s5r3-1/README.md`。

## 訂正（2026-11-01、通知の直後）

- 通知の「測定の見込み」と、それ以前の会話の発言にあった「測定 Main の stderr に `discovery failed … context-unavailable` が出ている」は**不正確**だった。実物（`traces-s5r3-1/start-seal-extract.json`、観測の実物の sha256 つき）で確かめた事実：
  - `[narrative-maintenance] discovery failed: … NEX_VALIDATION_TERMINATED:context-unavailable …` は、**prep の Main の stderr**（`prep-main-stderr.log`）に、editing でも browsing でも各 **3 回**出ている。**測定 Main の stderr（`measure-main-stderr.log`）には無い**（debugger の 2 行だけ）。
  - editing の開始時の封印は、201 件中 200 件で B が `generation=1`・`dirty=true`（before・after とも。#0 だけ current）。Chronicle の generation は 3 から 202 まで進み、開始時に dirty=true が 200 件。
  - B が作り直されない**原因**は未確認（prep の `discovery failed` との関係は推測）。DR-BSEAM-5 は別 lane への報告で、確認済みではない。
