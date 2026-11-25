/** Shared golden values were sampled from the renderer's real tokenizer. */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: readFileMock };
});

interface GoldenCase {
  readonly name: string;
  readonly text: string;
  readonly repeat?: number;
  readonly count?: number;
  readonly error?: string;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const golden = JSON.parse(
  readFileSync(
    new URL(
      "../../../src/features/chat/__fixtures__/o200kTokenizer.golden.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { cases: GoldenCase[] };
const assets = {
  ranksPath: path.join(repoRoot, "injected", "o200k_base.json"),
  wasmPath: path.join(repoRoot, "injected", "tiktoken_bg.wasm"),
};
const ranksPath = path.join(
  repoRoot,
  "node_modules",
  "tiktoken",
  "encoders",
  "o200k_base.json",
);
const wasmPath = path.join(
  repoRoot,
  "node_modules",
  "tiktoken",
  "lite",
  "tiktoken_bg.wasm",
);

afterEach(() => readFileMock.mockReset());

describe("Electron main o200k_base tokenizer", () => {
  it("does not read assets on module import or construction and resolves runtime paths", async () => {
    const module = await import("./o200kTokenizer.js");
    expect(readFileMock).not.toHaveBeenCalled();

    const tokenizer = module.createMainO200kTokenizer(assets);
    expect(tokenizer.kind).toBe("o200k_base");
    expect(readFileMock).not.toHaveBeenCalled();

    const development = module.resolveMainTokenizerAssetPaths({
      isPackaged: false,
      resourcesPath: "/unused",
      mainDir: path.join(repoRoot, "dist-electron"),
    });
    expect(development).toEqual({ ranksPath, wasmPath });
    expect(statSync(development.ranksPath).isFile()).toBe(true);
    expect(statSync(development.wasmPath).isFile()).toBe(true);

    // Expectations are built with path.join: the paths are platform paths (Windows CI).
    const resourcesPath = path.join("/app", "Contents", "Resources");
    const tokenizerDir = path.join(resourcesPath, "resources", "tokenizer");
    expect(
      module.resolveMainTokenizerAssetPaths({
        isPackaged: true,
        resourcesPath,
        mainDir: "/unused",
      }),
    ).toEqual({
      ranksPath: path.join(tokenizerDir, "o200k_base.json"),
      wasmPath: path.join(tokenizerDir, "tiktoken_bg.wasm"),
    });
  });

  it("retries missing, malformed JSON, and malformed WASM, then shares one successful load", async () => {
    const { createMainO200kTokenizer, MAIN_TOKENIZER_NOT_READY } =
      await import("./o200kTokenizer.js");
    const tokenizer = createMainO200kTokenizer(assets);
    let mode: "missing" | "json" | "wasm" | "good" = "missing";
    const reads: string[] = [];
    readFileMock.mockImplementation(async (filePath: string) => {
      reads.push(filePath);
      if (mode === "missing") {
        throw Object.assign(new Error("missing tokenizer asset"), {
          code: "ENOENT",
        });
      }
      if (mode === "json" && filePath === assets.ranksPath)
        return Buffer.from("{");
      if (mode === "wasm" && filePath === assets.wasmPath)
        return Buffer.from("not wasm");
      return readFileSync(filePath === assets.ranksPath ? ranksPath : wasmPath);
    });

    expect(tokenizer.kind).toBe("o200k_base");
    expect(() => tokenizer.countTokens("before ready")).toThrow(
      MAIN_TOKENIZER_NOT_READY,
    );
    expect(() => tokenizer.countTokens("")).toThrow(MAIN_TOKENIZER_NOT_READY);

    for (const failure of ["missing", "json", "wasm"] as const) {
      mode = failure;
      await expect(tokenizer.ensureReady()).rejects.toThrow();
      expect(() => tokenizer.countTokens("after failure")).toThrow(
        MAIN_TOKENIZER_NOT_READY,
      );
      reads.length = 0;
    }

    mode = "good";
    readFileMock.mockClear();
    await Promise.all(Array.from({ length: 5 }, () => tokenizer.ensureReady()));
    expect(reads).toEqual([assets.ranksPath, assets.wasmPath]);
    expect(readFileMock).toHaveBeenCalledTimes(2);
    await expect(tokenizer.ensureReady()).resolves.toBeUndefined();
    expect(readFileMock).toHaveBeenCalledTimes(2);

    for (const { text, repeat, count, error } of golden.cases) {
      const input = text.repeat(repeat ?? 1);
      if (error) {
        expect(() => tokenizer.countTokens(input)).toThrow(error);
      } else {
        expect(tokenizer.countTokens(input)).toBe(count);
      }
    }
  });

  it("resolves paths lazily inside ensureReady: a resolver that throws is a rejection (not a startup error) and is retried", async () => {
    const { createMainO200kTokenizer, MAIN_TOKENIZER_NOT_READY } =
      await import("./o200kTokenizer.js");
    let resolverFails = true;
    const resolver = vi.fn(() => {
      if (resolverFails) throw new Error("resourcesPath is missing");
      return assets;
    });
    readFileMock.mockImplementation(async (filePath: string) =>
      readFileSync(filePath === assets.ranksPath ? ranksPath : wasmPath),
    );

    // Construction does not call the resolver: nothing can throw while Main starts.
    const tokenizer = createMainO200kTokenizer(resolver);
    expect(resolver).not.toHaveBeenCalled();
    expect(() => tokenizer.countTokens("x")).toThrow(MAIN_TOKENIZER_NOT_READY);

    await expect(tokenizer.ensureReady()).rejects.toThrow(
      "resourcesPath is missing",
    );
    expect(readFileMock).not.toHaveBeenCalled();
    expect(() => tokenizer.countTokens("x")).toThrow(MAIN_TOKENIZER_NOT_READY);

    resolverFails = false;
    await expect(tokenizer.ensureReady()).resolves.toBeUndefined();
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(tokenizer.countTokens("hello world")).toBeGreaterThan(0);
  });

  it("keeps the per-code-point tokenizer out of the production path", () => {
    const source = readFileSync(
      new URL("./o200kTokenizer.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("tokenizer.testSupport");
    expect(source).not.toContain("createPerCodePointTokenizer");
  });
});
