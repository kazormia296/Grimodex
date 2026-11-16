# ユーザーの回答の記録：PR-3 の dev gate（DR-DBC-7 の gate）の扱い（2026-11-16）

- 経路：Claude Code の AskUserQuestion（3 回）
- 対象：次の S4（9 回目）に入れる PR-3（DR-DBC-7）。枝 `claude/s4-9-pr3` の `977d30be`、base は master `3948eeb2`
- 位置づけ：dev 専用で判定に使わない gate（凍結外の dev-shape fixture）の扱いを決めたもの。閾値・Gold・fixture・契約は変えていない。新しい線は置いていない。
- 材料（contracts の外）：`/home/grimodex/fusion-eval-data/db-stage1-pr3-2026-11-15/` の `dev-gate/`、`probe-gc/`、`dev-gate2/`、`dev-gate3/`、`r10-real-worker.md`

## 1 回目（2026-11-15T21:52Z ごろ。回答の直後の記録の時刻）

- 質問の要旨
  - head だけに、約 100 s 付近で一度きりの遅れ（120〜175 ms）が出た。
  - 項目 C の probe は原因ではない。
  - gate の定義（各 3 run 以上、HDD と tmpfs）に届いていない。
- 回答：**「本数を足して真因も採る (Recommended)」**
- 訂正：質問文の件数「base 8 run で 0 件、head 7 run 中 5 件」は誤りだった。正しくは「base 4 run で 0 件、head 8 run（dev-gate 4・probe-gc 4）で 5 件」。2 回目の質問文の中で訂正した。

## 2 回目（2026-11-16T03:02Z ごろ）

- 質問の要旨
  - 32 run（HDD と tmpfs、各 side 4 run）の結果、最初の遅れは再現しなかった。
  - HDD でも、head が base の幅の外に悪い方へ出た run が 2 本あった。
  - 別 session の負荷が同居していた。
  - gate の未測の項目が 3 つある（R-10 の real worker での確認、registration の窓 W、begin→query）。
- 回答 1：**「静かな時間帯に取り直す (Recommended)」**
  - HDD だけ、各 side 4 run。
  - 開始の前に ps で別 session の重い process が無いことを確かめる。
  - load の待ちが時間切れになったら打ち切る。
- 回答 2：**「1 だけ確かめ、2・3 は開示 (Recommended)」**

## 3 回目（2026-11-16T05:56Z ごろ）

- 質問の要旨
  - 静かな時間帯の 16 run では、graph arm の stall は 0 対 0、p50・p95 の差は 1 ms 以内だった。
  - head が base の run 間の幅の外に出たのは 3 件（g03 の max +6.0 ms、g06 の p50 +0.2 ms、g06 の p95 +0.9 ms）。
  - 逆向きの外れもあった（frontier の max は base 84.2・head 64.0、g06 の max は base 63.6・head 52.7）。
  - 「4 run の最大を超えたか」という規則は、両 side が同じでも約半分の確率で超える。
  - R-10 は real worker の dev 試験で、head は Available、base は Stale（各 1 回）。
  - 規則を字義どおりに当てると「止まって伺う」に当たるので伺った。
- 回答：**「悪化なしとして進める (Recommended)」**
  - 経緯、超過の 3 件、逆向きの外れ、未測の W と begin→query、R-10 の結果は、DR-DBC-7 と PR 本文に書く。
  - p95 の合否は、正式 run で今の上限のまま判定する。

## 範囲

この回答に含まれないもの：

- 閾値の緩和
- Gold・fixture・契約の変更
- 製品の公開・PUB-G の承認
- 正式 run の開始
