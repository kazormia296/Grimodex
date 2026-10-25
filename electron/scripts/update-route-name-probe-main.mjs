/**
 * H1 (b) の Electron main（CP-2b P3）。`update-route-name-probe.mjs` が esbuild で束ねて、
 * `scripts/local-ci-xvfb.mjs` 経由の非 packaged の Electron で起動する。
 *
 * - `PROBE_MODE=product`: 製品の NC-1 の module（`createRendererContainment()` の既定の
 *   deps）の起動手順 (0) `appendResolverSwitch()`、(1) `registerWebContentsPolicy()`、
 *   ready の後の (2)〜(4) `start()` をそのまま通す。
 * - `PROBE_MODE=mapped-control`: 規則が原因であることの対照。製品の
 *   `buildHostResolverRules(prefixRules)`（`prefixRules` は試験用の既存の引数）の先頭に
 *   RS-1 外の名前を loopback へ写す MAP を 1 つ置き、それだけを当てる。
 *
 * 更新の要求は electron-updater 本体の `ElectronHttpExecutor`（partition
 * `electron-updater` の session の `net.request`）で出す。要求先は loopback の模擬
 * server だけで、server は 302 で RS-1 外の名前（`github-releases.githubusercontent.com`。
 * K3/3:356）か loopback へ向ける。製品の file も既存の probe も変えない。
 * 判断の記録: `docs/plans/nir1-lane-decisions/cp2b-decisions.md` の DR-CP2B-P3-6。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { app, session } from "electron";
import { CancellationToken } from "electron-updater";
import {
  ElectronHttpExecutor,
  NET_SESSION_NAME,
} from "electron-updater/out/electronHttpExecutor.js";

import { buildHostResolverRules } from "../main/rendererContainment.ts";
import { createRendererContainment } from "../main/rendererContainmentStartup.ts";

export const OUTSIDE_RS1_NAME = "github-releases.githubusercontent.com";
const CASE_TIMEOUT_MS = 15_000;

const mode = process.env.PROBE_MODE;
const resultPath = process.env.PROBE_RESULT;
const work = process.env.PROBE_WORK;

const result = {
  mode,
  containmentStarted: null,
  appliedRules: null,
  cases: [],
  resolveHost: null,
  serverHits: [],
};

function writeResult() {
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
}

app.setPath("userData", path.join(work, "userData"));

let containment = null;
if (mode === "product") {
  containment = createRendererContainment();
  containment.appendResolverSwitch();
  containment.registerWebContentsPolicy();
  result.appliedRules = "product";
} else if (mode === "mapped-control") {
  app.commandLine.appendSwitch(
    "host-resolver-rules",
    buildHostResolverRules([`MAP ${OUTSIDE_RS1_NAME} 127.0.0.1`]),
  );
  result.appliedRules = "mapped-control";
} else {
  result.cases.push({ id: "mode", outcome: "error", message: "unknown mode" });
  writeResult();
  app.exit(2);
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      result.serverHits.push({
        path: request.url,
        host: request.headers.host ?? null,
      });
      const port = server.address().port;
      if (request.url === "/outside") {
        response.writeHead(302, {
          location: `http://${OUTSIDE_RS1_NAME}:${port}/final`,
        });
        response.end();
      } else if (request.url === "/loopback") {
        response.writeHead(302, { location: `http://127.0.0.1:${port}/final` });
        response.end();
      } else if (request.url === "/final") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("final");
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function runCase(id, operation) {
  const startedAt = Date.now();
  let timer;
  try {
    const value = await Promise.race([
      operation(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("probe-timeout")),
          CASE_TIMEOUT_MS,
        );
      }),
    ]);
    result.cases.push({
      id,
      outcome: "ok",
      value: typeof value === "string" ? value : null,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    result.cases.push({
      id,
      outcome: "error",
      message: String(error?.message ?? error),
      ms: Date.now() - startedAt,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  await app.whenReady();
  if (containment) result.containmentStarted = await containment.start();
  const server = await startServer();
  const port = server.address().port;
  const executor = new ElectronHttpExecutor();

  // 更新の確認の形（`HttpExecutor.request`。redirect は net の既定で辿る）。
  for (const route of ["loopback", "outside"]) {
    await runCase(`request.${route}`, () =>
      executor.request(
        { protocol: "http:", hostname: "127.0.0.1", port, path: `/${route}` },
        new CancellationToken(),
      ),
    );
  }
  // asset の取得の形（`ElectronHttpExecutor.download`。`redirect: "manual"` で作り直す）。
  for (const route of ["loopback", "outside"]) {
    await runCase(`download.${route}`, async () => {
      const destination = path.join(work, `download-${route}.txt`);
      await executor.download(
        new URL(`http://127.0.0.1:${port}/${route}`),
        destination,
        { cancellationToken: new CancellationToken(), headers: {} },
      );
      return fs.readFileSync(destination, "utf8");
    });
  }

  const updaterSession = session.fromPartition(NET_SESSION_NAME, {
    cache: false,
  });
  try {
    const resolved = await updaterSession.resolveHost(OUTSIDE_RS1_NAME);
    result.resolveHost = {
      outcome: "ok",
      addresses: resolved.endpoints.map((endpoint) => endpoint.address),
    };
  } catch (error) {
    result.resolveHost = {
      outcome: "error",
      message: String(error?.message ?? error),
    };
  }

  await new Promise((resolve) => server.close(resolve));
  writeResult();
  app.quit();
}

main().catch((error) => {
  result.cases.push({
    id: "main",
    outcome: "error",
    message: String(error?.message ?? error),
  });
  writeResult();
  app.exit(1);
});
