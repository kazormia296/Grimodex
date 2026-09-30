/// <reference types="vitest/config" />
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";

const REPORT_ENDPOINT = "/__zen-blur-research-report";
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

interface ZenBlurResearchScenarioEnvironment {
  blur: number;
  width: number;
  height: number;
  warmup: number;
  frames: number;
  runs: number;
  primeRuns: number;
  timing: "pass-breakdown" | "frame" | "blur";
  headed: boolean;
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

function parseScenario() {
  const serialized = process.env.GRIMODEX_ZEN_BLUR_RESEARCH_SCENARIO;
  if (!serialized) {
    throw new Error("GRIMODEX_ZEN_BLUR_RESEARCH_SCENARIO is required");
  }
  return JSON.parse(serialized) as ZenBlurResearchScenarioEnvironment;
}

function researchArtifactWriter(
  outputPath: string,
  writeToken: string,
): Plugin {
  let artifactState: "idle" | "writing" | "written" = "idle";
  return {
    name: "grimodex-zen-blur-research-artifact",
    configureServer(server) {
      server.middlewares.use(REPORT_ENDPOINT, (request, response, next) => {
        if (request.method !== "POST") {
          next();
          return;
        }
        if (
          artifactState !== "idle" ||
          request.headers["x-zen-blur-research-token"] !== writeToken ||
          !request.headers["content-type"]?.startsWith("application/json")
        ) {
          response.statusCode = artifactState !== "idle" ? 409 : 403;
          response.end("Zen blur research artifact write rejected");
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
              response.end("Zen blur research report is too large");
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
              // Verify that the durable artifact can be read and parsed before
              // allowing the browser benchmark to report success.
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

const scenario = { ...parseScenario(), ...readSourceIdentity() };
const outputPath = process.env.GRIMODEX_ZEN_BLUR_RESEARCH_OUTPUT;
if (!outputPath) {
  throw new Error("GRIMODEX_ZEN_BLUR_RESEARCH_OUTPUT is required");
}
const writeToken = process.env.GRIMODEX_ZEN_BLUR_RESEARCH_WRITE_TOKEN;
if (!writeToken) {
  throw new Error("GRIMODEX_ZEN_BLUR_RESEARCH_WRITE_TOKEN is required");
}

const alias = { "@": path.resolve(__dirname, "./src") };
const dependencyRoot = realpathSync(path.resolve(__dirname, "node_modules"));
const launchArguments = [
  ...(process.platform === "win32" ? ["--use-angle=d3d11"] : []),
  "--disable-software-rasterizer",
];
const expectedFrameCount =
  (scenario.warmup + scenario.frames) * (scenario.primeRuns + scenario.runs);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    researchArtifactWriter(outputPath, writeToken),
  ],
  define: {
    __ZEN_BLUR_RESEARCH_SCENARIO__: JSON.stringify(scenario),
    __ZEN_BLUR_RESEARCH_REPORT_ENDPOINT__: JSON.stringify(REPORT_ENDPOINT),
    __ZEN_BLUR_RESEARCH_WRITE_TOKEN__: JSON.stringify(writeToken),
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
    name: "zen-blur-research",
    globals: true,
    maxWorkers: 1,
    testTimeout: Math.max(120_000, expectedFrameCount * 100),
    browser: {
      enabled: true,
      api: { host: "127.0.0.1", port: 45124 },
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
    include: ["src/features/editor/zen/ZenBlurResearchRunner.browser.test.tsx"],
  },
});
