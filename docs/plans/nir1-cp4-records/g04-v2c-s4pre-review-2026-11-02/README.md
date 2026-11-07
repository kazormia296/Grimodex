# G-04 fixture v2（案 C）の S4b の前の独立レビュー（2026-11-02）

**ユーザーの確認ではない**。別の agent（Opus、read-only）による独立レビューの記録。対象は worktree `claude-g04-v2c` の B2b-2 の 8 commit（`cedbd867`..`eae0c79d`）：DR、失効、addendum 3 件の凍結、S2 追補 #11、S4a'''、DR。S4b（freeze record）を作る前の関門。

- 判定：**(b) 修正してから受入れ可**。P1 なし、P2×3、P3×6。
- 問題がなかったもの：失効（復元した S2 は `6cb7e05c` と同じ bytes。`557e683c` との差は token・status・review・formal.review・placeholders だけ）、addendum の凍結の欄（「期待値レビュー済み」とは書かず、事実の範囲）、pin の全件照合（32 pin・72 file、食い違い 0。t14 の pin を `constants.mjs` の現在の bytes に取らない判断と、`boundFiles` に freeze.v2 を足さない判断は妥当）、S2 の 23 の葉の扱い（v2 に直した 20、v1 のまま残した 3）、validator の変異（29 件、弱めなし。`nir1-graph` 125/125 を再現）。
- **K2/4 :418-420 の独立 reviewer の確認として使える**：`declaration-addendum.v2.json` の G-04 の行（`g04-lio-landing`、reading 20／100、excerpt [0,211)、veto なし、A1 は既定の explicit で exact）を fixture v2 と K2/4 の規則から**自分で導いて**一致。v1 の 4 行・負例 3 件・値の一致、`supersedes` の `cf1c83e3` が祖先で sha256 が `82b05bae…`、setupOrder が同じ文で宣言の段がその外、`K24-G04-N1` の形も確認。ただし記録の束縛の手続きが要る（P2-1）。
- P2-1：宣言の addendum v2 の `review` が引く B2a の記録は「K2/4 :418 の独立 reviewer の記録はまだ無い」と書いている。→ この記録を束縛する。
- P2-2：①の取り直しは、K6/4 :317（R5 は K6/4 の凍結 `5dea38af` より前）を、時期と候補を選ぶだけでは満たせない。(α) 順の逸脱を開示して進む（reviewer の推奨。:317 は「確認後の記録」〔:312〕の下の手順の提案で判定の条項ではない）か、(β) 同じ bytes で K6/4 を凍結し直す（`constants.mjs` が変わるので SP-N の記録をもう一度取り直す）。
- P2-3：limits (h) の開示漏れ。trace の `project.setup` は declaration-addendum.v1.json も名指しするが、runner（`trace-frozen.mjs`:544-545）は v2 を読む。G-02 の行は同じ値。
- C1（SP-N の取り直し）：同意。規則の 16 file が最終の bytes になった後、S4b''' の直前の commit で行う。C2（①の 13 variant すべての取り直し）：同意。`verifyR5CheckRecord` は v2 の plan で SP-P2 を計算し直すので、v1 の受領書は通らない。13 行に同じ runId も求める。C3（trace を v1 のまま）：同意。より強い根拠は K6/2 の手順 4（:702）「CP-4 の receipt を見た後に trace を作り直さない。作り直せるのは不備があるときだけ」。
- 取り直しが要る記録：①の記録（`21ed9a9c`）、②' SP-N の記録（`2d33e6a8`）。K6/4 の凍結 commit `5dea38af` と ② の記録 `k64-freeze-record.md` は C2 の選択次第（(α) なら当たらない）。当たらない：K6/4 の検出力の記録（規則の 5 file は `86427ee5..HEAD` で変わっていない。運用条件 (11) で取り直す予定）、trace 2 file、K6/4 の手順 v1、SP/1 の bytes（`cd04629e`）、DA-1 の受入れ（none）と unrestricted、期待値レビュー `8857f618`、再 probe `a27660e0`、`12a738ac`（限界は開示済み）、S3 の 7 回目（範囲外であることを開示する必要がある）。
- `review-s4pre.md` が本体。
