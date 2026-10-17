# proposal/7 の実測の記録（資源の上限の見直し）

この文書は `nir1-l6-l9-contract-proposal-7-draft.md` の数値の根拠である。draft には要約だけを書き、表の全体と生の出力はここに置く。再測は、下の harness を使い、同じ手順で行う。

## 条件

- 基点: `df40eec8`（#664 CQ-MEM の merge。CQ-OPT #657、B-GUARD #660、CQ-AVAIL #663 を含む。X1-3 は含まない）。
- 測定用の差分: `harness/measure-instrumentation.patch`（`git diff`。test の fixture と測定 test〔`p7_matrix`、`p7_worker`、`p7_native`、`p7_product`〕、worker の trace、Q と Native 領域を build 時に変える `MEASURE_Q_BYTES`／`MEASURE_NATIVE_BYTES`）。製品コードの挙動は変えない。定数の変更（上限を外した build、候補 A、候補 B）は、`harness/raised-constants.patch` の記述と `harness/build-*.sh`、`harness/matrix-candB.sh` の `sed` で行った。
- 1 台の Linux 機（共有。他の作業と重なる）。時間は目安で、Windows と macOS は測っていない。負荷は各実行の前後の `uptime`（`raw/uptime-*.txt`）に記録した。**R1 の時間は 1 分負荷平均 2.00〜2.25（5・15 分平均 2.8〜3.3。`raw/uptime-before-*.txt`）のとき、R2-6 は 1 分負荷平均が 3.84 から 10.72 に上がる間（`raw/r2/uptime-*-native.txt`）の値で、境界の場面数が動いた。**
- fixture は合成（実作ではない）。場面ごとに Entity／Relation を review して Revision を作る。cast は主要 5 人＋脇役 15 人（既定）。大 cast は 8+40 と 12+80。seed は m1〜m5（出現が多い順。m1〜m4 が主人公級、m5 は出現が少ない）と c01（脇役の筆頭）。
- 並べ方: R1 は round 1（`raw/` に生の出力）、R2 は round 2（`raw/r2/`）。R1 の表は生成物をそのまま写した。

## 再測の手順

1. 測る候補（既定は `df40eec8`。X1-3 の後の再測では、その merge 後の候補）の作業木に `git apply harness/measure-instrumentation.patch` を当てる。conflict したら、測定用の差分だけを載せ直す（製品コードの挙動は変えない）。
2. 定数を変えた build は `harness/build-*.sh`、`harness/matrix-candB.sh` の `sed`（`harness/raised-constants.patch` に一覧）で作る。worker は `MEASURE_Q_BYTES=<bytes> MEASURE_NATIVE_BYTES=<bytes> cargo build --release --locked -p grimodex-db --bin nir1-c-query-worker`、test は `cargo test --release --locked -p grimodex-db --lib --no-run`。script の `P`・`R` は測定した session の作業領域の絶対 path なので、置き換える。
3. 測定 test は `<test バイナリ> --ignored --nocapture --test-threads=1 <名前>`。名前と主な環境変数: `p7_matrix`（in-process。`P7_SHAPES`、`P7_SEEDS`、`P7_SUMMARY_CHARS`、`P7_CAST`、`P7_REPS`、`P7_NO_REVSIZES`）、`p7_worker`（worker 経路。`P7_WSEEDS`、`P7_WREPS`、`NIR1_C_QUERY_WORKER_BIN`）、`p7_native`（本番の親の経路。同じ）、`p7_product`（製品形と padding 形。`P7_CASES` は `p:`〔製品形〕、`w:`〔payload 形〕、`d:`〔decision〕、`e:`〔envelope〕、`P7_PRODUCT_REVISIONS`）。`P7_TAG` は出力の印。
4. 実行の前後に `uptime` を記録する。他の作業と重なる窓（負荷平均が 2〜3 を超える）では、時間の値を pass／fail に使わない。
5. 表は `harness/tools/*.py` と `harness/gen-r2-tables.py`（生の出力の path を置き換える）で作る。

## R1（round 1）の表

### 表1 現行上限の下での結果（worker 経路、期限 30 s、records 512／steps 100,000）
| S | review | m1 | m2 | m3 | m4 | m5 | c01 | available な seed 数（全 21） |
|---|---|---|---|---|---|---|---|---|
| 10 | fixed | available | available | available | available | available | available | 21/21 |
| 50 | fixed | records(512) | records(512) | records(512) | records(512) | available | records(512) | 8/21 |
| 10 | scene | available | available | available | available | available | available | 21/21 |
| 20 | scene | available | available | available | available | available | available | 21/21 |
| 30 | scene | steps | steps | steps | steps | available | steps | 14/21 |
| 50 | scene | records(512) | records(512) | records(512) | records(512) | available | records(512) | 8/21 |
| 80 | scene | records(512) | records(512) | records(512) | records(512) | records(512) | records(512) | 6/21 |
| 100 | scene | records(512) | records(512) | records(512) | records(512) | records(512) | records(512) | 2/21 |

### 表2 必要量（上限を外した build。seed ごと。records は 候補+A2+shared+A3）
| S | seed | Revision 数 | records（内訳） | steps | Entity | edge | binding | 入力 bytes | pages | lease（process 内）p50／max ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 | m1 | 9 | 229（30+81+79+39） | 47,944 | 10 | 21 | 26 | 174,862 | 16 | 27.8／30.7 |
| 10 | m2 | 9 | 225（26+81+79+39） | 47,786 | 10 | 21 | 26 | 174,646 | 14 | 27.9／28.9 |
| 10 | m3 | 9 | 223（24+81+79+39） | 47,736 | 10 | 21 | 26 | 174,541 | 14 | 28.3／29.3 |
| 10 | m4 | 9 | 218（19+81+79+39） | 47,341 | 8 | 19 | 24 | 174,266 | 10 | 28.5／29.9 |
| 10 | m5 | 2 | 100（3+11+79+7） | 10,806 | 1 | 0 | 2 | 41,247 | 1 | 6.2／7.1 |
| 10 | c01 | 8 | 199（11+74+79+35） | 42,902 | 7 | 14 | 22 | 158,905 | 8 | 25.8／26.6 |
| 20 | m1 | 18 | 411（53+161+119+78） | 92,662 | 11 | 40 | 50 | 343,673 | 18 | 55.1／66.4 |
| 20 | m2 | 19 | 415（50+165+119+81） | 95,749 | 11 | 40 | 52 | 354,552 | 17 | 56.9／63.1 |
| 20 | m3 | 18 | 399（41+161+119+78） | 92,304 | 11 | 40 | 50 | 343,034 | 16 | 55.2／59.1 |
| 20 | m4 | 18 | 393（35+161+119+78） | 91,884 | 9 | 38 | 48 | 342,706 | 12 | 53.9／58.5 |
| 20 | m5 | 4 | 162（7+22+119+14） | 20,034 | 2 | 1 | 5 | 78,238 | 3 | 11.1／11.4 |
| 20 | c01 | 16 | 356（20+147+119+70） | 83,062 | 7 | 28 | 44 | 312,037 | 9 | 47.6／49.0 |
| 30 | m1 | 27 | 589（73+240+159+117） | 137,084 | 13 | 59 | 74 | 510,858 | 21 | 78.8／84.0 |
| 30 | m2 | 28 | 596（73+244+159+120） | 140,275 | 13 | 59 | 77 | 521,898 | 21 | 80.0／83.9 |
| 30 | m3 | 27 | 576（60+240+159+117） | 136,595 | 12 | 58 | 73 | 510,163 | 18 | 78.4／80.0 |
| 30 | m4 | 27 | 570（54+240+159+117） | 136,310 | 11 | 55 | 71 | 509,840 | 16 | 78.0／79.1 |
| 30 | m5 | 6 | 223（10+33+159+21） | 29,106 | 2 | 2 | 8 | 115,171 | 3 | 16.3／21.9 |
| 30 | c01 | 24 | 512（28+220+159+105） | 123,167 | 7 | 39 | 63 | 465,061 | 9 | 70.3／73.5 |
| 50 | m1 | 45 | 954（119+401+239+195） | 226,665 | 13 | 99 | 124 | 849,826 | 24 | 132.4／144.0 |
| 50 | m2 | 47 | 967（118+409+239+201） | 233,022 | 13 | 99 | 130 | 871,853 | 24 | 140.9／150.0 |
| 50 | m3 | 45 | 931（96+401+239+195） | 225,899 | 12 | 98 | 123 | 848,593 | 20 | 132.0／136.6 |
| 50 | m4 | 45 | 922（87+401+239+195） | 225,539 | 11 | 93 | 120 | 848,111 | 18 | 132.0／162.9 |
| 50 | m5 | 10 | 344（15+55+239+35） | 47,221 | 2 | 3 | 13 | 188,984 | 3 | 26.9／31.8 |
| 50 | c01 | 40 | 827（46+367+239+175） | 203,786 | 7 | 67 | 107 | 772,661 | 10 | 117.9／124.1 |
| 80 | m1 | 72 | 1497（185+641+359+312） | 360,456 | 13 | 158 | 198 | 1,355,973 | 28 | 218.6／226.8 |
| 80 | m2 | 75 | 1517（184+653+359+321） | 370,004 | 13 | 158 | 207 | 1,389,040 | 28 | 226.1／229.1 |
| 80 | m3 | 72 | 1463（151+641+359+312） | 359,415 | 12 | 156 | 196 | 1,354,157 | 24 | 210.8／212.0 |
| 80 | m4 | 72 | 1449（137+641+359+312） | 358,903 | 11 | 148 | 191 | 1,353,402 | 21 | 212.9／225.8 |
| 80 | m5 | 16 | 526（23+88+359+56） | 74,431 | 2 | 5 | 21 | 299,738 | 4 | 42.8／44.1 |
| 80 | c01 | 64 | 1298（72+587+359+280） | 324,541 | 7 | 106 | 170 | 1,233,293 | 12 | 192.6／202.6 |
| 100 | m1 | 90 | 1858（228+801+439+390） | 449,608 | 13 | 198 | 248 | 1,693,304 | 30 | 256.9／261.7 |
| 100 | m2 | 93 | 1879（228+813+439+399） | 459,181 | 13 | 198 | 259 | 1,726,424 | 30 | 267.1／272.6 |
| 100 | m3 | 90 | 1819（189+801+439+390） | 448,442 | 12 | 195 | 245 | 1,691,223 | 26 | 259.0／262.8 |
| 100 | m4 | 90 | 1800（170+801+439+390） | 447,805 | 11 | 184 | 237 | 1,690,203 | 23 | 258.3／262.5 |
| 100 | m5 | 20 | 647（28+110+439+70） | 92,548 | 2 | 6 | 26 | 373,551 | 4 | 52.9／56.1 |
| 100 | c01 | 80 | 1612（89+734+439+350） | 405,134 | 7 | 131 | 211 | 1,540,793 | 13 | 234.3／246.9 |
| 120 | m1 | 108 | 2218（271+960+519+468） | 538,457 | 13 | 236 | 296 | 2,029,299 | 33 | 313.7／322.0 |
| 120 | m2 | 112 | 2246（271+976+519+480） | 551,221 | 13 | 236 | 308 | 2,073,459 | 33 | 321.2／326.1 |
| 120 | m3 | 108 | 2172（225+960+519+468） | 537,089 | 12 | 232 | 292 | 2,026,839 | 28 | 316.0／351.8 |
| 120 | m4 | 108 | 2151（204+960+519+468） | 536,402 | 11 | 220 | 284 | 2,025,713 | 25 | 319.7／345.0 |
| 120 | m5 | 24 | 769（34+132+519+84） | 110,688 | 2 | 8 | 32 | 447,417 | 4 | 63.6／66.3 |
| 120 | c01 | 96 | 1925（106+880+519+420） | 485,399 | 7 | 156 | 252 | 1,846,949 | 14 | 285.5／291.5 |
| 150 | m1 | 135 | 2761（337+1200+639+585） | 672,196 | 13 | 295 | 370 | 2,535,430 | 35 | 393.1／396.4 |
| 150 | m2 | 140 | 2796（337+1220+639+600） | 688,151 | 13 | 295 | 385 | 2,590,630 | 35 | 406.4／409.2 |
| 150 | m3 | 135 | 2704（280+1200+639+585） | 670,553 | 12 | 290 | 365 | 2,532,387 | 30 | 395.8／404.3 |
| 150 | m4 | 135 | 2678（254+1200+639+585） | 669,741 | 11 | 275 | 355 | 2,530,996 | 27 | 390.5／397.4 |
| 150 | m5 | 30 | 951（42+165+639+105） | 137,871 | 2 | 10 | 40 | 558,163 | 4 | 79.0／80.3 |
| 150 | c01 | 120 | 2396（132+1100+639+525） | 606,127 | 7 | 195 | 315 | 2,307,573 | 15 | 354.3／359.4 |
| 200 | m1 | 180 | 3669（449+1601+839+780） | 895,593 | 13 | 394 | 494 | 3,380,553 | 43 | 525.6／534.4 |
| 200 | m2 | 187 | 3717（448+1629+839+801） | 917,905 | 13 | 394 | 515 | 3,457,780 | 43 | 545.7／549.4 |
| 200 | m3 | 180 | 3591（371+1601+839+780） | 893,398 | 12 | 388 | 488 | 3,376,389 | 37 | 527.3／550.5 |
| 200 | m4 | 180 | 3557（337+1601+839+780） | 892,359 | 11 | 368 | 475 | 3,374,566 | 33 | 532.6／539.6 |
| 200 | m5 | 40 | 1254（55+220+839+140） | 183,200 | 2 | 13 | 53 | 742,730 | 5 | 104.9／107.3 |
| 200 | c01 | 160 | 3182（176+1467+839+700） | 807,497 | 7 | 262 | 422 | 3,075,805 | 18 | 474.8／480.7 |

