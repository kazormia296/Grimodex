/// <reference types="vitest/config" />
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";

const REPORT_ENDPOINT = "/__zen-shader-research-report";
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const PAPER_SHADER_COUNT = 29;
const REPRESENTATIVE_SHADER_COUNT = 5;

interface ZenShaderResearchScenarioEnvironment {
  experiment: "pipeline" | "cadence" | "baselines" | "abba";
  shader: string;
  pipeline: "raw" | "scene" | "full";
  workload:
    | "all"
    | "paper"
    | "clear-only"
    | "solid-fullscreen"
    | "texture-copy";
  resolutions: Array<{ width: number; height: number }>;
  cadence:
    | "all"
    | "native-raf"
    | "timer-60"
    | "raf-skip-60"
    | "stopped-retained";
  durationMs: number;
  cycles: number;
  sequenceStart: "abba" | "baab";
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  glass: boolean;
  blur: number;
  width: number;
  height: number;
  warmup: number;
  frames: number;
  runs: number;
  primeRuns: number;
  frame: number;
  orderSeed: number;
  timing: "both" | "pass-breakdown" | "frame";
  headed: boolean;
}

interface RepositoryPackageJson {
  dependencies?: Record<string, string>;
}

function readSourceIdentity() {
  const git = (args: readonly string[]) =>
    execFileSync("git", args, {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

  try {
    return {
      sourceRevision: git(["rev-parse", "HEAD"]),
      sourceDirty: git(["status", "--porcelain"]).length > 0,
    };
  } catch {
    return { sourceRevision: null, sourceDirty: null };
  }
}

function sha256(filePath: string) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function requiredPackageVersion(
  packageJson: RepositoryPackageJson,
  packageName: string,
) {
  const version = packageJson.dependencies?.[packageName];
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`${packageName} must have a pinned dependency version`);
  }
  return version;
}

function readPaperPackageIdentity() {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
  ) as RepositoryPackageJson;
  const shadersPatchPath = path.resolve(
    __dirname,
    "patches/@paper-design__shaders@0.0.77.patch",
  );
  const shadersReactPatchPath = path.resolve(
    __dirname,
    "patches/paper-design-shaders-react@0.0.77.patch",
  );

  return {
    paperPackages: {
      shaders: {
        version: requiredPackageVersion(packageJson, "@paper-design/shaders"),
        patchSha256: sha256(shadersPatchPath),
      },
      shadersReact: {
        version: requiredPackageVersion(
          packageJson,
          "@paper-design/shaders-react",
        ),
        patchSha256: sha256(shadersReactPatchPath),
      },
    },
  };
}

function parseScenario() {
  const serialized = process.env.GRIMODEX_ZEN_SHADER_RESEARCH_SCENARIO;
  if (!serialized) {
    throw new Error("GRIMODEX_ZEN_SHADER_RESEARCH_SCENARIO is required");
  }
  return JSON.parse(serialized) as ZenShaderResearchScenarioEnvironment;
}

function researchArtifactWriter(
  outputPath: string,
  writeToken: string,
): Plugin {
  let artifactState: "idle" | "writing" | "written" = "idle";
  return {
    name: "grimodex-zen-shader-research-artifact",
    configureServer(server) {
      server.middlewares.use(REPORT_ENDPOINT, (request, response, next) => {
        if (request.method !== "POST") {
          next();
          return;
        }
        if (
          artifactState !== "idle" ||
          request.headers["x-zen-shader-research-token"] !== writeToken ||
          !request.headers["content-type"]?.startsWith("application/json")
        ) {
          response.statusCode = artifactState !== "idle" ? 409 : 403;
          response.end("Zen shader research artifact write rejected");
          return;
        }

        artifactState = "writing";
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        let reportTooLarge = false;
        request.on("data", (chunk: Buffer) => {
          if (reportTooLarge) return;
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_REPORT_BYTES) {
            reportTooLarge = true;
            chunks.length = 0;
            return;
          }
          chunks.push(chunk);
        });
        request.on("end", () => {
          void (async () => {
            if (reportTooLarge) {
              artifactState = "idle";
              response.statusCode = 413;
              response.end("Zen shader research report is too large");
              return;
            }

            const serialized = Buffer.concat(chunks).toString("utf8");
            const artifact = JSON.parse(serialized) as unknown;
            const formatted = `${JSON.stringify(artifact, null, 2)}\n`;
            const resolvedOutputPath = path.resolve(outputPath);
            const temporaryPath = `${resolvedOutputPath}.${process.pid}.${randomUUID()}.tmp`;
            await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
            try {
              await writeFile(temporaryPath, formatted, {
                encoding: "utf8",
                flag: "wx",
              });
              await rename(temporaryPath, resolvedOutputPath);
              JSON.parse(await readFile(resolvedOutputPath, "utf8"));
              artifactState = "written";
              response.statusCode = 201;
              response.setHeader("content-type", "application/json");
              response.end('{"written":true}');
            } catch (error: unknown) {
              await rm(temporaryPath, { force: true });
              artifactState = "idle";
              throw error;
            }
          })().catch((error: unknown) => {
            if (artifactState === "writing") artifactState = "idle";
            if (!response.headersSent) {
              response.statusCode = 500;
              response.setHeader("content-type", "text/plain; charset=utf-8");
              response.end(
                error instanceof Error ? error.message : String(error),
              );
            }
          });
        });
        request.on("error", (error) => {
          if (artifactState === "writing") artifactState = "idle";
          if (response.headersSent) return;
          response.statusCode = 400;
          response.end(error.message);
        });
      });
    },
  };
}

