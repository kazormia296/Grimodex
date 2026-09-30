import { createRef, type RefObject } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { PaperShaderElement, ShaderMount } from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ZenMultipassPerformanceReport,
  type ZenMultipassPerformanceStats,
} from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import {
  createZenShaderCadenceScheduler,
  type ZenShaderCadenceDriver,
  type ZenShaderCadenceMode,
  type ZenShaderCadenceSnapshot,
} from "./zenShaderCadenceResearch";
import {
  aggregateZenShaderCadenceRunReports,
  buildZenShaderCadenceRunReport,
  type ZenShaderCadenceRunAggregate,
  type ZenShaderCadenceRunReport,
} from "./zenShaderCadenceResearchReport";
import {
  getPaperShaderDefinition,
  type PaperShaderId,
} from "./paperShaderCatalog";
import {
  assertZenShaderResearchRenderSize,
  resolveZenShaderResearchShaderIds,
  ZEN_SHADER_RESEARCH_PALETTE,
} from "./zenShaderResearchConfig";
import type { ZenShaderResearchPipeline } from "./zenShaderResearchPipeline";
import { ZEN_SHADER_MAX_FPS } from "./zenShaderAnimation";
import {
  resolveZenShaderAnimationSpeed,
  ZEN_SHADER_DEFAULTS,
} from "./zenShaderConfig";
import {
  collectZenWebGlMetadata,
  type ZenWebGlMetadata,
} from "./zenWebGlDiagnostics";

declare const __ZEN_SHADER_RESEARCH_SCENARIO__: {
  shader: string;
  cadence:
    | "all"
    | "native-raf"
    | "timer-60"
    | "raf-skip-60"
    | "stopped-retained";
  durationMs: number;
  pipeline: ZenShaderResearchPipeline;
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  glass: boolean;
  blur: number;
  width: number;
  height: number;
  runs: number;
  frame: number;
  orderSeed: number;
  headed: boolean;
  sourceRevision: string | null;
  sourceDirty: boolean | null;
  paperPackages: {
    shaders: { version: string; patchSha256: string };
    shadersReact: { version: string; patchSha256: string };
  };
};
declare const __ZEN_SHADER_RESEARCH_REPORT_ENDPOINT__: string;
declare const __ZEN_SHADER_RESEARCH_WRITE_TOKEN__: string;

const CADENCE_MODES = [
  "native-raf",
  "timer-60",
  "raf-skip-60",
  "stopped-retained",
] as const satisfies readonly ZenShaderCadenceMode[];

// A four-condition Williams design balances the condition immediately before
// each other condition. A seeded label permutation and row offset avoid a
// fixed policy or shader always occupying the same thermal position.
const BALANCED_POLICY_ROWS = [
  [0, 1, 3, 2],
  [1, 2, 0, 3],
  [2, 3, 1, 0],
  [3, 0, 2, 1],
] as const;

const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render driver|\bwarp\b|software rasterizer/i;
const TARGET_FPS = ZEN_SHADER_MAX_FPS;
const ACTIVE_ANIMATION_SPEED = resolveZenShaderAnimationSpeed(
  ZEN_SHADER_DEFAULTS.speed,
  ZEN_SHADER_DEFAULTS.speedMode,
);

type ResearchMount = Omit<
  ShaderMount,
  | "getCurrentFrame"
  | "getPerformanceStats"
  | "getPerformanceReport"
  | "resetPerformanceStats"
> & {
  getCurrentFrame(): number;
  getPerformanceStats(): ZenMultipassPerformanceStats;
  getPerformanceReport(): ZenMultipassPerformanceReport;
  resetPerformanceStats(): void;
};

interface CapturedCadenceRun {
  report: ZenShaderCadenceRunReport;
  scheduler: ZenShaderCadenceSnapshot;
  contextId: string;
  resourceEpoch: number;
}

interface CadenceArtifactRun extends CapturedCadenceRun {
  shader: {
    id: PaperShaderId;
    name: string;
    animated: boolean;
    imageSource: boolean;
  };
  shaderExecutionOrdinal: number;
  runOrdinal: number;
  policyOrdinal: number;
  executionOrdinal: number;
  cadenceMode: ZenShaderCadenceMode;
  animationSpeed: number;
}

