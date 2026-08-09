# Zen shader pipeline research runner

This research-only runner separates Paper Shader scene cost from Grimodex's
scene effects and full-screen composite cost. It also ranks all 29 catalog
shaders under one deterministic 1920x1080, DPR 1 workload.

The normal application renderer is unchanged. GPU timer queries and unmasked
GPU metadata remain dormant unless a dedicated research runner explicitly
enables them.

Deterministic direct-path and image-upload regressions run separately from the
production WebGL suite:

```powershell
pnpm test:zen-shader-webgl --run
```

## A-D pipeline attribution

Use the same fixed frame, resolution, palette, and effect strengths for every
row. The runner forces `speed=0` and `opacity=100`, including for animated
shaders, so each sample renders identical input instead of measuring animation
drift.

| Stage | Command condition                                           | What it measures                                                   |
| ----- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| A     | `--pipeline raw --dither off --halftone off`                | Paper Shader fragment drawn directly to the default framebuffer    |
| B     | `--pipeline raw --dither on` and/or `--halftone on`         | A plus Grimodex Scene effects, without an intermediate framebuffer |
| C     | `--pipeline scene` with B's effect settings                 | Scene RGBA8 target plus a pass-through full-screen composite       |
| D     | `--pipeline full --glass off` with optional `--contrast on` | Production Composite shader and its enabled features               |

The differences have the intended interpretation:

```text
A -> B: Dither / Halftone
B -> C: intermediate Scene FBO + full-screen texture composite
C -> D: Contrast Guard and the production Composite path
A:      Paper Shader fragment cost
```

`raw` is a measurement prototype, not a production fast path. It deliberately
uses opacity 100; a product path must preserve the current backdrop/opacity and
alpha contract before adoption.

The `full` path uses the product's minimum UI-surface shader capacity of 16 and
a deterministic layout fixture derived from the existing Chromium layout
contracts. With Glass off, active UI surfaces are zero, matching product
behavior. With Glass on, the fixture activates four representative ambient and
Editor-tool surfaces; the artifact records their normalized geometry and active
count. This keeps the normal Glass-off D row realistic while making the Glass
ablation reproducible.

## Running measurements

Run one condition per artifact:

```powershell
pnpm research:zen-shaders --output .artifacts/zen-shaders/a-raw.json `
  --shader all --pipeline raw --dither off --halftone off

pnpm research:zen-shaders --output .artifacts/zen-shaders/b-scene-effects.json `
  --shader all --pipeline raw --dither on --halftone on

pnpm research:zen-shaders --output .artifacts/zen-shaders/c-intermediate.json `
  --shader all --pipeline scene --dither on --halftone on

pnpm research:zen-shaders --output .artifacts/zen-shaders/d-composite.json `
  --shader all --pipeline full --dither on --halftone on --contrast on

pnpm research:zen-shaders --output .artifacts/zen-shaders/glass-layout.json `
  --shader all --pipeline full --glass on --blur 22
```

Defaults are all 29 shaders, 1920x1080 CSS pixels, DPR 1, one sacrificial prime
run, 30 warmup draws, 60 measured draws, three recorded runs, fixed frame 1000,
and deterministic shader order seed 492. Useful overrides are:

```text
--shader all|<catalog-id>
--pipeline raw|scene|full
--dither on|off --dither-strength 0..1
--halftone on|off --halftone-strength 0..1
--contrast on|off
--glass on|off --blur <positive number>
--width <integer> --height <integer>
--warmup <integer> --frames <integer> --runs <integer>
--prime-runs <integer>
--frame <finite number>
--order-seed 0..4294967295
--timing both|pass-breakdown|frame
--headed
```

Glass and Contrast Guard require `--pipeline full`. The `--dither` flag here
means Grimodex's Scene effect; it is distinct from the blur runner's RGBA8
quantization-dither flag.

`--timing both` launches separate mounts for pass-breakdown and exact frame
queries. WebGL elapsed-time queries cannot be nested, so the pass sum is for
attribution while the single-query frame p95 is the ranking metric. If a run
intentionally requests pass-breakdown only, the artifact labels its fallback
ranking metric `pass-query-sum-p95`.

## Validity and artifact contents

The runner rejects software rasterizers, requires unmasked GPU identity and
`EXT_disjoint_timer_query_webgl2`, and requires ANGLE D3D11 on Windows. It
also fails on a missing sample, GPU query error/disjoint state, unexpected draw
topology, changed GPU identity, or a render size different from the requested
size. A failed rerun does not replace an existing artifact.

Each JSON artifact records:

- source revision/dirty state and patched Paper package versions/checksums;
- deterministic execution order, effective shader props, palette, and all
  ablation settings;
- the fixed Composite layout, UI-surface variant capacity, and active surface
  count;
- raw per-draw GPU and CPU-submit samples for every run;
- Scene, Composite, and exact frame p50/p95/p99 values;
- draw-call count, render size, Scene target bytes, and total intermediate
  texture bytes;
- successful image-texture upload count for image-source shaders; and
- a heavy-first ranking of the selected shaders.

Static catalog shaders are forced to redraw only for benchmark sampling. This
measures their per-draw cost, not continuous product load; production already
stops their animation loop. Chromium/Electron compositor cost and Task Manager
GPU percentage are outside WebGL timer scope and should be recorded separately
as reference observations when making an adoption decision.

The `.artifacts/` directory is ignored by Git. Attach the raw JSON artifacts to
the research PR or benchmark record rather than committing them.
