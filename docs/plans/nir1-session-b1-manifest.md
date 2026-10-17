# NIR-1 Session B1 提示版の manifest

Session B1 で同時に示す draft の版を、ここに一括で記録する。draft の本文は、同時に示す他の draft を文書名と節名で引き、sha256 と行番号は書かない（引用の規則）。

- 基点: origin/master 0648b897（記録時）
- 時刻の表記は継続計画 §1 に従う（SB-1: 2026-10-13 19:40 JST、SB-2: 2026-10-14 04:06 JST、SB-3〜SB-5: 2026-10-14 10:02 JST）
- Session B2 の K2/4 は別に示すが、版の照合のためここに載せる
- 2026-10-17: Session B1 の統合の 4 回目（残る P3 の直し）で、K3/2、K4/3、K5/3、K6/2、X1/1 と DSN の sha256 と行数を更新した。確認文、題、Status、推奨は変えていない。K2/4 は変えていない

| 略称 | contractId | ファイル | 行数 | sha256 |
|---|---|---|---|---|
| K3/2 | caller-profile-egress | `docs/plans/nir1-d2a-activation-proposal-2-draft.md` | 627 | `a16e8b259f8b58e53152e5bb2e503f3cf995f979d85bf4922ccd420f6bf5fd30` |
| K4/3 | history-reauthorization | `docs/plans/nir1-d2b-history-mapping-proposal-3-draft.md` | 997 | `f6a189371b4d793c0c440d2ee1d0c96d66c60069d35fa95d31e5c971701a99d7` |
| K5/3 | nir1-local-product-send / caller-profile-egress | `docs/plans/nir1-d2b-local-send-proposal-3-draft.md` | 764 | `5a8962cd9aa5525046349b31af825c4637dc152e2bb1c5d348fc2bc8fb576723` |
| K6/2 | nir1-final-request-packing-eval / g01-eval-revision / graph-eval-procedure | `docs/plans/nir1-final-request-eval-proposal-2-draft.md` | 801 | `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` |
| X1/1 | scope-storage-authority / typed-revision-material | `docs/plans/nir1-scene-scope-projection-proposal-1-draft.md` | 739 | `a2d85d92f4f737405922c5fefbe9acf732a8d784a27c6a2f79894c6278dc6c5e` |
| DSN | 設計メモ（確認の対象ではない） | `docs/plans/nir1-dsn-2026-10.md` | 1023 | `10eb61d21d6edc5d9b0bab1c80055e364ec40c9ad4e9e4a45495d76a11f304d5` |
| K2/4 | graph-target-scene-body-disclosure / scope-storage-authority（Session B2） | `docs/plans/nir1-c-body-disclosure-proposal-4-draft.md` | 691 | `c70bc2118a243cc9bbb6994aebc39a630a3a57a855acfbce70b89246ce336e70` |

提示の前に integrator が、この表の sha256 と各 draft の引用先の節名を照合する。draft を直したら、この表を更新してから示す。
