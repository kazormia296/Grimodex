/* global window */
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadContract,
  scoreQuery,
  sha256,
  summarizeQuality,
  summarizeWarm,
  validateWarmPopulation,
  validateRawIpcTrace,
} from "./nir1-retrieval/contract.mjs";
import { runPaired } from "./nir1-retrieval/paired.mjs";
import {
  loadCandidatePolicy,
  POLICY_PATH,
  CANDIDATE_PATH,
} from "./nir1-retrieval/candidate-policy.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

function parseArgs(args) {
  const options = {
    mode: "raw",
    "ja-model": process.env.NIR1_JA_MODEL,
    "en-model": process.env.NIR1_EN_MODEL,
    "build-receipt": process.env.NIR1_BUILD_RECEIPT,
    output: path.join(
      ROOT,
      ".artifacts/nir1-retrieval",
      new Date().toISOString().replaceAll(":", "-"),
    ),
  };
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      args[i].startsWith("--") && args[i + 1],
      "use --name value arguments",
    );
    options[args[i].slice(2)] = args[i + 1];
  }
  assert.ok(["raw", "compare", "precheck"].includes(options.mode));
  return options;
}

async function readMaybe(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function snapshotHost() {
  return {
    timestamp: new Date().toISOString(),
    os: os.type(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadAverage: os.loadavg(),
    cpuUsage: process.cpuUsage(),
    node: process.version,
    processIo: await readMaybe(`/proc/${process.pid}/io`),
    cpuPressure: await readMaybe("/proc/pressure/cpu"),
    ioPressure: await readMaybe("/proc/pressure/io"),
    memoryPressure: await readMaybe("/proc/pressure/memory"),
    diskstats: await readMaybe("/proc/diskstats"),
  };
}

async function modelPrecheck(manifest, options) {
  const result = {};
  for (const language of ["ja", "en"]) {
    const spec = manifest.models[language];
    const modelFile = options[`${language}-model`];
    assert.ok(
      modelFile,
      `[precheck] --${language}-model must name the pinned local model artifact`,
    );
    const tokenizerFile = path.join(
      ROOT,
      "src-tauri/resources/semantic",
      spec.directory,
      "tokenizer.json",
    );
    const modelBytes = await readFile(path.resolve(modelFile));
    const tokenizerBytes = await readFile(tokenizerFile);
    assert.equal(
      sha256(modelBytes),
      spec.artifactSha256,
      `[precheck] ${language} model SHA mismatch`,
    );
    assert.equal(
      sha256(tokenizerBytes),
      spec.tokenizerSha256,
      `[precheck] ${language} tokenizer SHA mismatch`,
    );
    result[language] = {
      sourcePath: path.resolve(modelFile),
      tokenizerPath: tokenizerFile,
      modelSha256: sha256(modelBytes),
      tokenizerSha256: sha256(tokenizerBytes),
      modelSize: modelBytes.length,
    };
  }
  return result;
}

async function artifactIdentity(file) {
  const bytes = await readFile(file);
  return { path: file, sha256: sha256(bytes), bytes: (await stat(file)).size };
}

export async function runNir1Retrieval(options) {
  const output = path.resolve(options.output);
  await mkdir(output, { recursive: true });
  const receipt = {
    schemaVersion: "nir1-raw-baseline/1",
    status: "blocked",
    evidenceScope:
      "actual Electron Raw retrieval baseline; no IR, author-value or product-journey acceptance",
    startedAt: new Date().toISOString(),
    hostBefore: await snapshotHost(),
    cases: [],
    warmCalls: [],
    buildTrials: [],
    errors: [],
  };
  let app;
  let vite;
  let verifiedBuildSources;
  let built;
  try {
    if (options["build-receipt"]) {
      receipt.buildReceipt = await artifactIdentity(
        path.resolve(options["build-receipt"]),
      );
      built = JSON.parse(await readFile(receipt.buildReceipt.path, "utf8"));
      assert.equal(
        built.status,
        "passed",
        "[precheck] build receipt status must be passed",
      );
      assert.equal(
        built.standardBuild,
        true,
        "[precheck] authoritative standard build is required",
      );
      assert.equal(
        built.schemaVersion,
        "nir1-standard-build/1",
        "[precheck] unsupported standard-build receipt schema",
      );
      assert.equal(
        built.sourceUnchanged,
        true,
        "[precheck] standard build did not keep source identity",
      );
    } else if (options.mode !== "precheck") {
      throw new Error(
        "[precheck] --build-receipt is required to bind standard main/preload/native artifacts",
      );
    }
    const contract = await loadContract(ROOT, {
      requireFreeze: options.mode !== "precheck",
    });
    receipt.contract = contract.digests;
    if (options.mode === "compare") {
      receipt.rankingCandidate = await loadCandidatePolicy(
        ROOT,
        contract.digests,
      );
    }
    receipt.candidate = {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim(),
      tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim(),
      trackedDiffSha256: sha256(
        execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: ROOT }),
      ),
      status: execFileSync("git", ["status", "--porcelain=v1"], {
        cwd: ROOT,
        encoding: "utf8",
      }),
    };
    receipt.models = await modelPrecheck(contract.manifest, options);
    const main = path.resolve(
      options.main ?? path.join(ROOT, "dist-electron/main.cjs"),
    );
    const native = path.resolve(
      options.native ??
        path.join(ROOT, "electron/native/grimodex-node/grimodex-node.node"),
    );
    receipt.artifacts = {
      main: await artifactIdentity(main),
      preload: await artifactIdentity(
        path.join(path.dirname(main), "preload.cjs"),
      ),
      native: await artifactIdentity(native),
      runner: await artifactIdentity(
        path.join(ROOT, "scripts/quality/run-nir1-retrieval.mjs"),
      ),
      renderer: await artifactIdentity(
        path.join(ROOT, "scripts/quality/nir1-retrieval/renderer.ts"),
      ),
    };
    const rawSources = [
      "src/features/related-scenes/fetchRelatedScenes.ts",
      "src/features/related-scenes/selectRelatedScenes.ts",
      "src/features/related-scenes/seedTerms.ts",
      "src/features/chat/semanticRecall.ts",
      "src/features/semantic-search/api.ts",
      "src/lib/tauri.ts",
      "src-tauri/crates/grimodex-semantic/src/runtime.rs",
      "src-tauri/crates/grimodex-semantic/src/spec.rs",
      "src-tauri/crates/grimodex-semantic/src/search.rs",
      "src-tauri/crates/grimodex-semantic/src/index.rs",
      "src-tauri/crates/grimodex-semantic/src/embedding.rs",
    ];
    receipt.rawSourceArtifacts = await Promise.all(
      rawSources.map((file) => artifactIdentity(path.join(ROOT, file))),
    );
    if (built) {
      if (options.mode === "compare") {
        const sourceBytes = await readFile(built.sourceManifest);
        assert.equal(
          sha256(sourceBytes),
          built.sourceManifestSha256,
          "[precheck] build source manifest changed",
        );
        verifiedBuildSources = JSON.parse(sourceBytes);
        for (const file of [POLICY_PATH, CANDIDATE_PATH])
          assert.ok(
            verifiedBuildSources[file],
            `[precheck] build omitted ranking policy: ${file}`,
          );
        for (const [file, digest] of Object.entries(verifiedBuildSources))
          assert.equal(
            sha256(await readFile(path.join(ROOT, file))),
            digest,
            `[precheck] source changed since build: ${file}`,
          );
        receipt.buildSourceManifest = {
          path: built.sourceManifest,
          sha256: built.sourceManifestSha256,
        };
      }
      for (const artifact of [
        receipt.artifacts.main,
        receipt.artifacts.preload,
        receipt.artifacts.native,
      ]) {
        assert.equal(
          built.artifacts[path.relative(ROOT, artifact.path)],
          artifact.sha256,
          "[precheck] standard build artifact changed",
        );
      }
    }
    if (options.mode === "precheck") {
      receipt.status = "precheck-complete";
      return receipt;
    }
    const userData = path.join(output, "user-data");
    await mkdir(userData, { recursive: true });
    for (const language of ["ja", "en"]) {
      const destination = path.join(
        userData,
        "models",
        contract.manifest.models[language].directory,
      );
      await mkdir(destination, { recursive: true });
      await cp(
        receipt.models[language].sourcePath,
        path.join(destination, "model_int8.onnx"),
      );
      await cp(
        receipt.models[language].tokenizerPath,
        path.join(destination, "tokenizer.json"),
      );
      assert.equal(
        sha256(await readFile(path.join(destination, "model_int8.onnx"))),
        receipt.models[language].modelSha256,
      );
      // The production downloaded-model resolver requires its verified sidecar.
      await writeFile(
        path.join(destination, "model_int8.onnx.sha256"),
        receipt.models[language].modelSha256,
      );
    }
    // This isolated evaluation profile must never import the user's legacy keys.
    await writeFile(
      path.join(userData, "legacy-keyring-migration-v1.json"),
      JSON.stringify({
        version: 1,
        completedAt: new Date().toISOString(),
        imported: 0,
        skippedExisting: 0,
        fixtureOnly: true,
      }),
    );
    await writeFile(
      path.join(userData, "global-settings.json"),
      JSON.stringify({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        uiLanguage: "en",
        uiScale: 100,
        showLauncherOnStartup: false,
        userPreferences: { "data.autoBackup": "false" },
      }),
    );
    const { createServer } = await import("vite");
    vite = await createServer({
      root: ROOT,
      cacheDir: path.join(output, "vite-cache"),
      server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
      clearScreen: false,
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const rendererUrl = `http://127.0.0.1:${address.port}/evals/nir1-retrieval/renderer.html`;
    const { _electron } = await import("playwright");
    const observer = path.join(
      ROOT,
      "scripts/quality/nir1-retrieval/electron-observer.mjs",
    );
    receipt.artifacts.observer = await artifactIdentity(observer);
    const env = {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
      GRIMODEX_USER_DATA_DIR: userData,
      GRIMODEX_NODE_PATH: native,
      GRIMODEX_NIR1_PRODUCTION_MAIN: main,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [observer],
      cwd: ROOT,
      env,
      timeout: 60000,
    });
    receipt.electronPid = app.process().pid;
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => window.nir1Evaluation?.ready === true,
      null,
      { timeout: 120000 },
    );
    receipt.electronVersion = await app.evaluate(
      () => process.versions.electron,
    );
    if (options.mode === "compare")
      return await runPaired({
        app,
        page,
        contract,
        options,
        output,
        receipt,
        snapshotHost,
      });
    const measure = async () => {
      await app.evaluate(() => {
        globalThis.nir1IpcTrace.calls = [];
      });
      const sample = await page.evaluate(() =>
        window.nir1Evaluation.measureRaw(),
      );
      sample.ipc = await app.evaluate(() => globalThis.nir1IpcTrace.calls);
      try {
        validateRawIpcTrace(sample.ipc);
      } catch (error) {
        sample.status = "failed";
        sample.failures.push({ tag: "ipc-observer", message: error.message });
      }
      return sample;
    };
    for (const query of contract.queries) {
      const section = contract.corpus.languages[query.language];
      const workspacePath = path.join(output, "workspaces", query.id);
      const prepared = await page.evaluate(
        (input) => window.nir1Evaluation.prepare(input),
        {
          workspacePath,
          projectId: `nir1-${query.id}`,
          language: query.language,
          scenes: section.scenes,
          query,
        },
      );
      const build = await page.evaluate(() => window.nir1Evaluation.buildRaw());
      for (let repeat = 0; repeat < 5; repeat++) {
        const warmup = await measure();
        assert.equal(
          warmup.status,
          "ok",
          `[precheck] warmup failed for ${query.id}`,
        );
      }
      let firstResults;
      for (let repeat = 0; repeat < 30; repeat++) {
        const sample = await measure();
        receipt.warmCalls.push({
          queryId: query.id,
          language: query.language,
          task: query.task,
          arm: "raw",
          phase: "measured",
          repeat,
          ...sample,
        });
        if (sample.status === "ok") {
          if (!firstResults) firstResults = sample.results;
          else
            assert.deepEqual(
              sample.results,
              firstResults,
              `[artifact] non-deterministic Raw results for ${query.id}`,
            );
        }
      }
      const results = firstResults ?? [];
      receipt.cases.push({
        queryId: query.id,
        language: query.language,
        task: query.task,
        prepared,
        build,
        results,
        metrics: scoreQuery(query, results),
      });
      receipt.hostDuring ??= [];
      receipt.hostDuring.push({
        queryId: query.id,
        ...(await snapshotHost()),
        electronIo: await readMaybe(`/proc/${app.process().pid}/io`),
      });
      await writeFile(
        path.join(output, "receipt.in-progress.json"),
        JSON.stringify(receipt, null, 2),
      );
      process.stdout.write(
        `nir1 Raw ${receipt.cases.length}/24: ${query.id}\n`,
      );
    }
    // Five independent fresh-DB corpus pairs (ja + en) fix one comparable T.
    for (let trial = 0; trial < 5; trial++) {
      const pair = [];
      for (const language of ["ja", "en"]) {
        const query = contract.queries.find((q) => q.language === language);
        await page.evaluate((input) => window.nir1Evaluation.prepare(input), {
          workspacePath: path.join(
            output,
            "cold-build",
            `${trial}-${language}`,
          ),
          projectId: `nir1-build-${trial}-${language}`,
          language,
          scenes: contract.corpus.languages[language].scenes,
          query,
        });
        pair.push({
          language,
          ...(await page.evaluate(() => window.nir1Evaluation.buildRaw())),
        });
      }
      receipt.buildTrials.push({
        trial,
        durationMs: pair.reduce((sum, arm) => sum + arm.durationMs, 0),
        languages: pair,
      });
    }
    receipt.quality = summarizeQuality(receipt.cases);
    validateWarmPopulation(
      receipt.warmCalls,
      contract.queries.map((query) => query.id),
    );
    assert.deepEqual(
      await Promise.all(
        rawSources.map((file) => artifactIdentity(path.join(ROOT, file))),
      ),
      receipt.rawSourceArtifacts,
      "[artifact] Raw sources changed during baseline",
    );
    receipt.warm = summarizeWarm(receipt.warmCalls);
    receipt.budgets = {
      B: receipt.warm.B,
      D: receipt.warm.D,
      T: receipt.buildTrials
        .map((trial) => trial.durationMs)
        .sort((a, b) => a - b)[2],
    };
    receipt.status =
      receipt.warm.status === "complete" ? "baseline-complete" : "blocked";
    return receipt;
  } catch (error) {
    receipt.errors.push(error instanceof Error ? error.message : String(error));
    return receipt;
  } finally {
    if (app)
      await app.close().catch((error) => {
        receipt.status = "blocked";
        receipt.errors.push(`Electron close: ${error.message}`);
      });
    if (vite) await vite.close();
    if (verifiedBuildSources) {
      const changed = [];
      for (const [file, digest] of Object.entries(verifiedBuildSources)) {
        try {
          if (sha256(await readFile(path.join(ROOT, file))) !== digest)
            changed.push(file);
        } catch {
          changed.push(file);
        }
      }
      receipt.sourcesUnchangedDuringRun = changed.length === 0;
      if (changed.length) {
        receipt.status = "blocked";
        receipt.errors.push(
          `sources changed during run: ${changed.join(", ")}`,
        );
      }
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.hostAfter = await snapshotHost();
    await writeFile(
      path.join(output, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const options = parseArgs(process.argv.slice(2));
  const receipt = await runNir1Retrieval(options);
  console.log(
    JSON.stringify({
      status: receipt.status,
      output: path.resolve(options.output),
      errors: receipt.errors,
      budgets: receipt.budgets,
    }),
  );
  if (receipt.status === "blocked") process.exitCode = 1;
}