### R1 worker 経路（現行の上限と、上限を外した build）

# raw/worker-sum0.txt
| S | seed | 結果 | registration hw | query hw | frame bytes | ready ms（p50） | lease（worker 内）p50／最大 ms | n |
|---|---|---|---|---|---|---|---|---|
| 10 | m1 | available | 1,223,927 | 1,333,306 | 49,231 | 54 | 29.2／29.6 | 5 |
| 10 | m2 | available | 1,223,927 | 1,317,403 | 49,231 | 53 | 28.7／29.9 | 5 |
| 10 | m3 | available | 1,223,927 | 1,350,579 | 49,231 | 54 | 28.8／28.9 | 5 |
| 10 | m5 | available | 1,223,927 | 1,288,521 | 1,855 | 54 | 6.3／6.4 | 5 |
| 10 | c01 | available | 1,223,927 | 1,312,630 | 36,250 | 54 | 25.8／26.5 | 5 |
| 20 | m1 | available | 1,223,927 | 1,416,934 | 91,410 | 103 | 57.4／59.5 | 5 |
| 20 | m2 | available | 1,223,927 | 1,428,365 | 92,784 | 103 | 58.3／59.3 | 5 |
| 20 | m3 | available | 1,223,927 | 1,435,189 | 91,410 | 103 | 55.9／57.5 | 5 |
| 20 | m5 | available | 1,223,927 | 1,392,443 | 5,538 | 104 | 11.9／12.0 | 5 |
| 20 | c01 | available | 1,223,927 | 1,392,375 | 70,065 | 104 | 50.3／50.4 | 5 |
| 30 | m1 | unavail:steps | 1,289,383 | 1,510,685 | 104 | 160 | 60.7／62.7 | 5 |
| 30 | m2 | unavail:steps | 1,289,383 | 1,510,081 | 104 | 161 | 58.2／58.8 | 5 |
| 30 | m3 | unavail:steps | 1,289,383 | 1,509,973 | 104 | 160 | 59.1／61.0 | 5 |
| 30 | m5 | available | 1,289,383 | 1,509,101 | 8,912 | 162 | 17.4／17.7 | 5 |
| 30 | c01 | unavail:steps | 1,289,383 | 1,508,961 | 104 | 161 | 60.8／62.2 | 5 |
| 50 | m1 | unavail:records(512) | 1,399,333 | 1,711,073 | 134 | 293 | 52.3／52.6 | 5 |
| 50 | m2 | unavail:records(512) | 1,399,333 | 1,709,973 | 130 | 304 | 51.8／63.7 | 5 |
| 50 | m3 | unavail:records(512) | 1,399,333 | 1,709,793 | 130 | 311 | 56.1／58.5 | 5 |
| 50 | m5 | available | 1,399,333 | 1,708,497 | 13,660 | 302 | 28.4／29.9 | 5 |
| 50 | c01 | unavail:records(512) | 1,399,333 | 1,708,285 | 134 | 299 | 52.3／59.9 | 5 |
| 80 | m1 | unavail:records(512) | 1,615,182 | 2,045,575 | 130 | 555 | 27.2／27.3 | 5 |
| 80 | m2 | unavail:records(512) | 1,615,182 | 2,043,871 | 134 | 561 | 24.8／25.4 | 5 |
| 80 | m3 | unavail:records(512) | 1,615,182 | 2,043,303 | 130 | 559 | 27.6／27.8 | 5 |
| 80 | m5 | unavail:records(512) | 1,615,182 | 2,042,167 | 130 | 557 | 42.6／45.1 | 5 |
| 80 | c01 | unavail:records(512) | 1,615,182 | 2,041,155 | 130 | 551 | 24.7／25.2 | 5 |
# raw/worker-raised-sum0.txt
| S | seed | 結果 | registration hw | query hw | frame bytes | ready ms（p50） | lease（worker 内）p50／最大 ms | n |
|---|---|---|---|---|---|---|---|---|
| 10 | m1 | available | 1,223,927 | 3,135,681 | 49,231 | 55 | 29.2／29.5 | 7 |
| 10 | m2 | available | 1,223,927 | 3,135,681 | 49,231 | 55 | 29.4／32.1 | 7 |
| 10 | m3 | available | 1,223,927 | 3,135,681 | 49,231 | 56 | 29.6／33.3 | 7 |
| 10 | m5 | available | 1,223,927 | 1,915,442 | 1,855 | 56 | 6.6／8.8 | 7 |
| 10 | c01 | available | 1,223,927 | 2,735,057 | 36,250 | 55 | 26.4／27.2 | 7 |
| 20 | m1 | available | 1,223,927 | 3,349,048 | 91,410 | 105 | 57.7／58.0 | 7 |
| 20 | m2 | available | 1,223,927 | 3,353,742 | 92,784 | 105 | 59.7／63.8 | 7 |
| 20 | m3 | available | 1,223,927 | 3,349,048 | 91,410 | 105 | 58.0／58.4 | 7 |
| 20 | m5 | available | 1,223,927 | 2,047,724 | 5,538 | 105 | 12.3／12.4 | 7 |
| 20 | c01 | available | 1,223,927 | 2,810,638 | 70,065 | 106 | 51.5／52.7 | 7 |
| 30 | m1 | available | 1,289,383 | 3,699,929 | 133,898 | 164 | 84.3／87.5 | 7 |
| 30 | m2 | available | 1,289,383 | 3,704,968 | 135,959 | 161 | 87.6／89.5 | 7 |
| 30 | m3 | available | 1,289,383 | 3,568,509 | 131,589 | 164 | 85.2／87.7 | 7 |
| 30 | m5 | available | 1,289,383 | 2,081,389 | 8,912 | 164 | 17.8／19.4 | 7 |
| 30 | c01 | available | 1,289,383 | 2,892,016 | 97,880 | 164 | 76.1／80.7 | 7 |
| 50 | m1 | available | 1,399,333 | 3,858,748 | 221,638 | 300 | 140.3／143.7 | 7 |
| 50 | m2 | available | 1,399,333 | 3,868,826 | 225,760 | 297 | 144.6／157.6 | 7 |
| 50 | m3 | available | 1,399,333 | 3,727,328 | 219,329 | 300 | 141.9／144.1 | 7 |
| 50 | m5 | available | 1,399,333 | 2,280,785 | 13,660 | 299 | 28.8／29.8 | 7 |
| 50 | c01 | available | 1,399,333 | 3,036,723 | 165,510 | 298 | 125.5／126.8 | 7 |
| 80 | m1 | available | 1,615,182 | 4,116,218 | 351,248 | 557 | 225.9／231.3 | 7 |
| 80 | m2 | available | 1,615,182 | 4,134,073 | 357,431 | 554 | 228.4／236.9 | 7 |
| 80 | m3 | available | 1,615,182 | 3,984,453 | 346,939 | 559 | 225.2／228.7 | 7 |
| 80 | m5 | available | 1,615,182 | 2,614,455 | 21,782 | 559 | 45.6／46.1 | 7 |
| 80 | c01 | available | 1,615,182 | 3,273,400 | 260,955 | 564 | 203.6／211.7 | 7 |
| 100 | m1 | available | 1,725,132 | 4,294,792 | 438,988 | 765 | 281.8／290.7 | 7 |
| 100 | m2 | available | 1,725,132 | 4,310,599 | 446,545 | 761 | 291.0／300.5 | 7 |
| 100 | m3 | available | 1,725,132 | 4,160,758 | 432,679 | 763 | 279.8／292.4 | 7 |
| 100 | m5 | available | 1,725,132 | 2,827,291 | 26,530 | 758 | 56.5／57.1 | 7 |
| 100 | c01 | available | 1,725,132 | 3,429,840 | 322,585 | 762 | 251.3／252.1 | 7 |
| 120 | m1 | available | 1,936,930 | 4,462,161 | 522,728 | 1002 | 334.3／336.4 | 7 |
| 120 | m2 | available | 1,936,930 | 4,483,213 | 530,972 | 1011 | 363.4／384.7 | 7 |
| 120 | m3 | available | 1,936,930 | 4,330,330 | 514,419 | 1028 | 338.4／367.6 | 7 |
| 120 | m5 | available | 1,936,930 | 3,026,967 | 33,278 | 1008 | 68.2／70.2 | 7 |
| 120 | c01 | available | 1,936,930 | 3,580,141 | 384,215 | 997 | 301.4／304.1 | 7 |

