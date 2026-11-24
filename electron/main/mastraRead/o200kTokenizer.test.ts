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

    expect(
      module.resolveMainTokenizerAssetPaths({
        isPackaged: true,
        resourcesPath: "/app/Contents/Resources",
        mainDir: "/unused",
      }),
    ).toEqual({
      ranksPath: "/app/Contents/Resources/resources/tokenizer/o200k_base.json",
      wasmPath: "/app/Contents/Resources/resources/tokenizer/tiktoken_bg.wasm",
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

  it("keeps the per-code-point tokenizer out of the production path", () => {
    const source = readFileSync(
      new URL("./o200kTokenizer.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("tokenizer.testSupport");
    expect(source).not.toContain("createPerCodePointTokenizer");
  });
});
