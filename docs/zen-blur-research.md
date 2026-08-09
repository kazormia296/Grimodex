# Zen blur research runner

This runner compares internal blur and noise candidates without exposing them
as user settings. The normal renderer remains `gaussian-current` unless a
research build or this dedicated command supplies another backend.

## Run a candidate

The command launches a dedicated Chromium instance. It does not use the
SwiftShader WebGL regression configuration and is not part of a CI budget.

```powershell
pnpm research:zen-blur --output .artifacts/zen-blur/gaussian.json `
  --backend gaussian-current

pnpm research:zen-blur --output .artifacts/zen-blur/planned.json `
  --backend dual-kawase-planned --passes 3 --offset 3
```

Defaults are 1920x1080 CSS pixels, blur 22px, one sacrificial prime run, 120
warmup frames, 600 measured frames, five recorded runs, and one frame-wide GPU
query per measured frame. Useful overrides are:

```text
--blur <positive number>
--width <integer> --height <integer>
--warmup <integer> --frames <integer> --runs <integer>
--prime-runs <integer, default 1>
--backend gaussian-current|dual-kawase-canonical|dual-kawase-planned
--passes 1..4 --offset 0.5..4
--precision auto|rgba8
--timing frame|blur|pass-breakdown
--noise 0..0.02 --dither 0..0.00392156862745098
--seed 0..4294967295
--headed
```

Use `--timing frame` for the whole-frame adoption gate and `--timing blur` for
the blur-only gate. Both modes issue exactly one timer query per candidate
frame. `--timing pass-breakdown` is diagnostic only: it issues one query per
render pass, so its summed value must not be compared across backends with
different pass counts.

The runner rejects software rasterizers, requires unmasked GPU identity and
`EXT_disjoint_timer_query_webgl2`, and requires ANGLE D3D11 on Windows. Every
measured frame must produce both a GPU sample and a CPU-submit sample. A
disjoint query, context loss, pending-ring skip, changed GPU identity, changed
candidate semantics, mismatched sample count, or non-JSON value fails the run
instead of emitting partial data. A failed rerun leaves the previous output
artifact intact; staged output is promoted only after the child succeeds and
the JSON parses.

## Artifact contents

Each JSON artifact contains:

- scenario and candidate configuration, including requested and resolved
  texture precision;
- masked and unmasked WebGL/ANGLE identity and browser/OS identity;
- every raw per-frame GPU pass and CPU-submit sample;
- per-run renderer statistics, draw counts, target levels, allocation format,
  and intermediate texture bytes;
- pooled nearest-rank p50/p95/p99 values, per-run percentile median/min/max,
  and run/sample counts;
- the source Git revision and whether that source tree was dirty.

The output directory `.artifacts/` is intentionally ignored by Git. Attach raw
artifacts to the research PR or benchmark record rather than committing several
thousand frame samples to the repository.

## Verified RTX 2070 SUPER run — 2026-08-09

Source revision: `bc7124862c73a7d7e5bd71c406554c704b456c1d`, with
`sourceDirty=false` in every artifact. Environment: NVIDIA GeForce RTX 2070
SUPER 8 GiB, driver 591.86, ANGLE Direct3D11, Headless Chromium 148, Windows 11
Home 10.0.26200 (build 26200), and AMD Ryzen 5 3600. All automatic-precision
rows resolved to RGBA16F.

Each of the 13 conditions contains five recorded runs and 3,000 GPU plus 3,000
CPU samples. Every process first completed one unrecorded prime run. Condition
order was shuffled with seed `20260809`; the five runs inside a condition were
contiguous. The order and artifact mapping were:

1. planned 40px frame (`01`)
2. Gaussian 22px frame (`02`)
3. planned 40px blur (`03`)
4. Gaussian 40px frame (`04`)
5. Gaussian RGBA8 22px frame (`05`)
6. Gaussian RGBA8 plus 1-LSB dither 22px frame (`06`)
7. canonical 22px frame (`07`)
8. canonical 22px blur (`08`)
9. Gaussian 40px blur (`09`)
10. planned 22px frame (`10`)
11. Gaussian 22px blur (`11`)
12. Gaussian RGBA8 plus display noise 0.01 22px frame (`12`)
13. planned 22px blur (`13`)