const scenario = {
  ...parseScenario(),
  ...readSourceIdentity(),
  ...readPaperPackageIdentity(),
};
const outputPath = process.env.GRIMODEX_ZEN_SHADER_RESEARCH_OUTPUT;
if (!outputPath) {
  throw new Error("GRIMODEX_ZEN_SHADER_RESEARCH_OUTPUT is required");
}
const writeToken = process.env.GRIMODEX_ZEN_SHADER_RESEARCH_WRITE_TOKEN;
if (!writeToken) {
  throw new Error("GRIMODEX_ZEN_SHADER_RESEARCH_WRITE_TOKEN is required");
}

const alias = { "@": path.resolve(__dirname, "./src") };
const dependencyRoot = realpathSync(path.resolve(__dirname, "node_modules"));
const launchArguments = [
  ...(process.platform === "win32" ? ["--use-angle=d3d11"] : []),
  "--disable-software-rasterizer",
  ...(scenario.headed
    ? [`--window-size=${scenario.width},${scenario.height}`]
    : []),
];
const shaderCount =
  scenario.shader === "all"
    ? PAPER_SHADER_COUNT
    : scenario.shader === "representative"
      ? REPRESENTATIVE_SHADER_COUNT
      : 1;
const timingModeCount = scenario.timing === "both" ? 2 : 1;
const pipelineFrameCount =
  (scenario.warmup + scenario.frames) *
  (scenario.primeRuns + scenario.runs) *
  shaderCount *
  timingModeCount;
const baselineWorkloadCount =
  scenario.workload === "all"
    ? 3 + shaderCount * 2
    : scenario.workload === "paper"
      ? shaderCount * 2
      : 1;
const baselineFrameCount =
  (scenario.warmup + scenario.frames) *
  (scenario.primeRuns + scenario.runs) *
  Math.max(1, scenario.resolutions.length) *
  baselineWorkloadCount *
  timingModeCount;
const cadenceModeCount = scenario.cadence === "all" ? 4 : 1;
const cadenceDurationMs =
  scenario.durationMs * scenario.runs * shaderCount * cadenceModeCount;
const abbaFrameCount =
  (scenario.warmup + scenario.frames) * scenario.cycles * 4 * shaderCount;
const testTimeout =
  scenario.experiment === "cadence"
    ? Math.max(120_000, cadenceDurationMs * 2 + 60_000)
    : Math.max(
        120_000,
        (scenario.experiment === "baselines"
          ? baselineFrameCount
          : scenario.experiment === "abba"
            ? abbaFrameCount
            : pipelineFrameCount) * 100,
      );
const runnerByExperiment = {
  pipeline: "src/features/editor/zen/ZenShaderResearchRunner.browser.test.tsx",
  cadence:
    "src/features/editor/zen/ZenShaderCadenceResearchRunner.browser.test.tsx",
  baselines:
    "src/features/editor/zen/ZenShaderBaselineResearchRunner.browser.test.tsx",
  abba: "src/features/editor/zen/ZenShaderAbbaResearchRunner.browser.test.tsx",
} as const;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    researchArtifactWriter(outputPath, writeToken),
  ],
  define: {
    __ZEN_SHADER_RESEARCH_SCENARIO__: JSON.stringify(scenario),
    __ZEN_SHADER_RESEARCH_REPORT_ENDPOINT__: JSON.stringify(REPORT_ENDPOINT),
    __ZEN_SHADER_RESEARCH_WRITE_TOKEN__: JSON.stringify(writeToken),
  },
  resolve: { alias },
  optimizeDeps: {
    include: ["@tanstack/react-virtual"],
  },
  server: {
    strictPort: true,
    fs: {
      allow: [...new Set([searchForWorkspaceRoot(__dirname), dependencyRoot])],
    },
  },
  test: {
    name: "zen-shader-research",
    globals: true,
    maxWorkers: 1,
    testTimeout,
    browser: {
      enabled: true,
      ui: false,
      api: { host: "127.0.0.1", port: 45125 },
      connectTimeout: 180_000,
      fileParallelism: false,
      provider: playwright({
        launchOptions: { channel: "chromium", args: launchArguments },
        contextOptions: {
          viewport: { width: scenario.width, height: scenario.height },
          deviceScaleFactor: 1,
        },
      }),
      headless: !scenario.headed,
      instances: [{ browser: "chromium" }],
    },
    setupFiles: ["./src/test-setup-browser.ts"],
    include: [runnerByExperiment[scenario.experiment]],
  },
});
