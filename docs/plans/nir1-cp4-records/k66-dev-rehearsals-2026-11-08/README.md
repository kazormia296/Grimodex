# K6/6 の dev の予行の全回の記録（2026-11-07〜08）

K6/6 の threat model の「dev の予行」の 1（試した全回の記録を残す）のための写し。元は dev 枝 `claude/k66-harness-proto`（未 push）の `docs/` で、写した時点の HEAD は `908e3181`。予行の結果は予告で、/6 の判定には使わない。

| file | 中身 |
|---|---|
| `k66-dev-rehearsal-1.md` | 確認の前の予行 1〜3（予行 2 は precheck で停止）。予行 3 の G-08/graph-recovered の 30 件の落ち（dev の fixture の形）と、integrator の判断 |
| `k66-dev-rehearsal-2.md` | 確認の前の予行 4・5（fixture を直した後。予行 5 は FR-7 125/125、止める条件に当たらない。品質の予告の G-08/chronicle-index-unusable の FAIL は予告の読みが D3 を入れていなかったため） |
| `k66-dev-rehearsal-3.md` | 確認の後の予行 6（実装した harness `7652a86e`。FR-7 130/130、止める条件に当たらない、品質の予告は FAIL 0・hold 1。G-01 の診断の head を実 git で書けることを確かめた） |
| `k66-harness-proto-notes.md` | 試作の、K6/6 の表の行ごとの対応 |

- 確認の前の予行で fixture を直して取り直したこと（予行 3→4→5）は、K6/6 改訂 3 の「fixture の直しで取り直すのは件数不足のときだけ」との関係で、integrator の判断（確認の前の非判定の予行で、dev の fixture の形による構造的な落ちと判断した）として `k66-dev-rehearsal-1.md` に書いてある。確認の後の予行 6 では、fixture の直しも取り直しもしていない。
- SHA-256 は `SHA256SUMS`。