### R1 本番の親の経路（lease）。現行の上限／上限を外した build／候補 B と 100 ms

3 つの表は順に、現行の上限（worker は `worker-q4_5MiB`〔Q 4,718,592 B、Native 1.5 MiB〕、`raw/native-current-limits.txt`）、上限を外した build（`worker-raised-q32MiB`〔Q 32 MiB、Native 1.5 MiB〕、`raw/native-raised.txt`）、候補 B の定数と 100 ms（`worker-candB-100ms-q32MiB`〔Q 32 MiB、Native 1.5 MiB〕、`raw/native-candB-100ms.txt`）。R2-6（Q 16 MiB、Native 3 MiB。推奨の構成）とは worker の構成も負荷も違うので、同じ場面数の結果の差（34 場面の m1 は 3 つ目の表で available、R2-6 で 0/10）は、負荷と構成の違いが混ざり、分離していない。

| S | seed | 結果 | call p50／最大 ms | lease p50／最大 ms | n |
|---|---|---|---|---|---|
| 10 | m1 | available nodes=10 edges=21 | 30.36／32.64 | 28.93／31.29 | 10 |
| 10 | m2 | available nodes=10 edges=21 | 32.79／37.84 | 31.43／36.47 | 10 |
| 10 | m3 | available nodes=10 edges=21 | 32.27／36.87 | 30.97／35.53 | 10 |
| 10 | m5 | available nodes=1 edges=0 | 8.03／9.64 | 6.91／8.53 | 10 |
| 10 | c01 | available nodes=7 edges=14 | 28.16／35.44 | 26.78／34.13 | 10 |
| 20 | m1 | available nodes=11 edges=40 | 57.34／58.42 | 56.30／57.73 | 10 |
| 20 | m2 | available nodes=11 edges=40 | 60.09／63.83 | 59.40／62.30 | 10 |
| 20 | m3 | available nodes=11 edges=40 | 57.15／58.04 | 56.48／57.36 | 10 |
| 20 | m5 | available nodes=2 edges=1 | 13.72／14.68 | 12.58／13.56 | 10 |
| 20 | c01 | available nodes=7 edges=28 | 53.54／54.63 | 51.98／53.06 | 10 |
| 30 | m1 | refused post-stamp-steps/-steps | 61.38／63.24 | - | 10 |
| 30 | m2 | refused post-stamp-steps/-steps | 59.39／62.49 | - | 10 |
| 30 | m3 | refused post-stamp-steps/-steps | 60.62／63.49 | - | 10 |
| 30 | m5 | available nodes=2 edges=2 | 18.87／19.11 | 17.73／17.94 | 10 |
| 30 | c01 | refused post-stamp-steps/-steps | 61.46／63.01 | - | 10 |
| 50 | m1 | refused work-revision-record-limit/-revision-record-limit | 53.49／55.31 | - | 10 |
| 50 | m2 | refused work-revision-record-limit/-revision-record-limit | 52.86／56.54 | - | 10 |
| 50 | m3 | refused work-revision-record-limit/-revision-record-limit | 55.88／56.95 | - | 10 |
| 50 | m5 | available nodes=2 edges=3 | 29.80／30.31 | 28.59／29.10 | 10 |
| 50 | c01 | refused work-revision-record-limit/-revision-record-limit | 52.34／54.58 | - | 10 |
| 80 | m1 | refused work-disclosure-record-limit/-disclosure-record-limit | 22.17／22.89 | - | 10 |
| 80 | m2 | refused work-revision-record-limit/-revision-record-limit | 28.54／29.91 | - | 10 |
| 80 | m3 | refused work-revision-record-limit/-revision-record-limit | 29.11／30.10 | - | 10 |
| 80 | m5 | refused work-disclosure-record-limit/-disclosure-record-limit | 42.23／46.52 | - | 10 |
| 80 | c01 | refused work-revision-record-limit/-revision-record-limit | 23.34／24.02 | - | 10 |

| S | seed | 結果 | call p50／最大 ms | lease p50／最大 ms | n |
|---|---|---|---|---|---|
| 20 | m1 | available nodes=11 edges=40 | 58.47／59.82 | 57.92／58.57 | 10 |
| 20 | m2 | available nodes=11 edges=40 | 61.04／62.05 | 59.97／61.09 | 10 |
| 20 | c01 | available nodes=7 edges=28 | 53.44／54.24 | 51.83／52.68 | 10 |
| 20 | m5 | available nodes=2 edges=1 | 13.72／14.22 | 12.56／13.06 | 10 |
| 30 | m1 | available nodes=13 edges=59 | 86.80／88.13 | 85.46／87.21 | 10 |
| 30 | m2 | available nodes=13 edges=59 | 89.03／90.74 | 88.01／89.15 | 10 |
| 30 | c01 | available nodes=7 edges=39 | 76.46／78.07 | 75.74／77.37 | 10 |
| 30 | m5 | available nodes=2 edges=2 | 19.07／19.89 | 17.91／18.70 | 10 |
| 40 | m1 | available nodes=13 edges=80 | 111.84／112.98 | 110.62／111.84 | 10 |
| 40 | m2 | available nodes=13 edges=80 | 114.16／116.76 | 113.00／115.95 | 10 |
| 40 | c01 | available nodes=7 edges=53 | 100.86／102.51 | 99.15／101.63 | 10 |
| 40 | m5 | available nodes=2 edges=2 | 24.38／24.77 | 23.17／23.63 | 10 |
| 50 | m1 | available nodes=13 edges=99 | 139.78／150.33 | 138.34／149.52 | 10 |
| 50 | m2 | available nodes=13 edges=99 | 144.37／150.49 | 143.34／148.62 | 10 |
| 50 | c01 | available nodes=7 edges=67 | 125.27／127.91 | 124.48／126.90 | 10 |
| 50 | m5 | available nodes=2 edges=3 | 29.76／30.27 | 28.54／29.06 | 10 |

| S | seed | 結果 | call p50／最大 ms | lease p50／最大 ms | n |
|---|---|---|---|---|---|
| 30 | m1 | available nodes=13 edges=59 | 84.83／85.28 | 83.41／84.31 (n=10) | 10 |
| 30 | c01 | available nodes=7 edges=39 | 75.15／75.77 | 74.50／75.06 (n=10) | 10 |
| 30 | m5 | available nodes=2 edges=2 | 18.77／19.11 | 17.62／17.94 (n=10) | 10 |
| 34 | m1 | available nodes=13 edges=68 | 95.46／96.83 | 94.39／95.75 (n=10) | 10 |
| 34 | c01 | available nodes=7 edges=47 | 87.65／88.37 | 86.86／87.71 (n=10) | 10 |
| 34 | m5 | available nodes=2 edges=2 | 18.92／19.33 | 17.77／18.21 (n=10) | 10 |
| 36 | m1 | refused NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME | 100.87／101.95 | - | 10 |
| 36 | c01 | available nodes=7 edges=48 | 90.27／93.42 | 89.30／92.67 (n=10) | 10 |
| 36 | m5 | available nodes=2 edges=2 | 21.73／22.64 | 20.59／21.49 (n=10) | 10 |
| 38 | m1 | refused NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME | 100.89／101.92 | - | 10 |
| 38 | c01 | available nodes=7 edges=50 | 96.60／98.66 | 95.23／96.97 (n=10) | 10 |
| 38 | m5 | available nodes=2 edges=2 | 21.90／22.42 | 20.75／21.27 (n=10) | 10 |
| 40 | m1 | refused NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME | 100.85／101.83 | - | 10 |
| 40 | c01 | refused NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME | 100.54／101.17 | 98.11／99.82 (n=7) | 10 |
| 40 | m5 | available nodes=2 edges=2 | 24.19／24.84 | 23.00／23.67 (n=10) | 10 |
| 50 | m1 | refused NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME | 100.95／102.02 | - | 10 |
| 50 | c01 | refused NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME | 100.92／100.98 | - | 10 |
| 50 | m5 | available nodes=2 edges=3 | 29.88／34.04 | 28.69／32.82 (n=10) | 10 |