function cadenceResearchOptions(): ZenBlurResearchOptions {
  return {
    ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    dualKawase: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.dualKawase },
    displayNoise: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.displayNoise },
    rgba8Dither: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.rgba8Dither },
    gpuTiming: {
      ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.gpuTiming,
      measurementMode: "off",
    },
  };
}

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as ResearchMount | undefined;
  if (!mount) throw new Error("Zen shader cadence mount is unavailable");
  return mount;
}

function nextAnimationFrame() {
  return new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

function researchPageDocument() {
  try {
    return window.top?.document ?? document;
  } catch {
    return document;
  }
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 30_000,
) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error(message);
    await nextAnimationFrame();
  }
}

function assertActiveResearchPage() {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const pageDocument = researchPageDocument();
  const pageView = pageDocument.defaultView;
  if (!scenario.headed) {
    throw new Error("Zen cadence research requires a headed browser");
  }
  if (pageDocument.visibilityState !== "visible") {
    throw new Error(
      `Zen cadence research requires a visible document, received ${pageDocument.visibilityState}`,
    );
  }
  if (!pageDocument.hasFocus()) {
    throw new Error("Zen cadence research requires browser focus");
  }
  if (
    !pageView ||
    pageView.innerWidth !== scenario.width ||
    pageView.innerHeight !== scenario.height ||
    pageView.devicePixelRatio !== 1
  ) {
    throw new Error(
      `Zen cadence viewport must be ${scenario.width}x${scenario.height} at DPR 1`,
    );
  }
}

function assertHardwareRenderer(metadata: ZenWebGlMetadata) {
  const renderer = metadata.unmaskedRenderer;
  if (!renderer) {
    throw new Error("Unmasked hardware GPU renderer metadata is required");
  }
  const gpuIdentity = [
    metadata.vendor,
    metadata.renderer,
    metadata.unmaskedVendor,
    renderer,
  ]
    .filter(Boolean)
    .join(" ");
  if (SOFTWARE_RENDERER_PATTERN.test(gpuIdentity)) {
    throw new Error(
      `Software WebGL renderer is not a valid cadence benchmark: ${renderer}`,
    );
  }
  if (
    /^win/i.test(metadata.platform ?? "") &&
    !/d3d11|direct3d11/i.test(renderer)
  ) {
    throw new Error(
      `Windows Zen cadence research requires ANGLE D3D11: ${renderer}`,
    );
  }
}

function assertGpuTimerOff(mount: ResearchMount) {
  const report = mount.getPerformanceReport();
  if (
    report.gpuTimingMode !== "off" ||
    report.performanceStats.gpuTimingSampleCount !== 0 ||
    report.gpuBenchmark.samples.length !== 0
  ) {
    throw new Error("GPU timer must remain disabled for cadence research");
  }
}

function requiredResourceIdentity(stats: ZenMultipassPerformanceStats) {
  const { contextId, resourceEpoch } = stats;
  if (typeof contextId !== "string" || contextId.trim() === "") {
    throw new Error("Zen cadence contextId is required");
  }
  if (
    typeof resourceEpoch !== "number" ||
    !Number.isSafeInteger(resourceEpoch) ||
    resourceEpoch < 1
  ) {
    throw new Error("Zen cadence resourceEpoch must be a positive integer");
  }
  return { contextId, resourceEpoch };
}

function assertSameHardware(
  expected: ZenWebGlMetadata,
  actual: ZenWebGlMetadata,
) {
  const keys = [
    "vendor",
    "renderer",
    "unmaskedVendor",
    "unmaskedRenderer",
    "version",
    "shadingLanguageVersion",
    "platform",
  ] as const satisfies readonly (keyof ZenWebGlMetadata)[];
  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `GPU metadata changed at ${key}: ${String(expected[key])} -> ${String(actual[key])}`,
      );
    }
  }
}

