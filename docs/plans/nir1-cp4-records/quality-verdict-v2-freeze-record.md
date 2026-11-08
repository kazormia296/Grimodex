# CP-4 の品質判定の事前登録 v2 の確定の記録（2026-11-08）

品質判定の事前登録 v2 §0・§5 の 3 に従う、integrator の作業記録。§0 の検査の入力（`--remote-time-record`）に使う値をここに置く。

| 項目 | 値 |
|---|---|
| v2 の確定版の file | `docs/plans/nir1-cp4-records/quality-verdict-prereg-v2.md` |
| v2 の確定版の SHA-256 | `2bb071968281523e4f79d076f7e3e06e1f3404238dfbe93885690f030bc8024a` |
| v2 の commit | `8b2a5dafc22bd344f7572b4adbfb3018f7363245`（枝 `claude/nir1-contracts`） |
| v2 の remote 側の時刻（repository activity） | `after=8b2a5daf… before=d69c000b… timestamp=2026-11-08T10:49:28Z`（取得 10:49:38Z） |
| 実装の commit | `7652a86e2252eec55a22143921c33f81a481e48c`（枝 `claude/k66-harness`、PR #840） |
| 実装の remote 側の時刻（repository activity） | `after=7652a86e… before=b567ef61… timestamp=2026-11-08T10:47:05Z`（取得 10:49:38Z） |
| 草稿 | `quality-verdict-prereg-v2-draft.md`（SHA-256 `41520857e22d8ac1c591a3fc259142480d8e9717f53df6acae75f8d5b1212838`） |

## 独立のコードレビュー（§0）
- Opus（read-only）が 3 回レビューした。対象と結果は次のとおり。
  - 1 回目（head `fe7e783b`）：P1 1・P2 3・P3 4。
  - 2 回目（head `b567ef61` と確定版の起案 `237be49b…`）：P1 1・P2 1・P3 4。
  - 3 回目（head `7652a86e` と確定版 `7dd36e85…`）：**P1 0・P2 0**、P3 2。
- 3 回目の P3 2 件は、確定版の文面だけの直しで、この commit `8b2a5daf` に入れた（判定を変える差分は無い）。
- 実装の commit `7652a86e` は 3 回目のレビューの対象と同じ bytes で、レビューの後に実装の変更は無い。
- 起案者の結論はレビューに渡していない。ただし、レビューは同じ agent が続けて行ったので、2 回目以降は前回の自分の指摘を知った上でのレビューである。

## 残る確認（S4 の 7 回目の凍結の前）
- `pubg16-e2e-run.mjs` の `readG01DiagnosticHead` は、実リポジトリの git でまだ走らせていない。dev の予行で、G-01 の診断の受領書に head が書けることを確かめる。
- PushEvent（`gh api repos/kazormia296/Grimodex/events`）は、取得した時点では見ていない。出たら追記する（fast-forward だけ）。

## 確定の後の規則
- v2 の確定版の定義は変えない。変えるなら v3 を作り、変える前の結果を残す（v2 §0）。
- v2 で判定する正式 run は、上の 2 つの remote 側の時刻より後に始めたものに限る（§0 の検査）。
