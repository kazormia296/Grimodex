# G-04 fixture v2（案 C）の S4 の最終関門（PR #774。2026-11-02）

**ユーザーの確認ではない**。最終関門の独立レビュー（別の agent、**Fable**、read-only。実装担当・これまでの各段階のレビュアー〔Opus〕とは別のモデル）の記録。対象は PR #774（`claude/g04-v2c-fixture`、先頭 `0b28c7ba`）、S4b'''（`60bf9dc44a5f751551a9ce0195abb87f5c97543d`、freeze record の sha256 `f203071ab1c2e628f80de41403b85dcfcabb7cd0a475d143c9bce1e30d3ba3c9`）。

## 判定：**go-with-conditions**（`gh pr merge --merge` で merge してよい。P1 なし、P2×2、P3×5）

- **admission を自分で再現できた**：scratchpad の一時 clone で origin/master `8187fbfc` に PR の先頭を `--no-ff` で merge した合成 M を作り（push なし）、(i) `collectObservationPrepFacts(S4b''', M)` が record の導入・remote の ref・候補の祖先すべて true、record の sha256 が commit と head で同じ、`assertObservationPrepAdmits` と `readAdmittedObservationPrep` が通る、(ii) 旧 S4b／S4b'／S4b''（`557e683c`）は `record differs`、前の版 2 つは `not an ancestor`、(iii) S4b''' 以外の commit は `did not introduce the freeze record`、(iv) 32 pin・72 file の全件照合で食い違い 0、(v) `validateNir1ObservationPrep` passed・formalReady。再現 script は `admission-check.mjs`、出力は `admission-check.out`。
- freeze record の boundFiles 7 件は S4a''' `02ede6bb` の bytes と一致。placeholder 20 種の埋め値を contracts の実物で照合（SP-N `20ccd115`〔`aef7c0a1…`〕、① `56d4ec54`〔`fa04baa4…`、13 受領書の sha256 が全件一致〕ほか）。`179139b4..0b28c7ba` の差分は DR・S2・freeze record・manifest 1 行・`observation-prep.test.mjs` の 5 file だけで、SP-N の 16 file と ① の閉包は不変。差分 34 file はすべて docs／evals／scripts/quality。製品・AGENTS・iron-laws・v1 fixture／freeze／addendum・trace 2 file は不変。fixture v2 の sha256 一致、binary／secret なし。
- 3 つの逸脱：(A) K6/4 の順（R5 は K6/4 の凍結より前）＝**(b) 条件つきで許容**（実質は満たす。字義は (β) 以外で満たせない）。(B) trace 2 file を v1 のまま＝(a) 許容（K6/2 手順 4〔:702〕が上位）。(C) contracts の枝を merge しない＝(b) 条件つき（push 済み・hash と sha256 で照合可。機械の門は見ない）。

## 条件と integrator の対応

- **C1（P2-1 の帰結）**：正式の run（④ SP-P4、⑤）は、**ユーザーが朝に逸脱 (A) を認めるまで始めない**。提示するときは K6/4 :317 だけでなく **:196（R5 の条項、本文、太字：「照合は、この draft の凍結の前の前提である」）、:279、:292、:302、批准 9（G-case の setup の変更は CP-0 側）** を引く。→ integrator は従う。④⑤ は始めない。merge は止める理由にならない（異議が出た場合の直し方 (β) は merge の有無で変わらない）。ただし merge の後は admission 上 ④⑤ を走らせられる状態になるので、「ack まで走らせない」は人の判断でだけ守られる。
- **P2-1**：逸脱 (A) の正当化「:317 は提案節で判定の条項ではない」は、K6/4 の本文 :196 などを見落としていた。開示の事実は正確だが根拠が不完全。S2 は frozen なので直さない（5 回目の S4 は不要）。→ PR 本文、contracts の記録、朝のユーザー提示、S7 で :196 と批准 9 を引き、「本文にもあるが、実質〔R5 の match の後にだけ判定を始める〕は満たし、字義は CP-0 側の setup の改版では構造上満たせない」と書く。
- **P2-2**：PR 本文の「④⑤ は merge の後」に ack の前提が無い。→ PR 本文に足す。
- **C2**：S6／S7 の前に contracts の 3 commit〔`20ccd115`、`56d4ec54`、`e42e9990`〕の sha256 を再照合し、contracts の枝が fast-forward だけで進んだことを S7 に書く。**C3**：PR 本文の運用条件に S7 の v1／v2 の並置を足す。
- P3：B1 の変異「27 件」の出所を見つけられなかった／S2 の `r5Gate.rule`・`k64FreezeAfterMatch`・`freezeNote` は事実と逆のまま（limits (i) で開示済み。frozen なので今回は直さない）／seed-pin v2・setup v2 の「下に書いた」未修正／① 閉包 42 vs 43 の数え方。確かめていないもの：全試験の再実行、`--verify` と SP-N 変異の再実行、CI checks。

`review-gate.md` が本体。