function assertStableSurface(
  ref: RefObject<PaperShaderElement | null>,
  mount: ResearchMount,
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
  contextId: string,
  resourceEpoch: number,
) {
  if (currentMount(ref) !== mount) {
    throw new Error("Cadence policy remounted the shader Surface");
  }
  if (canvas.getContext("webgl2") !== gl) {
    throw new Error("Cadence policy replaced the WebGL2 context");
  }
  const stats = mount.getPerformanceStats();
  if (stats.contextId !== contextId || stats.resourceEpoch !== resourceEpoch) {
    throw new Error("Cadence policy recreated GPU resources");
  }
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function shuffle<Value>(values: readonly Value[], random: () => number) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function shaderSeed(seed: number, shader: PaperShaderId) {
  let mixed = seed >>> 0;
  for (let index = 0; index < shader.length; index += 1) {
    mixed = Math.imul(mixed ^ shader.charCodeAt(index), 0x0100_0193) >>> 0;
  }
  return mixed;
}

function policyOrders(
  cadence: typeof __ZEN_SHADER_RESEARCH_SCENARIO__.cadence,
  runs: number,
  seed: number,
): ZenShaderCadenceMode[][] {
  if (cadence !== "all") {
    return Array.from({ length: runs }, () => [cadence]);
  }

  const random = seededRandom(seed);
  const labels = shuffle(CADENCE_MODES, random);
  const firstRow = Math.floor(random() * BALANCED_POLICY_ROWS.length);
  return Array.from({ length: runs }, (_, runOrdinal) => {
    const row =
      BALANCED_POLICY_ROWS[
        (firstRow + runOrdinal) % BALANCED_POLICY_ROWS.length
      ]!;
    return row.map((index) => labels[index]!);
  });
}

function browserCadenceDriver(): ZenShaderCadenceDriver {
  return {
    now: () => performance.now(),
    requestAnimationFrame: (callback) => requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: (handle) => window.clearTimeout(handle),
  };
}

async function settleSurface(mount: ResearchMount, shader: PaperShaderId) {
  await waitUntil(
    () => mount.getPerformanceStats().isStaticFrameReady,
    `${shader} cadence Surface did not settle`,
  );
  await nextAnimationFrame();
  await nextAnimationFrame();
}

async function captureCadenceRun({
  ref,
  mount,
  canvas,
  gl,
  shader,
  mode,
  contextId,
  resourceEpoch,
}: {
  ref: RefObject<PaperShaderElement | null>;
  mount: ResearchMount;
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  shader: PaperShaderId;
  mode: ZenShaderCadenceMode;
  contextId: string;
  resourceEpoch: number;
}): Promise<CapturedCadenceRun> {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  await settleSurface(mount, shader);
  assertActiveResearchPage();
  assertStableSurface(ref, mount, canvas, gl, contextId, resourceEpoch);
  assertGpuTimerOff(mount);

  mount.resetPerformanceStats();
  const frameStart = mount.getCurrentFrame();
  const animationSpeed =
    mode === "stopped-retained" ? 0 : ACTIVE_ANIMATION_SPEED;
  const rafTimestampsMs: number[] = [];
  const drawTimestampsMs: number[] = [];
  let observedDrawCount = 0;

  const scheduler = createZenShaderCadenceScheduler({
    mode,
    animationSpeed,
    initialFrame: frameStart,
    targetFps: TARGET_FPS,
    driver: browserCadenceDriver(),
    emitFrame: (frame) => mount.setFrame(frame),
  });

  const wallStartedAtMs = performance.now();
  const windowResult = await new Promise<{
    wallEndedAtMs: number;
    stats: ZenMultipassPerformanceStats;
    frameEnd: number;
    snapshot: ZenShaderCadenceSnapshot;
  }>((resolve, reject) => {
    let observerHandle: number | null = null;
    let stopHandle: number | null = null;
    let finished = false;

    const stopHandles = () => {
      scheduler.stop();
      if (observerHandle !== null) {
        cancelAnimationFrame(observerHandle);
        observerHandle = null;
      }
      if (stopHandle !== null) {
        window.clearTimeout(stopHandle);
        stopHandle = null;
      }
    };

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      stopHandles();
      reject(error);
    };

    const observeDraws = (timestampMs: number) => {
      const nextDrawCount = mount.getPerformanceStats().drawCount;
      const newDraws = nextDrawCount - observedDrawCount;
      if (newDraws < 0 || newDraws > 1) {
        throw new Error(
          `Cadence observer saw an invalid draw delta of ${newDraws}`,
        );
      }
      if (newDraws === 1) drawTimestampsMs.push(timestampMs);
      observedDrawCount = nextDrawCount;
    };

    const observeDisplayFrame = (timestampMs: number) => {
      observerHandle = null;
      try {
        assertActiveResearchPage();
        assertStableSurface(ref, mount, canvas, gl, contextId, resourceEpoch);
        rafTimestampsMs.push(timestampMs);
        observeDraws(timestampMs);
        observerHandle = requestAnimationFrame(observeDisplayFrame);
      } catch (error) {
        fail(error);
      }
    };

    scheduler.start();
    observerHandle = requestAnimationFrame(observeDisplayFrame);
    stopHandle = window.setTimeout(() => {
      try {
        scheduler.stop();
        if (observerHandle !== null) {
          cancelAnimationFrame(observerHandle);
          observerHandle = null;
        }
        assertActiveResearchPage();
        assertStableSurface(ref, mount, canvas, gl, contextId, resourceEpoch);

        const stats = mount.getPerformanceStats();
        const unobservedDraws = stats.drawCount - observedDrawCount;
        if (unobservedDraws < 0 || unobservedDraws > 1) {
          throw new Error(
            `Cadence boundary saw an invalid draw delta of ${unobservedDraws}`,
          );
        }
        if (unobservedDraws === 1) {
          // The renderer's setFrame call schedules its own rAF. If that draw
          // runs after our observer in the final display tick, the two
          // callbacks share a rAF timestamp. Attribute this one boundary
          // sample to the wall-clock stop instead of inventing a duplicate
          // display timestamp.
          const boundaryTimestamp = Math.max(
            performance.now(),
            (drawTimestampsMs.at(-1) ?? wallStartedAtMs) + 0.001,
          );
          drawTimestampsMs.push(boundaryTimestamp);
          observedDrawCount = stats.drawCount;
        }

        const wallEndedAtMs = Math.max(
          performance.now(),
          drawTimestampsMs.at(-1) ?? wallStartedAtMs + 0.001,
        );
        const snapshot = scheduler.getSnapshot();
        const frameEnd = mount.getCurrentFrame();
        finished = true;
        stopHandles();
        resolve({ wallEndedAtMs, stats, frameEnd, snapshot });
      } catch (error) {
        fail(error);
      }
    }, scenario.durationMs);
  });

  if (windowResult.stats.drawCount !== drawTimestampsMs.length) {
    throw new Error(
      `Recorded ${drawTimestampsMs.length}/${windowResult.stats.drawCount} cadence draw timestamps`,
    );
  }
  if (windowResult.snapshot.frame !== windowResult.frameEnd) {
    throw new Error("Scheduler and Surface frame state diverged");
  }
  assertZenShaderResearchRenderSize(windowResult.stats, scenario);
  assertGpuTimerOff(mount);

  const schedulerWakeupCount =
    windowResult.snapshot.rafCallbackCount +
    windowResult.snapshot.timerWakeupCount;
  if (
    mode === "stopped-retained" &&
    (schedulerWakeupCount !== 0 ||
      windowResult.snapshot.emittedFrameCount !== 0 ||
      windowResult.stats.drawCount !== 0 ||
      windowResult.stats.drawCallCount !== 0 ||
      windowResult.frameEnd !== frameStart)
  ) {
    throw new Error(
      "stopped-retained advanced its scheduler, draw, or frame state",
    );
  }

  return {
    report: buildZenShaderCadenceRunReport({
      cadenceMode: mode,
      wallStartedAtMs,
      wallEndedAtMs: windowResult.wallEndedAtMs,
      rafCallbackCount: rafTimestampsMs.length,
      rafTimestampsMs,
      schedulerWakeupCount,
      drawCount: windowResult.stats.drawCount,
      drawCallCount: windowResult.stats.drawCallCount,
      drawTimestampsMs,
      frameStart,
      frameEnd: windowResult.frameEnd,
      animationElapsedMs: windowResult.snapshot.integratedElapsedMs,
      animationSpeed,
      visibilityState: researchPageDocument().visibilityState,
      focused: researchPageDocument().hasFocus(),
    }),
    scheduler: windowResult.snapshot,
    contextId,
    resourceEpoch,
  };
}

