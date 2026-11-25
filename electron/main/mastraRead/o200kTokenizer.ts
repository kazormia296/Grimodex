import { readFile } from "node:fs/promises";
import path from "node:path";

import { init, Tiktoken } from "tiktoken/lite/init";

import type { CoreTokenizer } from "../../shared/mastraRead/tokenizer.js";

export const MAIN_TOKENIZER_NOT_READY = "MASTRA_TOKENIZER_NOT_READY";

export interface MainTokenizerAssetPaths {
  readonly ranksPath: string;
  readonly wasmPath: string;
}

export interface MainTokenizerRuntimePaths {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  /** The directory containing the main bundle (dist-electron in development). */
  readonly mainDir: string;
}

interface O200kEncoding {
  readonly bpe_ranks: string;
  readonly special_tokens: Record<string, number>;
  readonly pat_str: string;
}

type WebAssemblyInstantiate = Parameters<typeof init>[0];
type WebAssemblyRuntime = {
  instantiate(
    bytes: Uint8Array,
    imports: Parameters<WebAssemblyInstantiate>[0],
  ): ReturnType<WebAssemblyInstantiate>;
};

export function resolveMainTokenizerAssetPaths({
  isPackaged,
  resourcesPath,
  mainDir,
}: MainTokenizerRuntimePaths): MainTokenizerAssetPaths {
  if (isPackaged) {
    const tokenizerDir = path.join(resourcesPath, "resources", "tokenizer");
    return {
      ranksPath: path.join(tokenizerDir, "o200k_base.json"),
      wasmPath: path.join(tokenizerDir, "tiktoken_bg.wasm"),
    };
  }

  const packageDir = path.resolve(mainDir, "..", "node_modules", "tiktoken");
  return {
    ranksPath: path.join(packageDir, "encoders", "o200k_base.json"),
    wasmPath: path.join(packageDir, "lite", "tiktoken_bg.wasm"),
  };
}

/**
 * `assets` may be a function: it then runs inside `ensureReady()`, so a failure to resolve the paths
 * (for example a missing `resourcesPath`) is a rejected `ensureReady()` (the owner refuses `unsupported`)
 * and not an error while Main starts. It runs again on a retry.
 */
export function createMainO200kTokenizer(
  assets: MainTokenizerAssetPaths | (() => MainTokenizerAssetPaths),
): CoreTokenizer {
  let encoder: Tiktoken | null = null;
  let initializing: Promise<void> | null = null;

  return {
    kind: "o200k_base",
    ensureReady() {
      if (encoder) return Promise.resolve();
      if (!initializing) {
        initializing = Promise.resolve()
          .then(async () => {
            const paths = typeof assets === "function" ? assets() : assets;
            const [ranksBytes, wasmBytes] = await Promise.all([
              readFile(paths.ranksPath),
              readFile(paths.wasmPath),
            ]);
            const ranks = JSON.parse(
              ranksBytes.toString("utf8"),
            ) as O200kEncoding;
            await init((imports) =>
              (
                globalThis as unknown as { WebAssembly: WebAssemblyRuntime }
              ).WebAssembly.instantiate(wasmBytes, imports),
            );
            encoder = new Tiktoken(
              ranks.bpe_ranks,
              ranks.special_tokens,
              ranks.pat_str,
            );
          })
          .finally(() => {
            initializing = null;
          });
      }
      return initializing;
    },
    countTokens(text) {
      if (!encoder) throw new Error(MAIN_TOKENIZER_NOT_READY);
      if (!text) return 0;
      return encoder.encode(text).length;
    },
  };
}
