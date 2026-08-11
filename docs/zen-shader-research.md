# Zen shader pipeline research runner

This research-only runner separates Paper Shader scene cost from Grimodex's
scene effects and full-screen composite cost. It also ranks all 29 catalog
shaders under one deterministic 1920x1080, DPR 1 workload.

The research `raw` pipeline remains a benchmark mode. The production renderer
uses a direct path only when Glass is disabled, Contrast Guard is `none`, and
opacity is 100%. All other configurations retain the canonical multipass path.
GPU timer queries and unmasked GPU metadata remain dormant unless a dedicated
research runner explicitly enables them.

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

Research `raw` and the production direct path are separate policies. `raw`
deliberately fixes opacity at 100 for measurement. The production eligibility
check enforces the same opacity restriction and preserves the existing opaque
canvas alpha contract; any configuration that needs backdrop/opacity blending
continues through the Composite path.

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

## Follow-up experiments

The same command now owns three research-only follow-ups. None of them enables a
new production render path.

### Display cadence

The cadence experiment compares four schedulers on the same retained canvas:

| Mode               | Scheduling contract                                      |
| ------------------ | -------------------------------------------------------- |
| `native-raf`       | Redraw on every display `requestAnimationFrame` callback |
| `timer-60`         | Wake on corrected 60 Hz timer deadlines, then redraw     |
| `raf-skip-60`      | Receive display rAF callbacks but cap redraws at 60 FPS  |
| `stopped-retained` | Keep the final canvas/context and issue no further draw  |

`raf-skip-60` represents the current product cadence. The experiment records
display-rAF intervals, scheduler wakeups, actual draw intervals, skipped rAFs,
and shader-time drift. It deliberately leaves GPU timer queries off because it
measures wall-clock scheduling rather than per-draw GPU cost.

Cadence research must run headed on the real display; headless Chromium does not
provide a meaningful high-refresh comparison:

```powershell
pnpm research:zen-shader-cadence --output .artifacts/zen-shaders/cadence.json `
  --headed --shader representative --cadence all --duration-ms 2000 --runs 5
```

The window must remain visible and focused for every recorded block. The runner
fails instead of silently accepting a hidden or unfocused sample.

### Trivial baselines and resolution scaling

The baseline experiment separates fixed WebGL cost from pixel and shader work:

| Workload           | Per-frame work                                               |
| ------------------ | ------------------------------------------------------------ |
| `clear-only`       | Clear the default framebuffer; zero fullscreen draws         |
| `solid-fullscreen` | Clear plus one constant-color fullscreen draw                |
| `texture-copy`     | Clear an RGBA8 Scene FBO and copy it with one Composite draw |
| `paper`            | Each selected Paper Shader through both `raw` and `scene`    |

Resolution order is counterbalanced by forward rotations followed by reversed
rotations. A workload keeps one WebGL context and a fixed maximum pixel budget
while the canvas is resized, then drains old queries, warms up, resets counters,
and records the next cell. Recorded runs default to one complete `2 × resolution
count` cycle (six runs for the default three resolutions); explicit run counts
must contain a whole cycle.

```powershell
pnpm research:zen-shader-baselines --output .artifacts/zen-shaders/baselines.json `
  --workload all --shader representative `
  --resolution 960x540 --resolution 1280x720 --resolution 1920x1080
```

The artifact stores requested and observed dimensions, execution order, exact
draw topology, Scene target bytes, raw samples, and per-resolution results. The
default representative set is the five provisional heavy shaders from the
first ranking.

### Same-context ABBA fast-path comparison

The ABBA experiment compiles and allocates the full path first, then switches
between `raw` and Glass-off/Contrast-off `full` without replacing the canvas,
WebGL context, programs, or resident Scene texture:

```text
ABBA, BAAB, ABBA, BAAB, ...
```

Each run averages its two blocks per variant and treats the paired `full - raw`
difference as the statistical unit. The summary reports the median paired p50
and p95 deltas, deterministic paired-bootstrap confidence intervals, and sign
counts. Pooled frame samples are retained as evidence but are not the primary
decision metric.

```powershell
pnpm research:zen-shader-abba --output .artifacts/zen-shaders/abba.json `
  --shader representative --cycles 6 --frames 60
```

The runner rejects a context ID or resource epoch change between blocks and
requires the expected `raw=1 draw` and `full=2 draws` topology. Glass and
Contrast Guard are fixed off so this experiment isolates only the intermediate
RGBA8 Scene FBO plus pass-through Composite.

### Spatial upscale matrix

The upscale experiment remains a research-only comparison and does not share
its candidate shaders or benchmark resources with the product renderer. Each
candidate renders the expensive Paper Shader into a scaled RGBA8 Scene target
and reconstructs it at the native canvas size:

| Scene scale | Full HD Scene size |
| ----------- | ------------------ |
| `1`         | 1920×1080          |
| `5/6`       | 1600×900           |
| `3/4`       | 1440×810           |
| `2/3`       | 1280×720           |

Every scale is paired with hardware bilinear, 16-tap Catmull-Rom, an FSR 1 EASU
GLSL ES port, and EASU followed by a separate presentation-resolution RCAS pass.
EASU/RCAS retains AMD's MIT notice and reference URL in source and in the result
artifact.

For every shader and matrix cell, the runner allocates the candidate resources
first and then alternates `native direct` and `candidate` blocks in ABBA/BAAB
order without replacing the canvas, WebGL context, programs, or resident
textures. Native is one draw, linear/Catmull-Rom/EASU candidates are two draws,
and EASU+RCAS is three draws. The compact artifact records paired
`candidate - native` p50/p95 GPU-frame deltas, confidence intervals, CPU submit
percentiles, draw topology, resource identity, and resident texture bytes.

```powershell
pnpm research:zen-shader-upscale --output .artifacts/zen-shaders/upscale.json `
  --shader representative --cycles 6 --frames 60
```

The upscale representative set is `liquid-metal`, `halftone-cmyk`,
`halftone-dots`, `smoke-ring`, `gem-smoke`, and `color-panels`. Dither,
Halftone, Glass, and Contrast Guard are fixed off in this first comparison so
the result isolates Paper Shader resolution and spatial reconstruction. Moving
pixel-grid effects after upscaling belongs to the later product-pipeline phase.

### Product resolution policy

The focused linear-upscale measurements selected hardware bilinear sampling for
the product renderer. The product exposes three Scene resolution modes:

| Mode          | Scene scale | Product behavior                                           |
| ------------- | ----------- | ---------------------------------------------------------- |
| `native`      | `1`         | Full-resolution Scene rendering                            |
| `balanced`    | `3/4`       | Default; the existing Composite samples a 75% Scene target |
| `performance` | `2/3`       | The existing Composite samples a 66.7% Scene target        |

The output canvas, Glass, UI masks, and Contrast Guard remain at native output
resolution. Dither and Halftone coordinates are converted back to output-pixel
space before evaluation. Scaled modes use the existing product Composite, so
they do not add an upscale-only draw. Switching modes, resizing, or changing DPR
reallocates only the Scene-sized targets and preserves the WebGL context.

The `.artifacts/` directory is ignored by Git. Attach the raw JSON artifacts to
the research PR or benchmark record rather than committing them.
