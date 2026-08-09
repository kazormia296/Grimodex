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

## Superseded preliminary measurements

The first 2026-08-09 pass-breakdown run is not an adoption baseline. Its pooled
p95 was dominated by the first recorded run, and Gaussian, planned Dual Kawase,
and canonical Dual Kawase inserted different numbers of timer queries. Those
values remain useful for pass-level debugging only. Adoption results must come
from a clean source revision, one-query `frame` and `blur` runs, a sacrificial
prime run, and randomized/interleaved condition order.
