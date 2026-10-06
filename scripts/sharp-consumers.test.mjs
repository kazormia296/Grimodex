import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "vite";
import { imagetools } from "vite-imagetools";

const require = createRequire(import.meta.url);
const imageRequire = createRequire(require.resolve("vite-imagetools"));
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare"));
const sharp = imageRequire("sharp");
const { Miniflare } = wranglerRequire("miniflare");

function patchedConsumers() {
  assert.equal(sharp.versions.sharp, "0.35.5");
  assert.equal(miniflareRequire("sharp").versions.sharp, "0.35.5");
}

async function syntheticPng() {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: "#4080c0" },
  }).png().toBuffer();
}

test("LP imagetools builds real AVIF/WebP/PNG picture variants and rejects invalid input", async () => {
  patchedConsumers();
  const root = await mkdtemp(path.join(tmpdir(), "grimodex-imagetools-"));
  try {
    await writeFile(path.join(root, "image.png"), await syntheticPng());
    await writeFile(path.join(root, "entry.js"),
      'export { default } from "./image.png?w=4;8&format=avif;webp;png&as=picture";\n');
    const options = {
      root, configFile: false, publicDir: false, logLevel: "silent",
      plugins: [imagetools({ cache: { dir: path.join(root, "cache") } })],
      build: {
        write: false, minify: false,
        lib: { entry: path.join(root, "entry.js"), formats: ["es"] },
      },
    };
    const results = await build(options);
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const [result] = results;
    const assets = result.output.filter(({ type }) => type === "asset");
    assert.equal(assets.length, 6);
    const dimensions = [];
    for (const asset of assets) {
      const metadata = await sharp(asset.source).metadata();
      const format = metadata.compression === "av1" ? "avif" : metadata.format;
      assert.equal(metadata.width, metadata.height);
      dimensions.push(`${format}:${metadata.width}`);
    }
    assert.deepEqual(dimensions.sort(), ["avif:4", "avif:8", "png:4", "png:8", "webp:4", "webp:8"]);
    const chunk = result.output.find(({ type }) => type === "chunk");
    const picture = (await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`)).default;
    assert.ok(picture.sources.avif);
    assert.ok(picture.sources.webp);
    assert.equal(picture.img.w, 8);
    assert.equal(picture.img.h, 8);

    await writeFile(path.join(root, "bad.png"), "not an image");
    await writeFile(path.join(root, "entry.js"),
      'export { default } from "./bad.png?w=4&format=webp&as=picture";\n');
    await assert.rejects(build(options));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Wrangler's Miniflare Images binding transforms locally and rejects unsupported/malformed images", async () => {
  patchedConsumers();
  // Inspector bootloaders can spawn detached watchdogs; never admit them here.
  for (const name of ["VSCODE_INSPECTOR_OPTIONS", "MINIFLARE_WORKERD_PATH", "NODE_OPTIONS"]) {
    assert.equal(process.env[name], undefined, `${name} override is not admitted`);
  }
  const mf = new Miniflare({
    host: "127.0.0.1", port: 0, modules: true,
    compatibilityDate: "2025-04-01",
    images: { binding: "IMAGES" },
    outboundService: () => { throw new Error("External fetch is not admitted"); },
    script: `export default {
      async fetch(request, env) {
        try {
          const url = new URL(request.url);
          if (url.pathname === "/info") return Response.json(await env.IMAGES.info(request.body));
          const output = await env.IMAGES.input(request.body)
            .transform({ width: 4, height: 4, fit: "cover" })
            .output({ format: url.searchParams.get("format") || "image/webp" });
          return output.response();
        } catch { return new Response("Invalid image", { status: 422 }); }
      }
    };`,
  });
  try {
    const png = await syntheticPng();
    const info = await mf.dispatchFetch("http://localhost/info", { method: "POST", body: png });
    assert.equal(info.status, 200);
    const metadata = await info.json();
    assert.equal(metadata.format, "image/png");
    assert.equal(metadata.width, 8);
    assert.equal(metadata.height, 8);
    for (const format of ["avif", "webp", "png"]) {
      const response = await mf.dispatchFetch(`http://localhost/image?format=image/${format}`, { method: "POST", body: png });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), `image/${format}`);
      const output = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      assert.equal(output.width, 4);
      assert.equal(output.height, 4);
      assert.equal(output.compression === "av1" ? "avif" : output.format, format);
    }
    for (const [url, body] of [["http://localhost/image?format=image/gif", png], ["http://localhost/image", "not an image"]]) {
      const response = await mf.dispatchFetch(url, { method: "POST", body });
      assert.equal(response.status, 422);
      assert.equal(await response.text(), "Invalid image");
    }
  } finally {
    await mf.dispose();
  }
});
