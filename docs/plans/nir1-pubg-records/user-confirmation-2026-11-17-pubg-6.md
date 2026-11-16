# ユーザーの回答の記録：PUB-G #6（A3 の全 Scope 軸の証拠）（2026-11-17）

- 経路：Claude Code の AskUserQuestion（1 問）
- 材料（contracts の外）：`/home/grimodex/fusion-eval-data/pubg-a/06-decision.md`、`06-30.md`

## 質問の要旨

- s7r2 の受領書に出た A3 の不適格の理由は、5 種だけだった。
- 次の 5 つの軸は、製品の経路で一度も観測されていない。
  - POV
  - phase
  - story-scope
  - auto-scope
  - query
- 軸の分岐は `nir1_entity_relation.rs` の 1 つの関数に集まっている。その大半は、Rust の試験（#598）が覆っている。
- ただし、理由を名指しで確かめる試験には抜けがある。とくに auto-scope が薄い。worker・IPC・画面を通す試験は無い。
- G-case を足して測ると凍結の変更になる。その場合、s7r2 の判定は使えなくなり、10 回目の S4 になる。

## 回答

**「試験を足して開示する (Recommended)」**

- Rust の試験で足りるとみなす。そのうえで、次の 2 つを足す。
  - 名指しで固定されていない理由の試験
  - Graph が fail-closed に落ちることを確かめる結合試験 1 本
- 開示には、次の旨を書く。
  - 製品の経路で実測した理由は 5 種だけ
  - ほかの軸は、Rust の試験だけで確かめた
- 凍結には触れない。PR の merge は、次の S4 の PR の merge の後に行う。