async function postArtifact(artifact: unknown) {
  const response = await fetch(__ZEN_SHADER_RESEARCH_REPORT_ENDPOINT__, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zen-shader-research-token": __ZEN_SHADER_RESEARCH_WRITE_TOKEN__,
    },
    body: JSON.stringify(artifact),
  });
  if (!response.ok) {
    throw new Error(
      `Could not write Zen cadence research artifact: ${await response.text()}`,
    );
  }
}

function validateScenario() {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  if (!(Number.isFinite(scenario.durationMs) && scenario.durationMs > 0)) {
    throw new TypeError("Cadence durationMs must be positive and finite");
  }
  if (!Number.isSafeInteger(scenario.runs) || scenario.runs < 1) {
    throw new TypeError("Cadence runs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(scenario.orderSeed) || scenario.orderSeed < 0) {
    throw new TypeError("Cadence orderSeed must be non-negative");
  }
  assertActiveResearchPage();
}

afterEach(cleanup);

describe("Zen shader wall-cadence research runner", () => {
  it("captures seeded balanced cadence policies without remounting a shader", async () => {
    validateScenario();
    const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
    const shaderIds = resolveZenShaderResearchShaderIds(
      scenario.shader,
      scenario.orderSeed,
    );
    const artifactRuns: CadenceArtifactRun[] = [];
    const aggregates: Array<
      ZenShaderCadenceRunAggregate & {
        shader: {
          id: PaperShaderId;
          name: string;
          animated: boolean;
          imageSource: boolean;
        };
      }
    > = [];
    const ordersByShader: Array<{
      shader: PaperShaderId;
      runs: ZenShaderCadenceMode[][];
    }> = [];
    let gpuMetadata: ZenWebGlMetadata | null = null;
    let executionOrdinal = 0;

    for (const [shaderExecutionOrdinal, shader] of shaderIds.entries()) {
      const definition = getPaperShaderDefinition(shader);
      const shaderDescriptor = {
        id: shader,
        name: definition.name,
        animated: definition.animated,
        imageSource: definition.imageSource ?? false,
      };
      const orders = policyOrders(
        scenario.cadence,
        scenario.runs,
        shaderSeed(scenario.orderSeed, shader),
      );
      ordersByShader.push({ shader, runs: orders });

      const ref = createRef<PaperShaderElement>();
      const view = render(
        <ZenShaderResearchSurface
          ref={ref}
          shader={shader}
          pipeline={scenario.pipeline}
          dither={scenario.dither}
          ditherStrength={scenario.ditherStrength}
          halftone={scenario.halftone}
          halftoneStrength={scenario.halftoneStrength}
          contrast={scenario.contrast}
          glass={scenario.glass}
          blur={scenario.blur}
          frame={scenario.frame}
          width={scenario.width}
          height={scenario.height}
          researchOptions={cadenceResearchOptions()}
        />,
      );

      try {
        await waitFor(
          () => {
            expect(
              ref.current?.paperShaderMount?.getPerformanceStats()
                .isStaticFrameReady,
            ).toBe(true);
          },
          {
            timeout: 30_000,
            onTimeout: () =>
              new Error(`${shader} cadence canvas did not become ready`),
          },
        );

        const mount = currentMount(ref);
        const canvas = view.container.querySelector("canvas");
        if (!canvas) throw new Error(`${shader} cadence canvas is unavailable`);
        const gl = canvas.getContext("webgl2");
        if (!gl) throw new Error(`${shader} WebGL2 context is unavailable`);
        const currentGpuMetadata = collectZenWebGlMetadata(gl, navigator);
        assertHardwareRenderer(currentGpuMetadata);
        if (gpuMetadata) {
          assertSameHardware(gpuMetadata, currentGpuMetadata);
        } else {
          gpuMetadata = currentGpuMetadata;
        }

        const initialStats = mount.getPerformanceStats();
        const { contextId, resourceEpoch } =
          requiredResourceIdentity(initialStats);
        assertZenShaderResearchRenderSize(initialStats, scenario);
        assertGpuTimerOff(mount);
        if (definition.imageSource && initialStats.imageTextureCount < 1) {
          throw new Error(
            `${shader} did not upload its required image texture`,
          );
        }

        if (mount.getCurrentFrame() !== scenario.frame) {
          mount.setFrame(scenario.frame);
          await waitUntil(
            () =>
              mount.getCurrentFrame() === scenario.frame &&
              mount.getPerformanceStats().isStaticFrameReady,
            `${shader} did not render its cadence start frame`,
          );
        }

        for (const [runOrdinal, order] of orders.entries()) {
          for (const [policyOrdinal, cadenceMode] of order.entries()) {
            const captured = await captureCadenceRun({
              ref,
              mount,
              canvas,
              gl,
              shader,
              mode: cadenceMode,
              contextId,
              resourceEpoch,
            });
            artifactRuns.push({
              ...captured,
              shader: shaderDescriptor,
              shaderExecutionOrdinal,
              runOrdinal,
              policyOrdinal,
              executionOrdinal,
              cadenceMode,
              animationSpeed:
                cadenceMode === "stopped-retained" ? 0 : ACTIVE_ANIMATION_SPEED,
            });
            executionOrdinal += 1;
          }
        }

        await settleSurface(mount, shader);
        assertStableSurface(ref, mount, canvas, gl, contextId, resourceEpoch);

        for (const cadenceMode of scenario.cadence === "all"
          ? CADENCE_MODES
          : ([scenario.cadence] as const)) {
          const reports = artifactRuns
            .filter(
              (run) =>
                run.shader.id === shader && run.cadenceMode === cadenceMode,
            )
            .map(({ report }) => report);
          aggregates.push({
            shader: shaderDescriptor,
            ...aggregateZenShaderCadenceRunReports(reports),
          });
        }
      } finally {
        view.unmount();
      }
    }

    if (!gpuMetadata) {
      throw new Error("Zen cadence research captured no GPU metadata");
    }

    await postArtifact({
      schemaVersion: 1,
      experiment: "cadence",
      capturedAtEpochMs: Date.now(),
      schedulerImplementation: {
        kind: "research-external-setFrame",
        module: "zenShaderCadenceResearch.createZenShaderCadenceScheduler",
        frameSink: "paperShaderMount.setFrame",
        modes: {
          "native-raf": "one frame emission per display rAF after baseline",
          "timer-60": "absolute-deadline timer at the product 60 Hz cap",
          "raf-skip-60":
            "display rAF with the production pending-elapsed accumulator",
          "stopped-retained": "no scheduler and retained canvas contents",
        },
        rafSkipProductionParity: {
          reference: "zenShaderAnimation.createZenShaderFrameCadence",
          targetFps: ZEN_SHADER_MAX_FPS,
          intervalToleranceMs: 0.1,
          algorithm:
            "accumulate non-negative rAF elapsed time, draw at interval minus tolerance, retain elapsed modulo interval",
        },
      },
      scenario: {
        id: `zen-shader-cadence-${scenario.width}x${scenario.height}`,
        shaderRequest: scenario.shader,
        shaderOrder: shaderIds,
        cadenceRequest: scenario.cadence,
        cadenceModes:
          scenario.cadence === "all" ? CADENCE_MODES : [scenario.cadence],
        durationMs: scenario.durationMs,
        requestedRuns: scenario.runs,
        orderSeed: scenario.orderSeed,
        orderDesign: "seeded-williams-4x4",
        ordersByShader,
        cssWidth: scenario.width,
        cssHeight: scenario.height,
        devicePixelRatio: 1,
        viewport: {
          width: researchPageDocument().defaultView?.innerWidth ?? null,
          height: researchPageDocument().defaultView?.innerHeight ?? null,
          devicePixelRatio:
            researchPageDocument().defaultView?.devicePixelRatio ?? null,
        },
        targetFps: TARGET_FPS,
        activeAnimationSpeed: ACTIVE_ANIMATION_SPEED,
        headed: scenario.headed,
        gpuTimingMode: "off",
        condition: {
          pipeline: scenario.pipeline,
          dither: scenario.dither,
          ditherStrength: scenario.ditherStrength,
          halftone: scenario.halftone,
          halftoneStrength: scenario.halftoneStrength,
          contrast: scenario.contrast,
          glass: scenario.glass,
          blurRadiusPx: scenario.blur,
          initialFrame: scenario.frame,
          palette: ZEN_SHADER_RESEARCH_PALETTE,
        },
      },
      provenance: {
        sourceRevision: scenario.sourceRevision,
        sourceDirty: scenario.sourceDirty,
        paperPackages: scenario.paperPackages,
        gpuMetadata,
      },
      runs: artifactRuns,
      aggregate: aggregates,
    });
  });
});
