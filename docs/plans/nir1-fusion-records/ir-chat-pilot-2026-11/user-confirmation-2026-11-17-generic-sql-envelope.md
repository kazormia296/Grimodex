# ユーザーの回答の記録：generic SQL で閉じる範囲（2026-11-17）

- 経路：Claude Code の AskUserQuestion（4 問のうち 1 問）。統合者（grimodex-ed）が伺った。
- 位置づけ：PUB-G の一覧の追記 6（contracts `736c1452`、generic SQL の非対称）への回答。資料は `/home/grimodex/fusion-eval-data/design-notes/generic-sql-envelope-asymmetry-question-2026-11-17.md`。確認済みの脅威モデル（`357a87b7`、SHA-256 `08f26f78…`）は書き換えず、追補で記録する。

## 質問の要旨

unrestricted の generic SQL の guard（`execute.rs:299-316`）は IR の本文を持つ列のうち `payload_json` だけを拒否し、同じ内容の `reconciliation_envelope_json` は読める。chronicle の IR では review bundle が同じ内容を返すので到達は減らないが、typed Entity/Relation の run では bundle が拒否するので、envelope を閉じると到達が実際に減る見込み。変更は公開の直前の凍結の前にまとめて入れる。

- 「envelope だけ閉じる (Recommended)」：約 2〜4 日。journey の読みを移す。製品の画面は壊れない。artifacts、review bundle、restricted の 28 表は変えない。脅威モデルは追補。
- 「envelope と artifacts」／「閉じずに開示だけ」

## 回答

**「envelope だけ閉じる (Recommended)」**

- unrestricted の generic SQL で `reconciliation_envelope_json` を拒否する（`plan_fragment_json` は中身を確かめてから決める）。
- artifacts の `payload_json`、review bundle、restricted の unlisted 28 表は変えない（28 表は確認済みの台帳のまま）。
- 時期：公開の直前の凍結の前に、journey の読みの移行とまとめて入れる。凍結の pin に当たる file を変える場合は、9 回目の正式 run の後に merge する。
