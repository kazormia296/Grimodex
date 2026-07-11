import { describe, expect, it, vi } from "vitest";

import {
  dispatchInvoke,
  IPC_BACKEND_UNAVAILABLE_MARKER,
} from "./ipcContract.js";
import type { NapiBackendLike } from "./ipcContract.js";

describe("Phase 3 Batch 5 IPC contract", () => {
  it("maps seed_sample_workspace to the shared native core", async () => {
    const seedSampleWorkspace = vi.fn(async () =>
      JSON.stringify({
        path: "/app-data/sample-workspace-11111111-1111-1111-1111-111111111111",
        projectId: "default-project",
      }),
    );
    const result = await dispatchInvoke(
      "seed_sample_workspace",
      { language: "en", aiPolicy: '{"preset":"full"}' },
      {
        backend: { seedSampleWorkspace } as unknown as NapiBackendLike,
        shell: {},
      },
    );

    expect(seedSampleWorkspace).toHaveBeenCalledExactlyOnceWith(
      "en",
      '{"preset":"full"}',
    );
    expect(result).toEqual({
      ok: true,
      value: {
        path: "/app-data/sample-workspace-11111111-1111-1111-1111-111111111111",
        projectId: "default-project",
      },
    });
  });

  it("fails explicitly with an old native binding", async () => {
    const result = await dispatchInvoke(
      "seed_sample_workspace",
      { language: "ja", aiPolicy: "{}" },
      { backend: {} as NapiBackendLike, shell: {} },
    );

    expect(result).toEqual({
      ok: false,
      error: `${IPC_BACKEND_UNAVAILABLE_MARKER} native method seedSampleWorkspace`,
    });
  });

  it("validates both required seed arguments before native execution", async () => {
    const seedSampleWorkspace = vi.fn(async () => "null");
    for (const args of [
      { language: null, aiPolicy: "{}" },
      { language: "ja", aiPolicy: undefined },
    ]) {
      const result = await dispatchInvoke("seed_sample_workspace", args, {
        backend: { seedSampleWorkspace } as unknown as NapiBackendLike,
        shell: {},
      });
      expect(result.ok).toBe(false);
    }
    expect(seedSampleWorkspace).not.toHaveBeenCalled();
  });
});