### R1 場面数の境界（m1 と c01）

| S | seed | Revision | records | steps | Entity | edge | pages | lease p50／最大 ms | 現行上限を超えるもの |
|---|---|---|---|---|---|---|---|---|---|
| 10 | m1 | 9 | 229 | 47,944 | 10 | 21 | 16 | 27.8／30.7 | - |
| 20 | m1 | 18 | 411 | 92,662 | 11 | 40 | 18 | 55.1／66.4 | - |
| 22 | m1 | 20 | 447 | 102,074 | 12 | 44 | 19 | 58.2／59.8 | steps>100k |
| 24 | m1 | 22 | 488 | 112,321 | 12 | 49 | 19 | 63.4／64.1 | steps>100k |
| 26 | m1 | 24 | 521 | 121,049 | 13 | 51 | 20 | 70.2／70.8 | records>512, steps>100k, Entity>12 |
| 28 | m1 | 26 | 556 | 130,027 | 13 | 54 | 20 | 75.0／75.3 | records>512, steps>100k, Entity>12 |
| 30 | m1 | 27 | 589 | 137,084 | 13 | 59 | 21 | 78.8／84.0 | records>512, steps>100k, Entity>12 |
| 32 | m1 | 29 | 627 | 146,442 | 13 | 63 | 21 | 84.5／84.6 | records>512, steps>100k, Entity>12 |
| 34 | m1 | 31 | 669 | 156,710 | 13 | 68 | 21 | 90.2／92.0 | records>512, steps>100k, Entity>12 |
| 36 | m1 | 33 | 702 | 165,336 | 13 | 70 | 21 | 94.5／98.6 | records>512, steps>100k, Entity>12 |
| 38 | m1 | 35 | 738 | 174,694 | 13 | 74 | 23 | 102.6／106.2 | records>512, steps>100k, Entity>12, lease>100ms |
| 40 | m1 | 36 | 772 | 182,056 | 13 | 80 | 23 | 106.9／112.8 | records>512, steps>100k, Entity>12, lease>100ms |
| 45 | m1 | 41 | 862 | 204,916 | 13 | 86 | 23 | 121.7／123.3 | records>512, steps>100k, Entity>12, lease>100ms |
| 50 | m1 | 45 | 954 | 226,665 | 13 | 99 | 24 | 132.4／144.0 | records>512, steps>100k, Entity>12, lease>100ms |
| 60 | m1 | 54 | 1132 | 270,878 | 13 | 118 | 25 | 157.2／159.3 | records>512, steps>100k, Entity>12, lease>100ms |
| 70 | m1 | 63 | 1315 | 315,817 | 13 | 139 | 26 | 183.5／186.9 | records>512, steps>100k, Entity>12, lease>100ms |
| 75 | m1 | 68 | 1405 | 338,680 | 13 | 145 | 26 | 200.8／205.3 | records>512, steps>100k, Entity>12, edge>144, lease>100ms |
| 80 | m1 | 72 | 1497 | 360,456 | 13 | 158 | 28 | 218.6／226.8 | records>512, steps>100k, Entity>12, edge>144, lease>100ms |
| 100 | m1 | 90 | 1858 | 449,608 | 13 | 198 | 30 | 256.9／261.7 | records>512, steps>100k, Entity>12, edge>144, lease>100ms |
| 10 | c01 | 8 | 199 | 42,902 | 7 | 14 | 8 | 25.8／26.6 | - |
| 20 | c01 | 16 | 356 | 83,062 | 7 | 28 | 9 | 47.6／49.0 | - |
| 22 | c01 | 18 | 390 | 92,316 | 7 | 30 | 9 | 52.8／53.5 | - |
| 24 | c01 | 20 | 428 | 102,488 | 7 | 33 | 9 | 58.2／58.5 | steps>100k |
| 26 | c01 | 21 | 449 | 107,284 | 7 | 34 | 9 | 61.6／61.7 | steps>100k |
| 28 | c01 | 23 | 482 | 116,212 | 7 | 36 | 9 | 67.5／67.8 | steps>100k |
| 30 | c01 | 24 | 512 | 123,167 | 7 | 39 | 9 | 70.3／73.5 | steps>100k |
| 32 | c01 | 26 | 547 | 132,453 | 7 | 43 | 9 | 75.2／75.7 | records>512, steps>100k |
| 34 | c01 | 28 | 585 | 142,618 | 7 | 47 | 9 | 81.8／83.0 | records>512, steps>100k |
| 36 | c01 | 29 | 605 | 147,090 | 7 | 48 | 9 | 85.5／87.4 | records>512, steps>100k |
| 38 | c01 | 31 | 639 | 156,371 | 7 | 50 | 10 | 91.5／92.2 | records>512, steps>100k |
| 40 | c01 | 32 | 670 | 163,658 | 7 | 53 | 10 | 95.5／96.2 | records>512, steps>100k |
| 45 | c01 | 36 | 743 | 182,269 | 7 | 58 | 10 | 108.0／109.1 | records>512, steps>100k, lease>100ms |
| 50 | c01 | 40 | 827 | 203,786 | 7 | 67 | 10 | 117.9／124.1 | records>512, steps>100k, lease>100ms |
| 60 | c01 | 48 | 983 | 243,923 | 7 | 78 | 11 | 140.2／144.3 | records>512, steps>100k, lease>100ms |
| 70 | c01 | 56 | 1141 | 284,381 | 7 | 92 | 11 | 167.8／181.0 | records>512, steps>100k, lease>100ms |
| 75 | c01 | 60 | 1214 | 302,992 | 7 | 97 | 11 | 175.4／179.8 | records>512, steps>100k, lease>100ms |
| 80 | c01 | 64 | 1298 | 324,541 | 7 | 106 | 12 | 192.6／202.6 | records>512, steps>100k, lease>100ms |
| 100 | c01 | 80 | 1612 | 405,134 | 7 | 131 | 13 | 234.3／246.9 | records>512, steps>100k, lease>100ms |

### R1 製品形の worker のメモリ（Q 4.5／8／16／32 MiB。Native 1.5 MiB）