### Dual Kawase quality calibration

The planned backend was swept across one to four pyramid levels and offsets
from 0.5 through 4.0. The current Gaussian measured sigma was 21.74 at 22px and
39.54 at 40px. The p3/o3 candidate used in the performance run measured
111.84 and 118.73 respectively, so those timings compare materially different
blur kernels and are diagnostic only.

The nearest sigma-matched candidates also failed the existing #489 image
quality gates:

| Blur | Candidate       |  Sigma | Anisotropy (limit) | Side peak | Continuity                                        | Result |
| ---: | --------------- | -----: | -----------------: | --------: | ------------------------------------------------- | ------ |
|   22 | planned p1/o2.5 | 22.191 |       1.268 (0.20) |    +21.38 | 21/22/23px increments differ by 1.024 (limit 0.8) | Fail   |
|   40 | planned p1/o4.0 | 38.857 |       3.318 (0.18) |    +18.75 | 39/40/41px sigma plateaus at 38.857               | Fail   |

Both candidates had non-monotonic radial profiles. The 40px candidate also
produced a terrace. RGBA8 repeated the same failures (anisotropy 1.261 and
3.313), showing that the artifact comes from the kernel rather than the
intermediate texture precision. Matching sigma alone therefore does not make
either candidate visually equivalent to the current Gaussian.

### Dual Kawase diagnostic performance

Times are milliseconds. A negative p95 delta is an improvement. The run p95
column is `median [min, max]` across the five recorded runs. These p3/o3 rows
are not adoption-gate results because the quality calibration above rejected
that kernel.

| Blur | Scope | Gaussian p50 | Gaussian p95 | Planned p50 | Planned p95 | p95 delta | Run p95, Gaussian -> planned                       |
| ---: | ----- | -----------: | -----------: | ----------: | ----------: | --------: | -------------------------------------------------- |
|   22 | blur  |       0.2494 |       0.4342 |      0.2252 |      0.3276 |    -24.5% | 0.2625 [0.1396, 0.4380] -> 0.3261 [0.2322, 0.3293] |
|   22 | frame |       1.1739 |       5.1794 |      1.3714 |      2.9884 |    -42.3% | 5.6655 [1.3066, 6.0708] -> 3.1977 [1.4258, 3.3568] |
|   40 | blur  |       0.1727 |       0.3850 |      0.1131 |      0.2239 |    -41.8% | 0.3845 [0.3419, 0.4069] -> 0.2075 [0.1280, 0.2501] |
|   40 | frame |       1.3309 |       2.7566 |      1.3011 |      5.1269 |    +86.0% | 2.5252 [1.3947, 3.6945] -> 4.6795 [1.5338, 6.2139] |

Planned Dual Kawase used nine draw calls instead of five. Intermediate texture
capacity fell from 2.359 MiB to 1.568 MiB at 22px (-33.5%) and from 1.978 MiB
to 1.314 MiB at 40px (-33.6%). CPU-submit p50 remained 0.10ms for every row,
and no post-warmup reallocation was recorded.

The canonical full-resolution control was not competitive: at 22px it used
eight draws and 21.011 MiB, with frame p50/p95 of 2.5914/7.0346ms and blur
p50/p95 of 0.9771/3.1457ms.

The pooled frames are not independent experimental repetitions, and each
condition's five runs were contiguous rather than run-level interleaved. At
22px, for example, the pooled blur p95 moved down 24.5% while the median of the
five run p95 values moved up 24.2%. The wide ranges similarly prevent causal
claims about frame tails.

Current Dual Kawase decision: **Hold**. Planned p3/o3 is not quality-matched,
and both sigma-matched dynamic candidates fail the PSF, directionality, and
continuity gates. Running an adoption benchmark for those rejected candidates
would not change the conjunctive decision. Canonical Dual Kawase is rejected;
the production default remains Gaussian.

