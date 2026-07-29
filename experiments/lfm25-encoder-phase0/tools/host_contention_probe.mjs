#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import process from "node:process";

function parseArguments(argv) {
  const result = { output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      result.config = argv[++index];
    } else if (argument === "--output") {
      result.output = argv[++index];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!result.config) {
    throw new Error("--config is required");
  }
  return result;
}

function percentileNanoseconds(histogram, percentile) {
  return histogram.percentile(percentile) / 1_000_000;
}

async function measureEventLoop(durationSeconds, childCommand = null) {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  let child = null;
  let childOutput = "";
  let childError = "";
  let childExit = null;

  if (childCommand) {
    child = spawn(childCommand[0], childCommand.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      childError += chunk;
    });
    child.stdout.setEncoding("utf8");
    childExit = new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => {
        resolveExit(code);
      });
    });
    await new Promise((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        rejectReady(new Error("encoder contention child did not become ready"));
      }, 180_000);
      child.once("error", rejectReady);
      child.stdout.on("data", (chunk) => {
        childOutput += chunk;
        if (childOutput.includes("READY\n")) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
      child.once("exit", (code) => {
        if (!childOutput.includes("READY\n")) {
          clearTimeout(timeout);
          rejectReady(
            new Error(
              `encoder contention child exited early (${code}): ${childError}`,
            ),
          );
        }
      });
    });
  }

  const utilizationBefore = performance.eventLoopUtilization();
  histogram.enable();
  await new Promise((resolveTimer) => {
    setTimeout(resolveTimer, durationSeconds * 1000);
  });
  histogram.disable();
  const utilization = performance.eventLoopUtilization(utilizationBefore);

  if (child) {
    const exitCode = await childExit;
    if (exitCode !== 0) {
      throw new Error(
        `encoder contention child failed (${exitCode}): ${childError}`,
      );
    }
  }

  return {
    p50Ms: percentileNanoseconds(histogram, 50),
    p95Ms: percentileNanoseconds(histogram, 95),
    maxMs: histogram.max / 1_000_000,
    eventLoopUtilization: utilization.utilization,
    encoderOutput: childOutput.trim() || null,
  };
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const configPath = resolve(arguments_.config);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const contention = config.contention;
  if (!contention || !Array.isArray(contention.encoder_command)) {
    throw new Error("contention.encoder_command is required");
  }
  const durationSeconds = Number(contention.duration_seconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("contention.duration_seconds must be positive");
  }

  const baseline = await measureEventLoop(durationSeconds);
  const underContention = await measureEventLoop(
    durationSeconds,
    contention.encoder_command.map(String),
  );
  const report = {
    schemaVersion: 1,
    durationSeconds,
    baseline,
    contention: underContention,
    delta: {
      p50Ms: underContention.p50Ms - baseline.p50Ms,
      p95Ms: underContention.p95Ms - baseline.p95Ms,
      maxMs: underContention.maxMs - baseline.maxMs,
      eventLoopUtilization:
        underContention.eventLoopUtilization -
        baseline.eventLoopUtilization,
    },
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (arguments_.output) {
    const outputPath = resolve(arguments_.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, encoded, "utf8");
  }
  process.stdout.write(encoded);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