```
== q4_5MiB
p:50000      a2=Ok(198737)   ped=(59607, 66092, 2) ready=true frame=167296   exit=Some(0) reg_hw=1631376 q_hw=1559435 q=available/None inner_ms=11.09 fail=- 
p:100000     a2=Ok(348641)   ped=(109575, 116060, 2) ready=true frame=308872   exit=Some(0) reg_hw=2071562 q_hw=1913567 q=available/None inner_ms=14.75 fail=- 
p:200000     a2=Ok(648665)   ped=(209583, 216068, 2) ready=true frame=592228   exit=Some(0) reg_hw=2952424 q_hw=2622353 q=available/None inner_ms=15.70 fail=- 
p:300000     a2=Ok(948689)   ped=(309591, 316076, 2) ready=true frame=875584   exit=Some(0) reg_hw=3837670 q_hw=3331131 q=available/None inner_ms=19.64 fail=- 
p:360000     a2=Ok(1128845)  ped=(369651, 376124, 2) ready=true frame=1045720  exit=Some(0) reg_hw=4369255 q_hw=3756753 q=available/None inner_ms=21.50 fail=- 
p:380000     a2=Ok(1188677)  ped=(389595, 396068, 2) ready=false frame=0        exit=Some(1) reg_hw=- q_hw=- q=-/- inner_ms=- fail=('sqlite', '388482', '4152147', '365504') NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX]
p:450000     a2=Ok(1398845)  ped=(459651, 466124, 2) ready=false frame=0        exit=Some(1) reg_hw=- q_hw=- q=-/- inner_ms=- fail=('sqlite', '458538', '4169435', '348384') NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX]
p:520000     a2=Ok(1608797)  ped=(529635, 536108, 2) ready=false frame=0        exit=Some(1) reg_hw=- q_hw=- q=-/- inner_ms=- fail=('sqlite', '43830', '4369759', '148192') NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX]
p:600000     a2=Ok(1848773)  ped=(609627, 616100, 2) ready=false frame=0        exit=Some(1) reg_hw=- q_hw=- q=-/- inner_ms=- fail=('sqlite', '608514', '4199660', '318272') NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX]
p:682000     a2=Ok(2094797)  ped=(691635, 698108, 2) ready=false frame=0        exit=Some(1) reg_hw=- q_hw=- q=-/- inner_ms=- fail=('sqlite', '4376', '4444828', '73280') NIR1_C_QUERY_REG_NOMEM:SEMANTIC_INDEX]
d:200000     a2=Ok(212021)   ped=(1678, 5158, 200010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=1363395 q=available/None inner_ms=6.22 fail=- 
d:1000000    a2=Ok(1012021)  ped=(1678, 5158, 1000010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=2164963 q=available/None inner_ms=7.58 fail=- 
d:2085131    a2=Ok(2097152)  ped=(1678, 5158, 2085141) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=3252214 q=available/None inner_ms=9.94 fail=- 
e:2097152    a2=Ok(2097152)  ped=(1678, 2090289, 10) ready=true frame=5871     exit=Some(0) reg_hw=3165934 q_hw=3276187 q=available/None inner_ms=18.09 fail=- 
== q8MiB
p:50000      a2=Ok(198737)   ped=(59607, 66092, 2) ready=true frame=167296   exit=Some(0) reg_hw=1631376 q_hw=1559435 q=available/None inner_ms=10.99 fail=- 
p:100000     a2=Ok(348641)   ped=(109575, 116060, 2) ready=true frame=308872   exit=Some(0) reg_hw=2071562 q_hw=1913567 q=available/None inner_ms=12.10 fail=- 
p:200000     a2=Ok(648665)   ped=(209583, 216068, 2) ready=true frame=592228   exit=Some(0) reg_hw=2952424 q_hw=2622353 q=available/None inner_ms=15.90 fail=- 
p:300000     a2=Ok(948689)   ped=(309591, 316076, 2) ready=true frame=875584   exit=Some(0) reg_hw=3837670 q_hw=3331131 q=available/None inner_ms=20.78 fail=- 
p:360000     a2=Ok(1128845)  ped=(369651, 376124, 2) ready=true frame=1045720  exit=Some(0) reg_hw=4369255 q_hw=3756753 q=available/None inner_ms=21.29 fail=- 
p:380000     a2=Ok(1188677)  ped=(389595, 396068, 2) ready=true frame=1102228  exit=Some(0) reg_hw=4541469 q_hw=3898107 q=available/None inner_ms=22.25 fail=- 
p:450000     a2=Ok(1398845)  ped=(459651, 466124, 2) ready=true frame=1300720  exit=Some(0) reg_hw=5163731 q_hw=4394613 q=available/None inner_ms=25.58 fail=- 
p:520000     a2=Ok(1608797)  ped=(529635, 536108, 2) ready=true frame=1499008  exit=Some(0) reg_hw=5781043 q_hw=4890605 q=available/None inner_ms=27.03 fail=- 
p:600000     a2=Ok(1848773)  ped=(609627, 616100, 2) ready=true frame=0        exit=Some(1) reg_hw=6484741 q_hw=5457523 q=available/None inner_ms=30.84 fail=- 
p:682000     a2=Ok(2094797)  ped=(691635, 698108, 2) ready=true frame=0        exit=Some(1) reg_hw=7208463 q_hw=6038729 q=available/None inner_ms=34.56 fail=- 
d:200000     a2=Ok(212021)   ped=(1678, 5158, 200010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=1348817 q=available/None inner_ms=6.11 fail=- 
d:1000000    a2=Ok(1012021)  ped=(1678, 5158, 1000010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=2150385 q=available/None inner_ms=9.87 fail=- 
d:2085131    a2=Ok(2097152)  ped=(1678, 5158, 2085141) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=3252214 q=available/None inner_ms=9.94 fail=- 
e:2097152    a2=Ok(2097152)  ped=(1678, 2090289, 10) ready=true frame=5871     exit=Some(0) reg_hw=3165793 q_hw=3261609 q=available/None inner_ms=17.95 fail=- 
== q16MiB
p:50000      a2=Ok(198737)   ped=(59607, 66092, 2) ready=true frame=167296   exit=Some(0) reg_hw=1631376 q_hw=1559435 q=available/None inner_ms=10.13 fail=- 
p:100000     a2=Ok(348641)   ped=(109575, 116060, 2) ready=true frame=308872   exit=Some(0) reg_hw=2071562 q_hw=1913567 q=available/None inner_ms=12.52 fail=- 
p:200000     a2=Ok(648665)   ped=(209583, 216068, 2) ready=true frame=592228   exit=Some(0) reg_hw=2952424 q_hw=2622353 q=available/None inner_ms=15.94 fail=- 
p:300000     a2=Ok(948689)   ped=(309591, 316076, 2) ready=true frame=875584   exit=Some(0) reg_hw=3837670 q_hw=3331131 q=available/None inner_ms=19.27 fail=- 
p:360000     a2=Ok(1128845)  ped=(369651, 376124, 2) ready=true frame=1045720  exit=Some(0) reg_hw=4369255 q_hw=3756753 q=available/None inner_ms=21.69 fail=- 
p:380000     a2=Ok(1188677)  ped=(389595, 396068, 2) ready=true frame=1102228  exit=Some(0) reg_hw=4541469 q_hw=3898107 q=available/None inner_ms=22.75 fail=- 
p:450000     a2=Ok(1398845)  ped=(459651, 466124, 2) ready=true frame=1300720  exit=Some(0) reg_hw=5163731 q_hw=4394613 q=available/None inner_ms=24.59 fail=- 
p:520000     a2=Ok(1608797)  ped=(529635, 536108, 2) ready=true frame=1499008  exit=Some(0) reg_hw=5781043 q_hw=4890605 q=available/None inner_ms=27.89 fail=- 
p:600000     a2=Ok(1848773)  ped=(609627, 616100, 2) ready=true frame=0        exit=Some(1) reg_hw=6484741 q_hw=5457523 q=available/None inner_ms=30.54 fail=- 
p:682000     a2=Ok(2094797)  ped=(691635, 698108, 2) ready=true frame=0        exit=Some(1) reg_hw=7208463 q_hw=6038729 q=available/None inner_ms=33.46 fail=- 
d:200000     a2=Ok(212021)   ped=(1678, 5158, 200010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=1348817 q=available/None inner_ms=6.30 fail=- 
d:1000000    a2=Ok(1012021)  ped=(1678, 5158, 1000010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=2150385 q=available/None inner_ms=7.54 fail=- 
d:2085131    a2=Ok(2097152)  ped=(1678, 5158, 2085141) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=3252214 q=available/None inner_ms=9.60 fail=- 
e:2097152    a2=Ok(2097152)  ped=(1678, 2090289, 10) ready=true frame=5871     exit=Some(0) reg_hw=3165934 q_hw=3276187 q=available/None inner_ms=19.92 fail=- 
== q32MiB
p:50000      a2=Ok(198737)   ped=(59607, 66092, 2) ready=true frame=167296   exit=Some(0) reg_hw=1631376 q_hw=1559435 q=available/None inner_ms=10.13 fail=- 
p:100000     a2=Ok(348641)   ped=(109575, 116060, 2) ready=true frame=308872   exit=Some(0) reg_hw=2071562 q_hw=1913567 q=available/None inner_ms=12.21 fail=- 
p:200000     a2=Ok(648665)   ped=(209583, 216068, 2) ready=true frame=592228   exit=Some(0) reg_hw=2952424 q_hw=2622353 q=available/None inner_ms=15.96 fail=- 
p:300000     a2=Ok(948689)   ped=(309591, 316076, 2) ready=true frame=875584   exit=Some(0) reg_hw=3837670 q_hw=3331131 q=available/None inner_ms=19.90 fail=- 
p:360000     a2=Ok(1128845)  ped=(369651, 376124, 2) ready=true frame=1045720  exit=Some(0) reg_hw=4369255 q_hw=3756753 q=available/None inner_ms=21.66 fail=- 
p:380000     a2=Ok(1188677)  ped=(389595, 396068, 2) ready=true frame=1102228  exit=Some(0) reg_hw=4541469 q_hw=3898107 q=available/None inner_ms=21.86 fail=- 
p:450000     a2=Ok(1398845)  ped=(459651, 466124, 2) ready=true frame=1300720  exit=Some(0) reg_hw=5163731 q_hw=4394613 q=available/None inner_ms=26.31 fail=- 
p:520000     a2=Ok(1608797)  ped=(529635, 536108, 2) ready=true frame=1499008  exit=Some(0) reg_hw=5781043 q_hw=4890605 q=available/None inner_ms=28.30 fail=- 
p:600000     a2=Ok(1848773)  ped=(609627, 616100, 2) ready=true frame=0        exit=Some(1) reg_hw=6484741 q_hw=5457523 q=available/None inner_ms=30.97 fail=- 
p:682000     a2=Ok(2094797)  ped=(691635, 698108, 2) ready=true frame=0        exit=Some(1) reg_hw=7208463 q_hw=6038729 q=available/None inner_ms=34.47 fail=- 
d:200000     a2=Ok(212021)   ped=(1678, 5158, 200010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=1363395 q=available/None inner_ms=6.22 fail=- 
d:1000000    a2=Ok(1012021)  ped=(1678, 5158, 1000010) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=2150385 q=available/None inner_ms=11.62 fail=- 
d:2085131    a2=Ok(2097152)  ped=(1678, 5158, 2085141) ready=true frame=5871     exit=Some(0) reg_hw=1223878 q_hw=3237636 q=available/None inner_ms=11.37 fail=- 
e:2097152    a2=Ok(2097152)  ped=(1678, 2090289, 10) ready=true frame=5871     exit=Some(0) reg_hw=3165934 q_hw=3276187 q=available/None inner_ms=18.19 fail=-
```

### R1 Entity と edge の分布