### Noise and RGBA8 performance

All rows are Gaussian at 22px. The run p50 column is
`median [min, max]` across five runs.

| Candidate                         | Frame p50 | Frame p95 | Run p50                 | Intermediate MiB |
| --------------------------------- | --------: | --------: | ----------------------- | ---------------: |
| RGBA16F, no noise                 |    1.1739 |    5.1794 | 1.1356 [1.0414, 1.2555] |            2.359 |
| RGBA8, no noise                   |    1.1633 |    3.1066 | 1.1413 [1.1226, 1.4684] |            1.179 |
| RGBA8 + 1-LSB quantization dither |    1.1034 |    4.9049 | 1.0659 [0.4958, 1.2750] |            1.179 |
| RGBA8 + display noise 0.01        |    1.4336 |    2.2090 | 1.4275 [1.4051, 1.9456] |            1.179 |

Display noise increased pooled frame p50 by 23.2% versus RGBA8 without noise,
while pooled p95 moved in the opposite direction by 28.9%. The per-run p50
median increased 25.1%. Plain RGBA8 versus RGBA16F and the dither row show the
same kind of p50/p95 disagreement. Because the protocol did not prespecify one
of those quantiles as the primary noise-cost statistic, and conditions were
not run-level interleaved, the less-than-5% cost gate is not demonstrated in
either direction.

Current noise decision: **Hold / inconclusive**. Zero-strength exactness,
Glass-only masking, alpha preservation, and deterministic seeds are covered by
WebGL regression tests. Banding improvement, absence of visible grain,
temporal stability, and text readability do not yet have visual evidence, so
the quality gate cannot pass. Fixed blue-noise and temporal blue-noise
candidates were not evaluated. A follow-up must prespecify the primary timing
quantile and add p50 non-regression, then run candidate/control pairs in
randomized interleaved blocks before collecting matched screenshots.

### Artifact integrity manifest

Files live in `.artifacts/zen-blur/final/`. The two-digit prefix is the
execution order above.

```text
01 4da5fe4613fb5268d3db4d89a2ac1a3ca5e750a272ba01fa7921a2cfd8f7361d
02 74783bed9899bcafdf66eab73b903ddaf63383d485a219b6f6d9bccd23f5638d
03 d37e1ab388ae9c5736b2c07e8f7821d303b407b8561241e5132c3c34481be402
04 50c0cd95351a1a7ee71569daace63722128e04abe78af7c14b58652437f5e936
05 3aa8d7394d73dd6d65a873c89bf0e43805d6914f4179e24110b7df76c7416d06
06 6b548eebb740d28b6e5396e15adbefab14b56407022fefb14d1759d062c40de2
07 1931277afb8f116b9874a9e84fea09674b180a18a32f20779fbeb95316fb0fb9
08 2040b90a4ae75ba3037f37df4676d2ebf6b1dbb22ea5929c9b58d3b87d33a11a
09 4dec5a0973068786152fe8a93835b931859846040bed7de8a6a6c1b9bedeaa53
10 ea77e74f7ef32c49a743b13de326e2ff7e36be139b2711dd28a2285fb083adbd
11 70de90aa103ea00ad47da5774b61377f8fe04718868c73677183daea505e9a2f
12 7d7f4ef6508f9a4009289c8e33c9b5cb4e0eee77da5d6086d909a90499385374
13 3e869e649c0c57e9833e4abb51aad5690a69acee11f3ab6495d7fab922187549
```

## Superseded preliminary measurements

The first 2026-08-09 pass-breakdown run is not an adoption baseline. Its pooled
p95 was dominated by the first recorded run, and Gaussian, planned Dual Kawase,
and canonical Dual Kawase inserted different numbers of timer queries. Those
values remain useful for pass-level debugging only. Adoption results must come
from a clean source revision, one-query `frame` and `blur` runs, a sacrificial
prime run, and randomized/interleaved condition order.
