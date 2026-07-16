import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const appRoot = new URL("../", import.meta.url);
const indexPath = new URL("dist/index.html", appRoot);
const serviceWorkerPath = new URL("dist/sw.js", appRoot);
const placeholder = "__GRIMODEX_SCAN_BUILD__";
const indexHtml = await readFile(indexPath, "utf8");
const buildId = createHash("sha256")
  .update(indexHtml)
  .digest("hex")
  .slice(0, 20);
const serviceWorker = await readFile(serviceWorkerPath, "utf8");
if (!serviceWorker.includes(placeholder)) {
  throw new Error("Scan service worker build placeholder is missing");
}
await writeFile(
  serviceWorkerPath,
  serviceWorker.replaceAll(placeholder, buildId),
  "utf8",
);