```
S=10 protag(m1,m2,m3,m4,c01): records max=229 p95=228 [512:5/5, 768:5/5, 1024:5/5, 1536:5/5, 2048:5/5, 3072:5/5, 4096:5/5] | steps max=47944 p95=47912 [100000:5/5, 150000:5/5, 250000:5/5, 500000:5/5, 1000000:5/5] | entities max=10 p95=10 [12:5/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=21 p95=21 [144:5/5, 200:5/5, 256:5/5, 384:5/5, 512:5/5] | time_ms max=29 p95=28 [100:5/5]
S=20 protag(m1,m2,m3,m4,c01): records max=415 p95=414 [512:5/5, 768:5/5, 1024:5/5, 1536:5/5, 2048:5/5, 3072:5/5, 4096:5/5] | steps max=95749 p95=95132 [100000:5/5, 150000:5/5, 250000:5/5, 500000:5/5, 1000000:5/5] | entities max=11 p95=11 [12:5/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=40 p95=40 [144:5/5, 200:5/5, 256:5/5, 384:5/5, 512:5/5] | time_ms max=57 p95=57 [100:5/5]
S=30 protag(m1,m2,m3,m4,c01): records max=596 p95=595 [512:1/5, 768:5/5, 1024:5/5, 1536:5/5, 2048:5/5, 3072:5/5, 4096:5/5] | steps max=140275 p95=139637 [100000:0/5, 150000:5/5, 250000:5/5, 500000:5/5, 1000000:5/5] | entities max=13 p95=13 [12:3/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=59 p95=59 [144:5/5, 200:5/5, 256:5/5, 384:5/5, 512:5/5] | time_ms max=80 p95=80 [100:5/5]
S=50 protag(m1,m2,m3,m4,c01): records max=967 p95=964 [512:0/5, 768:0/5, 1024:5/5, 1536:5/5, 2048:5/5, 3072:5/5, 4096:5/5] | steps max=233022 p95=231751 [100000:0/5, 150000:0/5, 250000:5/5, 500000:5/5, 1000000:5/5] | entities max=13 p95=13 [12:3/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=99 p95=99 [144:5/5, 200:5/5, 256:5/5, 384:5/5, 512:5/5] | time_ms max=141 p95=139 [100:0/5]
S=80 protag(m1,m2,m3,m4,c01): records max=1517 p95=1513 [512:0/5, 768:0/5, 1024:0/5, 1536:5/5, 2048:5/5, 3072:5/5, 4096:5/5] | steps max=370004 p95=368094 [100000:0/5, 150000:0/5, 250000:0/5, 500000:5/5, 1000000:5/5] | entities max=13 p95=13 [12:3/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=158 p95=158 [144:1/5, 200:5/5, 256:5/5, 384:5/5, 512:5/5] | time_ms max=226 p95=225 [100:0/5]
S=100 protag(m1,m2,m3,m4,c01): records max=1879 p95=1875 [512:0/5, 768:0/5, 1024:0/5, 1536:0/5, 2048:5/5, 3072:5/5, 4096:5/5] | steps max=459181 p95=457266 [100000:0/5, 150000:0/5, 250000:0/5, 500000:5/5, 1000000:5/5] | entities max=13 p95=13 [12:3/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=198 p95=198 [144:1/5, 200:5/5, 256:5/5, 384:5/5, 512:5/5] | time_ms max=267 p95=266 [100:0/5]
S=120 protag(m1,m2,m3,m4,c01): records max=2246 p95=2240 [512:0/5, 768:0/5, 1024:0/5, 1536:0/5, 2048:1/5, 3072:5/5, 4096:5/5] | steps max=551221 p95=548668 [100000:0/5, 150000:0/5, 250000:0/5, 500000:1/5, 1000000:5/5] | entities max=13 p95=13 [12:3/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=236 p95=236 [144:0/5, 200:1/5, 256:5/5, 384:5/5, 512:5/5] | time_ms max=321 p95=321 [100:0/5]
S=150 protag(m1,m2,m3,m4,c01): records max=2796 p95=2789 [512:0/5, 768:0/5, 1024:0/5, 1536:0/5, 2048:0/5, 3072:5/5, 4096:5/5] | steps max=688151 p95=684960 [100000:0/5, 150000:0/5, 250000:0/5, 500000:0/5, 1000000:5/5] | entities max=13 p95=13 [12:3/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=295 p95=295 [144:0/5, 200:1/5, 256:1/5, 384:5/5, 512:5/5] | time_ms max=406 p95=404 [100:0/5]
S=200 protag(m1,m2,m3,m4,c01): records max=3717 p95=3707 [512:0/5, 768:0/5, 1024:0/5, 1536:0/5, 2048:0/5, 3072:0/5, 4096:5/5] | steps max=917905 p95=913443 [100000:0/5, 150000:0/5, 250000:0/5, 500000:0/5, 1000000:5/5] | entities max=13 p95=13 [12:3/5, 13:5/5, 16:5/5, 20:5/5, 30:5/5, 50:5/5] | edges max=394 p95=394 [144:0/5, 200:0/5, 256:0/5, 384:2/5, 512:5/5] | time_ms max=546 p95=543 [100:0/5]
```

## R2（round 2）の表

### R2-1 候補 B の定数（records 2,048／steps 600,000／Entity 50／edge 512／pages 128、期限 10 s、input bytes 6,291,456）での in-process の結果
定数だけを変えた test build（`r2/test-candB-10s`）。1 行は場面数 S と cast ごとの全 seed の集計。retained と peak は `usage(rows,bytes,pages,retained,peak)` の最大。

| 実行 | S | seed 数 | available | 最大 records | 最大 steps | 最大 Entity | 最大 edge | 最大 pages | 最大 retained B | 最大 peak B | available でない seed |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 既定 summary、cast 5+15 | 20 | 6 | 6 | 415 | 95,807 | 11 | 40 | 18 | 853,497 | 1,197,170 | - |
| 既定 summary、cast 5+15 | 30 | 6 | 6 | 596 | 140,757 | 13 | 59 | 21 | 1,054,343 | 1,576,241 | - |
| 既定 summary、cast 5+15 | 50 | 6 | 6 | 967 | 234,879 | 13 | 99 | 24 | 1,320,577 | 2,192,430 | - |
| 既定 summary、cast 5+15 | 100 | 6 | 6 | 1,879 | 464,430 | 13 | 198 | 30 | 1,968,452 | 3,694,876 | - |
| summary 600 字、cast 5+15 | 20 | 6 | 6 | 415 | 95,857 | 11 | 40 | 18 | 958,797 | 1,630,416 | - |
| summary 600 字、cast 5+15 | 30 | 6 | 6 | 596 | 140,833 | 13 | 59 | 21 | 1,215,815 | 2,222,249 | - |
| summary 600 字、cast 5+15 | 50 | 6 | 6 | 967 | 235,003 | 13 | 99 | 24 | 1,590,871 | 3,273,807 | - |
| summary 600 字、cast 5+15 | 100 | 6 | 6 | 1,879 | 464,676 | 13 | 198 | 30 | 2,505,518 | 5,843,539 | - |
| summary 2000 字、cast 5+15 | 20 | 6 | 6 | 415 | 95,981 | 11 | 40 | 18 | 1,210,797 | 2,672,078 | - |
| summary 2000 字、cast 5+15 | 30 | 6 | 6 | 596 | 141,015 | 13 | 59 | 21 | 1,602,215 | 3,767,941 | - |
| summary 2000 字、cast 5+15 | 50 | 6 | 6 | 967 | 235,311 | 13 | 99 | 24 | 2,237,671 | 5,861,161 | - |
| summary 2000 字、cast 5+15 | 100 | 6 | 1 | 1,879 | 465,291 | 13 | 198 | 4 | 666,610 | 1,933,981 | work-other |
| cast 8+40 | 50 | 48 | 48 | 1,259 | 297,197 | 22 | 108 | 35 | 1,872,041 | 2,991,239 | - |
| cast 8+40 | 100 | 48 | 39 | 2,454 | 588,449 | 22 | 214 | 13 | 1,419,335 | 2,854,452 | work-disclosure-record-limit, work-revision-record-limit |
| cast 12+80 | 50 | 92 | 92 | 1,339 | 310,952 | 23 | 97 | 38 | 1,972,656 | 3,136,877 | - |
| cast 12+80 | 100 | 92 | 81 | 2,663 | 626,311 | 25 | 190 | 15 | 1,548,882 | 3,085,875 | work-disclosure-record-limit, work-revision-record-limit |

retained の上限は 6,291,456 B。node ごとに MAX_GRAPH_RECORDS×8 B×2 を先に計上する（`nir1_graph.rs:2556-2562`）ので、Entity 50×records 2,048 では最大 1,638,400 B を先取りする。

### R2-2 推奨の構成の worker（候補 B の定数、Q 16 MiB、Native 3 MiB、期限 10 s の build。`r2/worker-candB10s-q16-n3`）の worker 経路

| 実行 | S | seed | 結果 | registration hw | frame bytes | 回数 |
|---|---|---|---|---|---|---|
| sum0 | 50 | c01 | available exit=Some(0) | 1,399,333 | 165,510 | 2 |
| sum0 | 50 | m1 | available exit=Some(0) | 1,399,333 | 221,638 | 2 |
| sum0 | 50 | m2 | available exit=Some(0) | 1,399,333 | 225,760 | 2 |
| sum0 | 50 | m3 | available exit=Some(0) | 1,399,333 | 219,329 | 2 |
| sum0 | 50 | m4 | available exit=Some(0) | 1,399,333 | 210,394 | 2 |
| sum0 | 50 | m5 | available exit=Some(0) | 1,399,333 | 13,660 | 2 |
| sum0 | 100 | c01 | available exit=Some(0) | 1,725,132 | 322,585 | 2 |
| sum0 | 100 | m1 | available exit=Some(0) | 1,725,132 | 438,988 | 2 |
| sum0 | 100 | m2 | available exit=Some(0) | 1,725,132 | 446,545 | 2 |
| sum0 | 100 | m3 | available exit=Some(0) | 1,725,132 | 432,679 | 2 |
| sum0 | 100 | m4 | available exit=Some(0) | 1,725,132 | 412,431 | 2 |
| sum0 | 100 | m5 | available exit=Some(0) | 1,725,132 | 26,530 | 2 |
| sum2000 | 30 | c01 | available exit=Some(0) | 1,449,537 | 603,560 | 2 |
| sum2000 | 30 | m1 | available exit=Some(0) | 1,449,537 | 913,514 | 2 |
| sum2000 | 30 | m2 | available exit=Some(0) | 1,449,537 | 915,575 | 2 |
| sum2000 | 30 | m3 | available exit=Some(0) | 1,449,537 | 893,307 | 2 |
| sum2000 | 30 | m4 | available exit=Some(0) | 1,449,537 | 845,943 | 2 |
| sum2000 | 30 | m5 | available exit=Some(0) | 1,449,537 | 44,678 | 2 |
| sum2000 | 50 | c01 | available exit=Some(0) | 1,451,601 | 1,004,346 | 2 |
| sum2000 | 50 | m1 | available exit=Some(0) | 1,451,601 | 1,477,234 | 2 |
| sum2000 | 50 | m2 | available exit=Some(0) | 1,451,601 | 1,481,356 | 2 |
| sum2000 | 50 | m3 | available exit=Some(0) | 1,451,601 | 1,457,027 | 2 |
| sum2000 | 50 | m4 | available exit=Some(0) | 1,451,601 | 1,382,506 | 2 |
| sum2000 | 50 | m5 | available exit=Some(0) | 1,451,601 | 61,348 | 2 |
| cast8x40 | 50 | c01 | available exit=Some(0) | 1,574,363 | 168,128 | 2 |
| cast8x40 | 50 | m1 | available exit=Some(0) | 1,574,363 | 244,480 | 2 |
| cast8x40 | 50 | m2 | available exit=Some(0) | 1,574,363 | 247,915 | 2 |
| cast8x40 | 50 | m3 | available exit=Some(0) | 1,574,363 | 229,931 | 2 |
| cast8x40 | 50 | m5 | available exit=Some(0) | 1,574,363 | 32,227 | 2 |
| cast12x80 | 50 | c01 | available exit=Some(0) | 1,630,922 | 162,746 | 2 |
| cast12x80 | 50 | m1 | available exit=Some(0) | 1,630,922 | 222,102 | 2 |
| cast12x80 | 50 | m2 | available exit=Some(0) | 1,630,922 | 224,163 | 2 |
| cast12x80 | 50 | m5 | available exit=Some(0) | 1,630,922 | 29,231 | 2 |

