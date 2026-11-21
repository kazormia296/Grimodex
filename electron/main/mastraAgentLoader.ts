/**
 * The lazy loader of the Mastra agent runtime (MP-3c, DR-MP3-17).
 *
 * The runtime is the third bundle, `dist-electron/mastra-agent.cjs`, which
 * holds `@mastra/*`; main.cjs never does. This file reads it with a `require`
 * whose argument is a variable, so that esbuild leaves it alone: a literal
 * would be bundled into main.cjs, and `mastra-ee-check.mjs --dist` would fail.
 * It is the only place outside `electron/main/mastra/` that names the bundle
 * (`mastraWorkspaceDisabled.static.test.ts` holds that).
 *
 * - Gate: a closed gate never loads. `load()` refuses before it touches the
 *   environment or the file.
 * - Environment: the pin is applied once, immediately before the load
 *   (`applyMastraEnvPin`, DR-MP3-9): removed names are gone and the two pinned
 *   values are set. Child processes get the copy taken before it
 *   (`mastraOriginalEnv`, wired in 3a). Nothing calls `apply` before this.
 * - Single-flight: callers that arrive while a load is in progress share it.
 *   A success is kept for the life of the process. A failure is not cached
 *   and is not retried here: the next call tries once, as a new load.
 * - Telemetry stays off by the pin; the runtime gets an injected logger.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { applyMastraEnvPin } from "./mastraEnv.js";
import type { MastraAgentRuntimeModule } from "./mastra/agentRuntime.js";

/** The third bundle's file name, next to main.cjs. */
const BUNDLE_FILE = "mastra-agent.cjs";

export type { MastraAgentRuntimeModule };

export class MastraAgentLoadError extends Error {
  readonly code: "gate-closed" | "load-failed" | "invalid-module";
  constructor(
    code: "gate-closed" | "load-failed" | "invalid-module",
    message: string,
  ) {
    super(message);
    this.name = "MastraAgentLoadError";
    this.code = code;
  }
}

export interface MastraAgentLoaderOptions {
  /** Whether the journey seam opened the gate. Read at every `load()`. */
  readonly isOpen: () => boolean;
  /** The env pin; the product passes `applyMastraEnvPin`. */
  readonly applyEnv?: () => unknown;
  /** Reads a module by absolute file name. The product uses a real `require`. */
  readonly requireModule?: (file: string) => unknown;
  /** The directory of main.cjs, which holds the third bundle. */
  readonly bundleDir?: string;
}

export interface MastraAgentLoader {
  /** The runtime module, loaded once. Rejects with `MastraAgentLoadError`. */
  load(): Promise<MastraAgentRuntimeModule>;
  /** Whether a load succeeded. */
  readonly loaded: boolean;
}

function isRuntimeModule(value: unknown): value is MastraAgentRuntimeModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createMastraAgentRuntime?: unknown })
      .createMastraAgentRuntime === "function"
  );
}

export function createMastraAgentLoader(
  options: MastraAgentLoaderOptions,
): MastraAgentLoader {
  let runtimeModule: MastraAgentRuntimeModule | null = null;
  let inFlight: Promise<MastraAgentRuntimeModule> | null = null;

  const doLoad = async (): Promise<MastraAgentRuntimeModule> => {
    // Yield once, so callers that arrive in the same turn share this load.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!options.isOpen()) {
      throw new MastraAgentLoadError(
        "gate-closed",
        "the Mastra gate is closed",
      );
    }
    try {
      // Immediately before the load, never earlier (DR-MP3-9, DR-MP3-16).
      (options.applyEnv ?? applyMastraEnvPin)();
      const file = path.join(options.bundleDir ?? __dirname, BUNDLE_FILE);
      const read =
        options.requireModule ??
        ((target: string): unknown => createRequire(__filename)(target));
      const loadedModule = read(file);
      if (!isRuntimeModule(loadedModule)) {
        throw new MastraAgentLoadError(
          "invalid-module",
          "the Mastra runtime module has no createMastraAgentRuntime",
        );
      }
      runtimeModule = loadedModule;
      return loadedModule;
    } catch (error) {
      if (error instanceof MastraAgentLoadError) throw error;
      // The cause is a file or parse error of Main's own bundle: no request
      // text or key can be in it. Only its message crosses.
      throw new MastraAgentLoadError(
        "load-failed",
        `the Mastra runtime could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  return {
    get loaded() {
      return runtimeModule !== null;
    },
    load() {
      if (runtimeModule !== null) return Promise.resolve(runtimeModule);
      if (inFlight !== null) return inFlight;
      const attempt = doLoad().finally(() => {
        // A success is kept in `runtimeModule`; a failure leaves nothing.
        if (inFlight === attempt) inFlight = null;
      });
      inFlight = attempt;
      return attempt;
    },
  };
}
