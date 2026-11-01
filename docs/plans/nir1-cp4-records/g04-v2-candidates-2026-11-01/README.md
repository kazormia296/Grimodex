# G-04 fixture v2：候補の作者の出力と admission probe の結果（2026-11-01）

**ユーザーの確認ではない**。integrator（Claude）の実行記録。手順は `user-confirmation-2026-11-01-g04-v2.md`（`4206df12`）で確認された設計（δ＝0.03、全候補を測る、固定の順の最初の合格を採る、全候補が不合格の項目があれば v2 を作らずユーザーに戻る）。

## 1. 手順の実際

1. 変える項目の確定（probe の実行者、別の agent）：v1 の bytes に同じ script を当て直し、不合格の項目を機械で決めた。**lio-landing の IR 要約（0.5559）、rv-match の本文（0.4925）、rv-unknown の本文（0.4390）**の 3 つ（設計案の見積りと一致）。
2. 候補の作者（別の agent、Opus、診断の記録・cosine・閾値・設計案を**渡していない**）に、`materials.md` だけを渡した。作者の報告では、読んだのは `materials.md` だけで、書いたのは `author-output.json` だけ、測定や Bash の実行はしていない（tool 使用 3 回。integrator は作者の作業の記録を直接は確かめていない）。
3. integrator が候補を `cand.json`（order 1〜9。項目 A → B → C の順、各項目は作者の並びの順）に機械で移し、測定の前に sha256 を固定した：
   - `author-output.json` `9179636d0dedd5e2ca2416c55de2718d3b1985be8845712cbae4d727881ccf9a`
   - `cand.json` `5415993a81ca42af05203af20d93393d2a49a7d52a6da43742de4c1318797bc8`
   - `materials.md` `9d2c36bb26fb7952fc4fc700ac7929316baa43569116f5d7f19f2a5e5406591d`
   - `probe.mjs` `8fcc9010c35de49b84fc3dabdaccf489854b885a75e4d12d8a9feb193816ce21`（確認した script と同じ）
4. 機械の事前確認（integrator）：9 件すべてが長さの範囲内、B・C に Entity 名なし、疑問文なし。語彙の隔離は作者の手判定のみで、**機械の検査（`pnpm eval:fixtures` の語彙の検査）はまだ通していない**（v2 の bytes を組む段階で通す予定だった）。
5. 全 9 候補を 1 回で測った（`probe.mjs <v1 fixture> --candidates cand.json`、`cand-out.json`）。再測定や追加はしていない。

## 2. 結果（候補ごとの対象項目の値。1 項目だけを置き換えた仮の fixture）

| 順 | 項目 | 文字列 | sha256（文字列、UTF-8） | 値 | 条件 | 合否 |
|---|---|---|---|---|---|---|
| #1 | irSummary:g04-lio-landing | Bren, the river's ferryman, carried Lio across and set her down on the far stones at dusk. | `726f3bc1992a2f428e44ecc4bf43654d0bef88a078bcf7c4fd8ee32074947c35` | 0.6621 | IR cos >= 0.69 | 不合格 |
| #2 | irSummary:g04-lio-landing | Bren, the ferryman, carried Lio across the river to the far stones at dusk. | `388b195023dd8424e4a936d9bd6706922d5e62e73c591e654023e41cc6af8fda` | 0.6768 | IR cos >= 0.69 | 不合格 |
| #3 | irSummary:g04-lio-landing | Bren, who runs a flat ferry, carried Lio across the river and set her on the far stones at dusk. | `e875c007f290eddd3b15debf529308f8154d9e1e8111199733c1798d8dcd15f1` | 0.6490 | IR cos >= 0.69 | 不合格 |
| #4 | sceneBody:g04-rv-match | Chalk tallies lined a weathered post beside a quiet dock. | `450107adb43444231b83830c4139ece4661f04908e16702e9b61befeff8e9686` | 0.3908 | Raw cos <= 0.43 | 合格 |
| #5 | sceneBody:g04-rv-match | Notches crowded a pale wooden post by the harbor wall. | `f4e5a5beff8637b8ff84ec7b005629b982511981e887c82d97627981236357b2` | 0.4357 | Raw cos <= 0.43 | 不合格 |
| #6 | sceneBody:g04-rv-match | Rows of tally marks covered a gray post in the sun. | `b5d2dcb4b19ffad1ab4b52154f0471dbb085f8aabc577874033545f40c3e7dc4` | 0.4224 | Raw cos <= 0.43 | 合格 |
| #7 | sceneBody:g04-rv-unknown | Rain dripped from the eaves of a silent inn. | `3edf6ec72d3ed4b4fcb5bf66ce0cd9d4252441c677f940cbb16822dab1e183f5` | 0.4293 | Raw cos <= 0.43 | 合格 |
| #8 | sceneBody:g04-rv-unknown | Dry leaves gathered on the steps of a shuttered inn. | `a81ac395d7fa80cac0809a322d13161ebbb680b25cf146033736939e2fb6edd9` | 0.3746 | Raw cos <= 0.43 | 合格 |
| #9 | sceneBody:g04-rv-unknown | A cold hearth sat beneath dusty beams in the inn. | `5227a409432d0696376ffcf58c7d1666b5ede4ce1ddcb8cf63fd8de864ef0cdc` | 0.4098 | Raw cos <= 0.43 | 合格 |

- 合格条件：lio-landing の IR cos ≥ 0.69（floor 0.66 ＋ δ 0.03）、control 以外の Raw cos ≤ 0.43。
- **項目 A（lio-landing の IR 要約）は 3 件とも不合格**。#2 の 0.6768 は製品の floor（0.66）を超えるが、固定した合格条件（0.69）に 0.0132 届かない。#1 は 0.6621、#3 は 0.6490（floor 未満）。
- 項目 B は #4 が最初の合格（0.3908）。#5 は 0.4357 で不合格、#6 は 0.4224。
- 項目 C は #7 が最初の合格だが、**余裕は 0.0007** と極めて薄い（#8 は 0.3746、#9 は 0.4098）。固定の順の規則では #7 が採られる。
- 手順の規則（設計案 §3.2 の 4、§7.2 Q3）：A に合格がないので、**v2 は作らずユーザーに戻る**。候補の追加、δ の変更、言い回しの修正は行っていない。B・C の「採る候補」の選択は A の扱いが決まるまで確定しない（A が決まらなければ v2 自体が作られない）。

## 3. 開示すべき点

- 作者は、役割の名詞と動詞を使う G-05 の形（`ferryman`、`carried`）にそろえて A を書いた。それでも最大 0.6768。query の語（`ferryman`、`carried`、`across`）を共有しても、陳述文の IR の cosine は 0.69 に届かなかった。
- 値は model-only の予測で、測定に数えない（probe の注記のとおり）。sparse（FTS5）と RRF の順位は再現しない。probe の query と製品の保存ベクトルの cosine の差は、独立の case で最大 0.0150（設計案 §4.3、付録 A）。#2 の 0.6768 は floor を 0.0168 上回る。
- v1 の bytes、fixture、schema、validator、README、manifest は変更していない。
