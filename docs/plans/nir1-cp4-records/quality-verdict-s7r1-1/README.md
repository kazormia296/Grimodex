# CP-4 品質の判定（s7r1。S4b `f2f99b13`・候補 `3f333a83`・K6/6・品質判定 v2）

手順外の補助の記録（正式の判定ではなく、それを置き換えない）。根拠は DR-CP4-QV-0・QV-1 と品質判定 v2（`../quality-verdict-prereg-v2.md`、確定版 commit `8b2a5dafc22bd344f7572b4adbfb3018f7363245`。実装 `7652a86e2252eec55a22143921c33f81a481e48c`）。S2・S4 の bytes、閾値、Gold、fixture、受領書は変えていない。S6 の集計は `../s6-aggregation-s7r1/`。

- 実行：`quality-verdict-cli.mjs --root <候補の worktree cp4-formal-k66> --v2-file ../quality-verdict-prereg-v2.md --v2-commit 8b2a5daf… --impl-commit 7652a86e… --remote-time-record remote-time-record.json --sp-p4-dir ../sp-p4-s7r1-1 --trace-dir ../traces-s7r1-1 --parity-dir ../parity-s7r1-1 --gold-dir ../gold-s7r1-2 --negative-dir ../negatives-s7r1-1 --g01-diagnostic-dir ../g01-e2e-s7r1-1 --allow-list allow-list-s7r1-s4-f2f99b13-candidate-3f333a83.json --ledger ../attempts-final-s7r1/gold-s7r1-2.json`（Node 22）。`--verify` は `bindings match`。
- **Gold は `gold-s7r1-2`（2 回目。13 variant）を読む**。1 回目（`gold-s7r1-1`。`[precheck] V-10` で停止、台帳 stopped、3 variant）は判定に数えず、S6 README 5 と S7 報告で開示する。
- v2 §0（remote 時刻）：`remote-time-record.json` の 2 件は GitHub の repository activity（`gh api repos/kazormia296/Grimodex/activity`。統合者が 2026-11-09 に再確認）で、v2 確定版 `8b2a5daf` は 2026-11-08T10:49:28Z（`claude/nir1-contracts`）、実装 `7652a86e` は 10:47:05Z（`claude/k66-harness`）に push された。どちらも最初の正式 run（SP-P4 の開始 2026-11-08T17:45:09Z）より前。
- 全体：**hold（unverified-required-items）**。前回（s6r1）は hold（failed-required-items、held-required-items）。今回は fail・hold の条件が無く、残るのは受領書に無い項目の not-evaluable だけ：既存 24 件の Graph arm の受領書が無い、evidence の utf16-range・explicit-pin-association・raw-excerpt-unchanged・added-scene-body-anchor、禁止寄与の (c)。内訳は `quality-verdict-s7r1.md`。
  - G-01 の事前指定改善 pass、macro 非回帰（G-case 13 variant）pass、Hybrid p95 pass（R+IR arm 22.60 ms、Graph arm **92.70 ms**、各 n＝390、上限 94.2 ms。**余裕は 1.5 ms**）。edge の束縛 pass（9 variant、検査 270、検査できず 0）、禁止寄与の (a)・(b) pass（違反 0）。
  - Graph arm の p95 は前回の 60.20 ms から上がった（Graph の結果が窓内に届く sample が増えたため。機構は未確認）。variant 別の p95（開示）は G-04/base 116.5、G-02/base 108.3、G-07/base 100.8、G-05/base 100.3 ms が 94.2 ms を超える。判定は G-case の母集団全体の p95 で、variant 別では判定しない。
- この判定は S6 の可用性の集計とは別の補助で、S6 の規則を置き換えない。