### R2-3 製品形（日本語 summary、Entity 12、Revision 1 件）の worker のメモリ（候補 B の定数、期限 100 ms の build の worker）

| worker の構成 | A2 bytes | 結果 | registration hw | frame bytes |
|---|---|---|---|---|
| Q 16 MiB、Native 1.5 MiB（現行） | 948,689 | available | 3,837,670 | 875,584 |
| Q 16 MiB、Native 1.5 MiB（現行） | 1,128,845 | available | 4,369,255 | 1,045,720 |
| Q 16 MiB、Native 1.5 MiB（現行） | 1,188,677 | available | 4,541,469 | 1,102,228 |
| Q 16 MiB、Native 1.5 MiB（現行） | 1,608,797 | available | 5,781,043 | 1,499,008 |
| Q 16 MiB、Native 1.5 MiB（現行） | 1,848,773 | frame 超過で exit 1（NQG3 の frame の上限） | 6,484,741 | 0 |
| Q 16 MiB、Native 1.5 MiB（現行） | 2,094,797 | frame 超過で exit 1（NQG3 の frame の上限） | 7,208,463 | 0 |
| Q 8 MiB、Native 3 MiB | 948,689 | available | 3,837,670 | 875,584 |
| Q 8 MiB、Native 3 MiB | 1,128,845 | available | 4,369,255 | 1,045,720 |
| Q 8 MiB、Native 3 MiB | 1,188,677 | available | 4,541,469 | 1,102,228 |
| Q 8 MiB、Native 3 MiB | 1,608,797 | available | 5,781,043 | 1,499,008 |
| Q 8 MiB、Native 3 MiB | 1,848,773 | available | 6,484,741 | 1,725,652 |
| Q 8 MiB、Native 3 MiB | 2,094,797 | available | 7,208,463 | 1,958,008 |
| Q 16 MiB、Native 3 MiB | 948,689 | available | 3,837,670 | 875,584 |
| Q 16 MiB、Native 3 MiB | 1,128,845 | available | 4,369,255 | 1,045,720 |
| Q 16 MiB、Native 3 MiB | 1,188,677 | available | 4,541,469 | 1,102,228 |
| Q 16 MiB、Native 3 MiB | 1,608,797 | available | 5,781,043 | 1,499,008 |
| Q 16 MiB、Native 3 MiB | 1,848,773 | available | 6,484,741 | 1,725,652 |
| Q 16 MiB、Native 3 MiB | 2,094,797 | available | 7,208,463 | 1,958,008 |

### R2-4 製品形で Revision が複数ある project（同じ Entity 12 件を場面ごとに review。Revision n 件。seed は v00）

| worker の構成 | Revision 数×case | A2（1 件） | 結果 | registration hw | frame bytes |
|---|---|---|---|---|---|
| q16-n3 | 4×p:300000 | 948,772 | available | 3,838,018 | 875,584 |
| q16-n3 | 3×p:520000 | 1,608,880 | available | 5,781,196 | 1,499,008 |
| q16-n3 | 4×p:520000 | 1,608,880 | unavailable（work-other-pre-cleanup-work-failed-other） | 5,781,391 | 98 |
| q16-n3 | 2×p:682000 | 2,094,880 | available | 7,208,580 | 1,958,008 |
| q16-n3 | 3×p:682000 | 2,094,880 | unavailable（work-other-pre-cleanup-work-failed-other） | 7,208,675 | 98 |
| q8-n3 | 4×p:300000 | 948,772 | available | 3,838,018 | 875,584 |
| q8-n3 | 3×p:520000 | 1,608,880 | available | 5,781,255 | 1,499,008 |
| q8-n3 | 4×p:520000 | 1,608,880 | unavailable（work-other-pre-cleanup-work-failed-other） | 5,781,391 | 98 |
| q8-n3 | 2×p:682000 | 2,094,880 | available | 7,208,580 | 1,958,008 |
| q8-n3 | 3×p:682000 | 2,094,880 | unavailable（work-other-pre-cleanup-work-failed-other） | 7,208,675 | 98 |
| baseline-q4.5-prod | 4×p:300000 | 948,772 | available | 3,838,018 | 875,584 |
| baseline-q4.5-prod | 2×p:300000 | 948,772 | available | 3,837,787 | 875,584 |
A2 の合計が input bytes の論理上限 6,291,456 B を超える形（4×1.6 MB、3×2.09 MB）は、worker が registration を終えたあと query が拒否された（reason は work-other。分類は未特定。入力 bytes の上限によると推定）。

### R2-5 payload 側の padding（typed writer の長い文字列。A2 の約 3 倍が payload・envelope・decision に分かれる形）の registration

| worker の構成 | writer の counted bytes | A2 admission | 結果 | registration hw | 失敗時の要求 bytes |
|---|---|---|---|---|---|
| q16-n3 | 100,000 | 534,294 | registration を通過（READY） | 3,342,261 | - |
| q16-n3 | 200,000 | 834,294 | registration を通過（READY） | 5,052,645 | - |
| q16-n3 | 400,000 | 1,434,294 | registration を通過（READY） | 8,469,205 | - |
| q16-n3 | 600,000 | 2,034,294 | registration を通過（READY） | 11,885,581 | - |
| q16-n3 | 690,000 | 超過（NIR1_GRAPH_REVISION_INPUT_LIMIT） | registration を通過（READY） | 13,422,557 | - |
| q16-n3 | 700,000 | 超過（NIR1_GRAPH_REVISION_INPUT_LIMIT） | registration を通過（READY） | 13,591,405 | - |
| q8-n3 | 100,000 | 534,294 | registration を通過（READY） | 3,342,261 | - |
| q8-n3 | 200,000 | 834,294 | registration を通過（READY） | 5,052,645 | - |
| q8-n3 | 400,000 | 1,434,294 | registration で NOMEM（READY の前に exit 1） | - | 430,232 |
| q8-n3 | 600,000 | 2,034,294 | registration で NOMEM（READY の前に exit 1） | - | 629,214 |
| q8-n3 | 690,000 | 超過（NIR1_GRAPH_REVISION_INPUT_LIMIT） | registration で NOMEM（READY の前に exit 1） | - | 719,214 |
| q8-n3 | 700,000 | 超過（NIR1_GRAPH_REVISION_INPUT_LIMIT） | registration で NOMEM（READY の前に exit 1） | - | 729,214 |
| prodQ4.5 | 100,000 | 534,294 | registration を通過（READY） | 3,342,261 | - |
| prodQ4.5 | 200,000 | 834,294 | registration で NOMEM（READY の前に exit 1） | - | 229,214 |
| prodQ4.5 | 400,000 | 1,434,294 | registration で NOMEM（READY の前に exit 1） | - | 436,039 |
| prodQ4.5 | 600,000 | 2,034,294 | registration で NOMEM（READY の前に exit 1） | - | 102,416 |
| prodQ4.5 | 690,000 | 超過（NIR1_GRAPH_REVISION_INPUT_LIMIT） | registration で NOMEM（READY の前に exit 1） | - | 726,471 |
| prodQ4.5 | 700,000 | 超過（NIR1_GRAPH_REVISION_INPUT_LIMIT） | registration で NOMEM（READY の前に exit 1） | - | 736,471 |

### R2-6 推奨の構成（候補 B の定数、期限 100 ms、Q 16 MiB、Native 3 MiB）の本番の親の経路（`CQueryWorkerOwner`、n=10）

- uptime-before-native: `14:43:49 up 18:08,  1 user,  load average: 3.84, 3.26, 2.74`
- uptime-after-native: `14:45:49 up 18:10,  1 user,  load average: 10.72, 6.01, 3.81`

