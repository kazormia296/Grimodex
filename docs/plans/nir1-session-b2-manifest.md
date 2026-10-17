# NIR-1 Session B2 提示版の manifest

Session B2 で同時に示す draft の版を、ここに一括で記録する。draft の本文は、同時に示す他の draft を文書名と節名で引き、sha256 と行番号は書かない（引用の規則）。

- 基点: origin/master a7666048（記録時。Session B1 の確認の記録〔#667〕を含む）
- Session B1 の manifest（`nir1-session-b1-manifest.md`）は B1 の提示時点の記録で、その K2/4 の行は B1 の時点の版である。B2 で示す K2/4 の版は、この表が正本
- 時刻の表記は継続計画 §1 に従う
- 2026-10-17: K2/4 は、Session B1 の提示の後に、確認前の review の P3 と最終確認の指摘を直した（意味と確認文は変えていない）。proposal/7 は新しい draft

| 略称 | contractId | ファイル | 行数 | sha256 |
|---|---|---|---|---|
| K2/4 | graph-target-scene-body-disclosure / scope-storage-authority | `docs/plans/nir1-c-body-disclosure-proposal-4-draft.md` | 725 | `efc30cca32f2c91386baf3061836427ae7df3499c18188d31b5e2ba422a2fcfd` |
| proposal/7 | graph-limited-binding | `docs/plans/nir1-l6-l9-contract-proposal-7-draft.md` | 301 | `13fb0e6d410dbf073b219b9c1e384bfdc57239ac331434c6fe45aa0dad3aca29` |

proposal/7 の測定の記録（`docs/plans/nir1-lane-decisions/proposal7-measurement/`。draft と一緒に取り込む）の `SHA256SUMS` の sha256: `be8734432396fbbc98c7e6303e6edfbbd26f0c3a0735fd7ba59e11a16f1aeac6`（proposal/7 の「測定の記録」の行の値と一致する）。

確認文（この表の版の本文の「確認文」の節にある文。確認はユーザー本人が入力した、1字違わない文だけが有効）:

- K2/4: I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId graph-target-scene-body-disclosure.
- K2/4: I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId scope-storage-authority.
- proposal/7: I confirm draftRef nir1-l6-l9-contract-proposal/7 for contractId graph-limited-binding.

提示の前に integrator が、この表の sha256 と各 draft の引用先の節名を照合する。draft を直したら、この表を更新してから示す。
