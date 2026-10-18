# NIR-1 Session B3 提示版の manifest

Session B3 で示す draft の版を、ここに記録する。draft の本文は、他の draft を文書名と節名で引き、sha256 と行番号は書かない（引用の規則）。

- 基点: origin/master a789039a（記録時。#678 CQ-LIM を含む）
- 時刻の表記は継続計画 §1 に従う
- 2026-10-18: K3/3 は新しい draft。DA-1 の ST1 の Y-1 の試走が見つけた renderer の外向き通信（WebRTC の TURN／TURNS、UDP の IP literal、名前解決）を Main の network 層で塞ぐ設計を、実機で検証して起案した。ユーザーは 2026-10-18 に、案1（構造的に塞ぐ設計を起案する）を選んだ（確認文ではない）

| 略称 | contractId | ファイル | 行数 | sha256 |
|---|---|---|---|---|
| K3/3 | caller-profile-egress | `docs/plans/nir1-d2a-activation-proposal-3-draft.md` | 432 | `e5362f3e40e662781d57c46d20db617aded3c7d4cf72912c0d27991b0dbded11` |

K3/3 の測定の記録（`docs/plans/nir1-lane-decisions/webrtc-closure-measurement/`。draft と一緒に取り込む）の `SHA256SUMS` の sha256: `4ac3cc8a68d54ed5fe13b9b55ab4631174a5a01b87a9257dadb8ec561468f144`（K3/3 の「測定の記録」の行の値と一致する。`LC_ALL=C sha256sum -c SHA256SUMS` が 130 件すべて通る）。

確認済みの baseline: K3/2 `docs/plans/nir1-d2a-activation-proposal-2-draft.md`（SHA-256 `a16e8b259f8b58e53152e5bb2e503f3cf995f979d85bf4922ccd420f6bf5fd30`。2026-10-17 の Session B1 で確認済み。bytes は変えない）。

確認文（この表の版の本文の「確認文」の節にある文。確認はユーザー本人が入力した、1字違わない文だけが有効）:

- K3/3: I confirm draftRef nir1-d2a-activation-proposal/3 for contractId caller-profile-egress.

提示の前に integrator が、この表の sha256 と draft の引用先の節名を照合する。draft を直したら、この表を更新してから示す。
