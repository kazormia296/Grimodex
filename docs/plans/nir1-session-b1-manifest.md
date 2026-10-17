# NIR-1 Session B1 提示版の manifest

Session B1 で同時に示す draft の版を、ここに一括で記録する。draft の本文は、同時に示す他の draft を文書名と節名で引き、sha256 と行番号は書かない（引用の規則）。

- 基点: origin/master 0648b897（記録時）
- 時刻の表記は継続計画 §1 に従う（SB-1: 2026-10-13 19:40 JST、SB-2: 2026-10-14 04:06 JST、SB-3〜SB-5: 2026-10-14 10:02 JST）
- Session B2 の K2/4 は別に示すが、版の照合のためここに載せる

| 略称 | contractId | ファイル | 行数 | sha256 |
|---|---|---|---|---|
| K3/2 | caller-profile-egress | `docs/plans/nir1-d2a-activation-proposal-2-draft.md` | 627 | `be8207200d3eada77a452b196be41a11563969ce8b07356e7aeb34038020da78` |
| K4/3 | history-reauthorization | `docs/plans/nir1-d2b-history-mapping-proposal-3-draft.md` | 996 | `b41c2ad4624e9346e5467d53f84d59ba0a7e2ab12920163ccfd8ecaade33e4bf` |
| K5/3 | nir1-local-product-send / caller-profile-egress | `docs/plans/nir1-d2b-local-send-proposal-3-draft.md` | 763 | `5adb44eaa0919927e3abe5be7ff0bb83e3ba2375bc58219f988f4301c6c61825` |
| K6/2 | nir1-final-request-packing-eval / g01-eval-revision / graph-eval-procedure | `docs/plans/nir1-final-request-eval-proposal-2-draft.md` | 800 | `c29b785a695dbe44ccc7ff04dfd08db73eddf95804545c0bf9bfdec2d6b9b1c3` |
| X1/1 | scope-storage-authority / typed-revision-material | `docs/plans/nir1-scene-scope-projection-proposal-1-draft.md` | 738 | `a8a8d8ea86d9420f44a54efa705b20d5352e6d5d95589232e0ba46576e970343` |
| DSN | 設計メモ（確認の対象ではない） | `docs/plans/nir1-dsn-2026-10.md` | 1023 | `926a4dc0eb8577cc853b124960bfa6a2d4899ea8e44444a49e6674f9bc3b64d2` |
| K2/4 | graph-target-scene-body-disclosure / scope-storage-authority（Session B2） | `docs/plans/nir1-c-body-disclosure-proposal-4-draft.md` | 691 | `c70bc2118a243cc9bbb6994aebc39a630a3a57a855acfbce70b89246ce336e70` |

提示の前に integrator が、この表の sha256 と各 draft の引用先の節名を照合する。draft を直したら、この表を更新してから示す。