| S | seed | 最後の結果 | call p50／最大 ms | lease p50／最大 ms（有効な結果が返った回数） |
|---|---|---|---|---|
| 30 | m1 | available | 90.48／93.91 | 88.85／93.23（10/10） |
| 30 | m2 | available | 91.86／93.82 | 90.82／92.13（10/10） |
| 30 | m3 | available | 99.54／101.96 | 88.63／98.62（6/10） |
| 30 | c01 | available | 92.15／102.06 | 84.15／90.47（6/10） |
| 30 | m5 | available | 21.06／29.26 | 19.90／28.07（10/10） |
| 34 | m1 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.07／102.17 | -（0/10） |
| 34 | m2 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.12／102.51 | -（0/10） |
| 34 | m3 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.29／104.99 | -（0/10） |
| 34 | c01 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.12／102.73 | 92.75／92.94（3/10） |
| 34 | m5 | available | 30.47／63.26 | 29.30／59.98（10/10） |
| 36 | m1 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.90／102.62 | -（0/10） |
| 36 | m2 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.88／101.94 | -（0/10） |
| 36 | m3 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.94／102.08 | -（0/10） |
| 36 | c01 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.94／102.18 | -（0/10） |
| 36 | m5 | available | 30.70／35.90 | 29.52／34.75（10/10） |
| 38 | m1 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.89／102.07 | -（0/10） |
| 38 | m2 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.05／102.40 | -（0/10） |
| 38 | m3 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.90／102.69 | -（0/10） |
| 38 | c01 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.03／103.40 | -（0/10） |
| 38 | m5 | available | 28.76／33.18 | 28.01／32.02（10/10） |
| 40 | m1 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.02／102.14 | -（0/10） |
| 40 | m2 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.00／102.07 | -（0/10） |
| 40 | m3 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.95／102.02 | -（0/10） |
| 40 | c01 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.11／101.96 | 100.00／100.00（2/10） |
| 40 | m5 | available | 32.70／35.20 | 31.53／35.11（10/10） |
| 50 | m1 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 102.01／102.11 | -（0/10） |
| 50 | m2 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.65／102.03 | -（0/10） |
| 50 | m3 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.93／102.19 | -（0/10） |
| 50 | c01 | refused（NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME） | 101.92／101.99 | -（0/10） |
| 50 | m5 | available | 41.14／56.08 | 39.96／54.86（10/10） |

## 追補（draft の第 3 回の修正で足した集計）

draft が引く数値のうち、表の本体に無かったものの根拠。集計は `raw.tar.gz` を展開した `raw/` に対して行った。

### A-1 A2 の合計の最大（whole-set の見積りの根拠）

`P7ROW` の行から、場面数ごとに `a2_bytes`（A2 の payload・envelope・decision の bytes の合計）の最大と、`a2_bytes + a3_bytes + shared_bytes` の最大を取った（seed は m1〜m5、c01。summary は fixture の `P7_SUMMARY_CHARS`）。whole-set（16 MiB = 16,777,216 B）は、これに live Source と metadata も数える。**その分は測っていないので、whole-set に対する比は A2 の合計だけの下限である。**

| 場面数 | summary | 出典 | A2 の合計の最大 | a2+a3+shared の最大 | 16 MiB に対する A2 の比 |
|---|---|---|---|---|---|
| 50 | 既定（短い） | `r2/candB-matrix-sum0.txt` | 793,621 | 865,495 | 4.7% |
| 50 | 600 字 | `r2/candB-matrix-sum600.txt` | 1,604,704 | 1,676,578 | 9.6% |
| 50 | 2000 字 | `r2/candB-matrix-sum2000.txt`（候補 B） | 3,545,258 | 3,617,132 | 21.1% |
| 50 | 2000 字 | `matrix-raised-sum2000.txt`（上限を外した build） | 3,452,168 | 3,523,510 | 20.6% |
| 100 | 2000 字 | `r2/candB-matrix-sum2000.txt`（候補 B） | 7,042,501 | 7,181,691 | 42.0% |
| 100 | 既定 | `r2/candB-matrix-sum0.txt` | 1,574,998 | 1,714,188 | 9.4% |

2000 字・100 場面の 7.0 MB（上限を外した build の R1 では 6.9 MB）は、入力の論理上限 6,291,456 B（変えない）を超えるので query は unavailable になる（R2-1。work-other）。

### A-2 worker の実行ファイルの bytes（`ls -l`）

`cargo build --release --locked -p grimodex-db --bin nir1-c-query-worker`。Q と Native は `MEASURE_Q_BYTES`／`MEASURE_NATIVE_BYTES` で build 時に変える（`harness/measure-instrumentation.patch`）。定数の変更は `harness/build-*.sh`。Native 領域の大きさは実行ファイルの大きさを変えない（Q 16 MiB で Native 1.5 MiB と 3 MiB が同じ 91,415,264 B）。増分は Q の増分に等しい（4.5 MiB→8 MiB で +3,670,016 B＝3.5 MiB）。

| ファイル（作業領域） | Q | Native | 定数 | bytes | 4.5 MiB 比 |
|---|---|---|---|---|---|
| `worker-q4_5MiB` | 4,718,592 B | 1.5 MiB | 現行 | 79,356,200 | 0 |
| `worker-q8MiB` | 8 MiB | 1.5 MiB | 現行 | 83,026,216 | +3,670,016 |
| `worker-q16MiB` | 16 MiB | 1.5 MiB | 現行 | 91,414,840 | +12,058,640 |
| `worker-q32MiB` | 32 MiB | 1.5 MiB | 現行 | 108,192,040 | +28,835,840 |
| `r2/worker-candB-q8-n3` | 8 MiB | 3 MiB | 候補 B | 83,026,632 | +3,670,432 |
| `r2/worker-candB-q16-n3` | 16 MiB | 3 MiB | 候補 B | 91,415,264 | +12,059,064 |
| `r2/worker-candB-q16-n15` | 16 MiB | 1.5 MiB | 候補 B | 91,415,264 | +12,059,064 |
| `r2/worker-candB10s-q16-n3` | 16 MiB | 3 MiB | 候補 B、lease 10 s | 91,414,784 | +12,058,584 |
| `worker-candB-q32MiB` | 32 MiB | 1.5 MiB | 候補 B | 108,192,456 | +28,836,256 |
| `worker-candB-100ms-q32MiB` | 32 MiB | 1.5 MiB | 候補 B、lease 100 ms | 108,191,976 | +28,835,776 |
| `worker-candA-q32MiB` | 32 MiB | 1.5 MiB | 候補 A | 108,192,776 | +28,836,576 |
| `worker-raised-q32MiB` | 32 MiB | 1.5 MiB | 上限を外した | 108,192,456 | +28,836,256 |

Q 16 MiB と 32 MiB の差は +16,777,200 B（約 17 MB）。32 MiB は 4.5 MiB 比で 27.5 MiB 増える。

### A-3 worker 実行の回数と終了状態

`grep -rh 'P7WORKER\|P7PROD' raw | grep -o 'exit=[A-Za-z()0-9]*' | sort | uniq -c`: `exit=Some(0)` 791 件、`exit=Some(1)` 22 件、signal 終了（`exit=None`）0 件。合計 813 回。`P7WORKER` が 709 行、`P7PROD` が 104 行。`P7NATIVE`（本番の親の経路。89 行）は別の集計で、この 813 回に含めない。

### A-4 pages の数え方と実測

`QUERY_MAX_PAGES` の対象は `usage.pages`。これは、候補の indexed page を 1 回読むたび（`nir1_graph.rs:1816`）と、scene pin の page を 1 回読むたび（同 `:2398`）に 1 増える。A2・A3・shared の行は pages に入らない。1 page は 16 行以下で、行が少ない page も、空の page も 1 と数える。したがって pages は records÷16 ではなく、辿る Entity の数に連動する。

| 場面数・cast | 最大 Entity | 最大 pages | 1 Entity あたり | 出典 |
|---|---|---|---|---|
| 50、5+15（m1） | 13 | 24 | 1.85 | 表 2 |
| 50、8+40 | 22 | 35 | 1.59 | R2-1 |
| 50、12+80 | 23 | 38 | 1.65 | R2-1 |
| 200、5+15（m1） | 13 | 43 | 3.3 | 表 2 |

Entity 50 のときの pages は、1 Entity あたり 1.65〜1.85 を掛けた **推定** 83〜93。測っていない。

### A-5 peak の台帳と 100 ms 付近の必要量

- `QueryUsage.peak` は入力 bytes・retained の見積り・serde に渡す bytes を 1 つの台帳で数える（`nir1_graph.rs:1538-1547`）。上限は 6,291,456 B（変えない）。R2-1 の最大 peak は、summary 2000 字・cast 5+15・50 場面で 5,861,161 B（93.2%）、summary 600 字・100 場面で 5,843,539 B（92.9%）。2000 字・100 場面は work-other で 6 seed 中 1 seed しか available にならなかった。
- 100 ms が当たる付近（R1 の境界表、in-process の lease 最大）: m1 36 場面で records 702／steps 165,336／lease 98.6 ms、38 場面で records 738／steps 174,694／lease 106.2 ms。c01 は 45 場面で lease 109.1 ms。
- frame の大きさ（R2-2）: summary 2000 字・50 場面の m2 が最大の 1,481,356 B（records 967 で 1 record あたり約 1,532 B）。records が増えれば frame はほぼ線形に増える（推定）。records 2,048 では約 3.14 MB（3 MiB の 99.7%）、A2 の合計が入力の論理上限に届く約 1,700 records では約 2.6 MB（83%）。**どちらも未測定。**

### A-6 R1 の製品形の失敗点が示すもの（Q 4.5 MiB）

`raw/product-q4_5MiB.txt` の `fail=(種別, 要求 bytes, allocated, 空き)`。要求が空き以下なのに NOMEM になる点は、空きの合計ではなく断片化で失敗したことを示す。

| A2 bytes | 要求 | 空き | 解釈 |
|---|---|---|---|
| 1,188,677 | 388,482 | 365,504 | 枯渇（要求が空きより大きい） |
| 1,398,845 | 458,538 | 348,384 | 枯渇 |
| 1,608,797 | 43,830 | 148,192 | **断片化**（要求が空きより小さい） |
| 1,848,773 | 608,514 | 318,272 | 枯渇 |
| 2,094,797 | 4,376 | 73,280 | **断片化** |

C-query 受入れ台帳 §7.2（#664）が記録する「4 件の製品形 project（`pm-300000`）が S3 以降に断片化で NOMEM になる」は、R2-4 の `4×p:300000`（現行の Q でも available）と食い違う。fixture が repo に無く、原因は未特定（**未解決**）。
